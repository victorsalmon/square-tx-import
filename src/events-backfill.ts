/**
 * Missed-delivery repair via the Events API (`SearchEvents` loop).
 *
 * When a webhook delivery is missed (outage, 5xx, expired subscription), the
 * importer replays the gap: search events in the window with seller/location/
 * `created_at` filters, follow `cursor`, then **re-fetch the canonical
 * order/payment by ID and reconcile** — never booking from the event payload
 * alone (event `data.object` snapshots are point-in-time and may be stale,
 * partial, or duplicated).
 *
 * Retention: the Events API only searches the trailing **28 days**. The cap is
 * enforced in code — {@link collectBackfillEvents} throws
 * {@link EventsRetentionError} when the window starts earlier than 28 days
 * ago or spans more than 28 days. Older gaps must be repaired with a
 * poll-primary re-import (`poll.ts`) over the raw Orders/Payments APIs, which
 * have no such cap.
 *
 * Auth note: the Events API requires the **application personal access
 * token** — per-seller OAuth tokens are rejected. Seller OAuth grants
 * (`PAYMENTS_READ` + `ORDERS_READ` + `PAYOUTS_READ`) still gate *visibility*:
 * only events for sellers that granted the app are searchable. See
 * `docs/EVENTS-BACKFILL.md`.
 */

import {
  fromOrderWithPayments,
  fromPaymentOnly,
  isBookableOrder,
  isBookablePayment,
  isZeroValueRecord,
  successfulPaymentsOnly,
  type AdaptOptions,
  type SaleSkipReason,
} from './adapter.js';
import type { SalesRecord, SquareOrderRow, SquarePaymentRow } from './types.js';

/** Trailing retention of the Events API search index, in days. */
export const EVENTS_RETENTION_DAYS = 28;

/** Thrown when a backfill window exceeds the Events API retention cap. */
export class EventsRetentionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EventsRetentionError';
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Enforce the 28-day retention cap. Throws {@link EventsRetentionError} when
 * `startAt` is older than 28 days before `nowMs`, or when the window itself
 * spans more than 28 days.
 */
export function assertWithinRetention(
  startAt: string,
  endAt?: string,
  nowMs: number = Date.now()
): void {
  const start = Date.parse(startAt);
  if (!Number.isFinite(start)) throw new EventsRetentionError(`Unparseable startAt: ${startAt}`);
  const end = endAt === undefined ? nowMs : Date.parse(endAt);
  if (!Number.isFinite(end)) throw new EventsRetentionError(`Unparseable endAt: ${endAt}`);
  if (end < start) throw new EventsRetentionError(`endAt ${endAt} precedes startAt ${startAt}`);
  if (nowMs - start > EVENTS_RETENTION_DAYS * DAY_MS) {
    throw new EventsRetentionError(
      `startAt ${startAt} is older than the ${EVENTS_RETENTION_DAYS}-day Events API retention window; ` +
        `repair older gaps with a poll-primary re-import (poll.ts).`
    );
  }
  if (end - start > EVENTS_RETENTION_DAYS * DAY_MS) {
    throw new EventsRetentionError(
      `Window ${startAt}..${endAt ?? '(now)'} spans more than ${EVENTS_RETENTION_DAYS} days; ` +
        `split it into <=${EVENTS_RETENTION_DAYS}-day chunks.`
    );
  }
}

/** One normalized search hit. `entityId` is the canonical id to re-fetch. */
export interface BackfillEvent {
  eventId: string;
  type: string;
  merchantId?: string;
  locationId?: string;
  createdAt?: string;
  /** Canonical entity kind: `order` | `payment` | `payout` | `unknown`. */
  entityKind: 'order' | 'payment' | 'payout' | 'unknown';
  /** Canonical entity id to re-fetch; null when the event maps to nothing. */
  entityId: string | null;
  raw: unknown;
}

/** Minimal `SearchEvents` port (wrap `client.events.searchEvents`). */
export interface EventsSearchPort {
  searchEvents(args: {
    locationIds?: string[];
    merchantIds?: string[];
    eventTypes?: string[];
    startAt: string;
    endAt?: string;
    cursor?: string;
    limit?: number;
  }): Promise<{ events: BackfillEvent[]; cursor?: string }>;
}

/** Sales-relevant event types worth replaying during a backfill. */
export const BACKFILL_EVENT_TYPES = [
  'payment.updated',
  'refund.updated',
  'payout.updated',
  'order.updated',
] as const;

/**
 * Collect every backfill event in the window, following `cursor` pages.
 * The retention cap is enforced before the first request.
 */
export async function collectBackfillEvents(
  port: EventsSearchPort,
  query: {
    locationIds?: string[];
    merchantIds?: string[];
    eventTypes?: string[];
    startAt: string;
    endAt?: string;
    limit?: number;
    nowMs?: number;
  }
): Promise<BackfillEvent[]> {
  assertWithinRetention(query.startAt, query.endAt, query.nowMs ?? Date.now());
  const out: BackfillEvent[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await port.searchEvents({
      locationIds: query.locationIds,
      merchantIds: query.merchantIds,
      eventTypes: query.eventTypes ?? [...BACKFILL_EVENT_TYPES],
      startAt: query.startAt,
      endAt: query.endAt,
      cursor,
      limit: query.limit,
    });
    out.push(...page.events);
    if (!page.cursor) break;
    cursor = page.cursor;
  }
  return out;
}

