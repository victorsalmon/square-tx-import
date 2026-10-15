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

import { fromOrderWithPayments, fromPaymentOnly, type AdaptOptions } from './adapter.js';
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
 */
export async function backfillSalesFromEvents(
  events: BackfillEvent[],
  fetchers: CanonicalFetchers,
  opts?: AdaptOptions & { getOrderPayments?: (orderId: string) => Promise<SquarePaymentRow[]> }
): Promise<BackfillResult> {
  const records: SalesRecord[] = [];
  const skipped: BackfillResult['skipped'] = [];
  const seen = new Set<string>();

  for (const event of events) {
    if (!event.entityId) {
      skipped.push({ eventId: event.eventId, reason: 'no-entity-id' });
      continue;
    }
    if (event.entityKind === 'unknown') {
      skipped.push({ eventId: event.eventId, reason: 'unknown-entity-kind' });
      continue;
    }
    if (event.entityKind === 'payout') {
      skipped.push({ eventId: event.eventId, reason: 'payout-requires-entries' });
      continue;
    }
    try {
      const record =
        event.entityKind === 'order'
          ? await (async (): Promise<SalesRecord | null> => {
              const order = await fetchers.getOrder(event.entityId as string);
              if (!order) return null;
              const linked = opts?.getOrderPayments
                ? await opts.getOrderPayments(event.entityId as string)
                : [];
              return fromOrderWithPayments(order, linked, opts);
            })()
          : await (async (): Promise<SalesRecord | null> => {
              const payment = await fetchers.getPayment(event.entityId as string);
              if (!payment) return null;
              return fromPaymentOnly(payment, opts);
            })();
      if (!record) {
        skipped.push({ eventId: event.eventId, reason: 'canonical-row-missing' });
        continue;
      }
      if (seen.has(record.externalId)) continue;
      seen.add(record.externalId);
      records.push(record);
    } catch (err) {
      skipped.push({
        eventId: event.eventId,
        reason: `adapt-failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
  return { records, skipped };
}