/** Canonical fetchers used to re-resolve events to source-of-truth rows. */
export interface CanonicalFetchers {
  getOrder(orderId: string): Promise<SquareOrderRow | null>;
  getPayment(paymentId: string): Promise<SquarePaymentRow | null>;
}

export interface BackfillResult {
  records: SalesRecord[];
  /** Events that produced no record (unknown kind, missing entity, gone). */
  skipped: Array<{ eventId: string; reason: string }>;
  /** Counted outcome, including the booking-gate skips. */
  counts: {
    booked: number;
    skipped: number;
    zeroValueSkipped: number;
    unpaidOrderSkipped: number;
    failedPaymentSkipped: number;
  };
}

/** Booking-gate skip reasons that carry a `SaleSkipReason` (vs. plumbing). */
function tallySkipReason(reason: string): SaleSkipReason | null {
  if (reason === 'zero-value' || reason === 'unpaid-order' || reason === 'failed-payment') {
    return reason;
  }
  return null;
}

/**
 * Turn backfill events into records via canonical re-fetch.
 *
 * For each event the canonical order/payment is fetched by ID and adapted
 * with its linked payments (order path) or payment-only (payment path);
 * the event payload itself is never booked. Refund events resolve through
 * `getPayment` (the caller maps refund → parent payment id). Payout events
 * are reported as skipped with reason `payout-requires-entries` — payouts
 * reconcile via `ListPayoutEntries` (`poll.ts` + `adapter.ts`), not via a
 * single row. Dedupes by `externalId`.
 *
 * Booking gates (see `docs/BOOKABLE-MATRIX.md`):
 * - A payment event books ONLY when the canonical payment is successful
 *   (`failed-payment` skip otherwise — failed payments never book).
 * - An order event books ONLY with a linked successful payment, evaluated
 *   through `opts.getOrderPayments` when provided (`unpaid-order` skip
 *   otherwise; failed linked payments never contribute fees/refunds). When
 *   `getOrderPayments` is absent the linkage is unknown and the order books
 *   — pass it for full paid-gate enforcement.
 * - An adapted record with no money at all is skipped as `zero-value`.
 */
export async function backfillSalesFromEvents(
  events: BackfillEvent[],
  fetchers: CanonicalFetchers,
  opts?: AdaptOptions & { getOrderPayments?: (orderId: string) => Promise<SquarePaymentRow[]> }
): Promise<BackfillResult> {
  const records: SalesRecord[] = [];
  const skipped: BackfillResult['skipped'] = [];
  const seen = new Set<string>();
  const counts: BackfillResult['counts'] = {
    booked: 0,
    skipped: 0,
    zeroValueSkipped: 0,
    unpaidOrderSkipped: 0,
    failedPaymentSkipped: 0,
  };
  const skip = (eventId: string, reason: string): void => {
    skipped.push({ eventId, reason });
    counts.skipped += 1;
    const gate = tallySkipReason(reason);
    if (gate === 'zero-value') counts.zeroValueSkipped += 1;
    else if (gate === 'unpaid-order') counts.unpaidOrderSkipped += 1;
    else if (gate === 'failed-payment') counts.failedPaymentSkipped += 1;
  };
  const book = (record: SalesRecord, eventId: string): void => {
    if (seen.has(record.externalId)) return;
    if (isZeroValueRecord(record)) {
      seen.add(record.externalId);
      skip(eventId, 'zero-value');
      return;
    }
    seen.add(record.externalId);
    records.push(record);
    counts.booked += 1;
  };

  for (const event of events) {
    if (!event.entityId) {
      skip(event.eventId, 'no-entity-id');
      continue;
    }
    if (event.entityKind === 'unknown') {
      skip(event.eventId, 'unknown-entity-kind');
      continue;
    }
    if (event.entityKind === 'payout') {
      skip(event.eventId, 'payout-requires-entries');
      continue;
    }
    try {
      const record =
        event.entityKind === 'order'
          ? await (async (): Promise<SalesRecord | null> => {
              const order = await fetchers.getOrder(event.entityId as string);
              if (!order) return null;
              if (!opts?.getOrderPayments) {
                return fromOrderWithPayments(order, [], opts);
              }
              const linked = await opts.getOrderPayments(event.entityId as string);
              if (!isBookableOrder(linked)) {
                skip(event.eventId, 'unpaid-order');
                return null;
              }
              return fromOrderWithPayments(order, successfulPaymentsOnly(linked), opts);
            })()
          : await (async (): Promise<SalesRecord | null> => {
              const payment = await fetchers.getPayment(event.entityId as string);
              if (!payment) return null;
              if (!isBookablePayment(payment)) {
                skip(event.eventId, 'failed-payment');
                return null;
              }
              return fromPaymentOnly(payment, opts);
            })();
      if (!record) {
        if (!skipped.some((s) => s.eventId === event.eventId)) {
          skip(event.eventId, 'canonical-row-missing');
        }
        continue;
      }
      book(record, event.eventId);
    } catch (err) {
      skip(event.eventId, `adapt-failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { records, skipped, counts };
}
