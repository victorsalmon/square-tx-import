/**
 * Poll-primary import: `SearchOrders` + `ListPayments` + `ListPayoutEntries`.
 *
 * Polling is the source of truth; webhooks are only a freshness signal and the
 * Events API only repairs missed deliveries. Every lister takes an injected
 * client interface (a thin wrapper over the `square@46` SDK — see
 * `examples/poll-import.mjs` for the mapping), so imports are unit-testable
 * without network access. All pagers follow `cursor` until the page omits it.
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
import type {
  SalesRecord,
  SquareOrderRow,
  SquarePaymentRow,
  SquarePayoutEntryRow,
} from './types.js';

/** Minimal `SearchOrders` port (wrap `client.orders.search`). */
export interface OrdersSearchPort {
  searchOrders(args: {
    locationIds: string[];
    startAt: string;
    endAt?: string;
    cursor?: string;
    limit?: number;
  }): Promise<{ orders: SquareOrderRow[]; cursor?: string }>;
  getOrder?(orderId: string): Promise<SquareOrderRow | null>;
}

/** Minimal `ListPayments` port (wrap `client.payments.list` / `.get`). */
export interface PaymentsListPort {
  listPayments(args: {
    locationIds?: string[];
    beginTime?: string;
    endTime?: string;
    cursor?: string;
    limit?: number;
  }): Promise<{ payments: SquarePaymentRow[]; cursor?: string }>;
  getPayment?(paymentId: string): Promise<SquarePaymentRow | null>;
}

/** Minimal `ListPayoutEntries` port (wrap `client.payouts.listEntries`). */
export interface PayoutEntriesPort {
  listPayoutEntries(args: {
    payoutId: string;
    cursor?: string;
    limit?: number;
  }): Promise<{ entries: SquarePayoutEntryRow[]; cursor?: string }>;
}

async function drainCursor<Page>(
  fetchPage: (cursor?: string) => Promise<{ cursor?: string } & Page>
): Promise<Page[]> {
  const pages: Page[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await fetchPage(cursor);
    pages.push(page);
    if (!page.cursor) break;
    cursor = page.cursor;
  }
  return pages;
}

/** List every order updated in the window, following `cursor` pages. */
export async function listAllOrders(
  port: OrdersSearchPort,
  query: { locationIds: string[]; startAt: string; endAt?: string; limit?: number }
): Promise<SquareOrderRow[]> {
  const pages = await drainCursor((cursor) =>
    port.searchOrders({ ...query, cursor })
  );
  return pages.flatMap((p) => p.orders);
}

/** List every payment created in the window, following `cursor` pages. */
export async function listAllPayments(
  port: PaymentsListPort,
  query: { locationIds?: string[]; beginTime?: string; endTime?: string; limit?: number }
): Promise<SquarePaymentRow[]> {
  const pages = await drainCursor((cursor) => port.listPayments({ ...query, cursor }));
  return pages.flatMap((p) => p.payments);
}

/** List every entry of one payout, following `cursor` pages. */
export async function listAllPayoutEntries(
  port: PayoutEntriesPort,
  payoutId: string,
  opts?: { limit?: number }
): Promise<SquarePayoutEntryRow[]> {
  const pages = await drainCursor((cursor) =>
    port.listPayoutEntries({ payoutId, cursor, limit: opts?.limit })
  );
  return pages.flatMap((p) => p.entries);
}

export interface SalesWindowQuery {
  locationIds: string[];
  startAt: string;
  endAt?: string;
  limit?: number;
}

/**
 * Import one window: fetch orders + payments, adapt each order with its linked
 * payments (grouped by `payment.orderId`), and adapt leftover payments
 * (no linked order row in this window) payment-only. Dedupes by `externalId`.
 *
 * Booking gates (see `docs/BOOKABLE-MATRIX.md`):
 * - An order books ONLY with at least one linked **successful** (`COMPLETED`,
 *   or absent-status) payment; failed/canceled/authorized-only payments never
 *   contribute fees/refunds to the order record.
 * - A leftover payment books payment-only ONLY when it is successful.
 * - An adapted record with no money at all (gross = tax = fee = refunded =
 *   net = 0) is skipped as `zero-value`.
 * Skipped rows are counted in the detailed result; {@link importSalesWindow}
 * returns the booked records only.
 */
export async function importSalesWindow(
  orders: OrdersSearchPort,
  payments: PaymentsListPort,
  query: SalesWindowQuery,
  opts?: AdaptOptions
): Promise<SalesRecord[]> {
  return (await importSalesWindowDetailed(orders, payments, query, opts)).records;
}

/** One skipped row in a window import. */
export interface SalesWindowSkipped {
  /** `order:<id>` or `payment:<id>` — the row that did not book. */
  externalId: string;
  reason: SaleSkipReason;
}

/** Counted outcome of a window import. */
export interface SalesWindowImportResult {
  records: SalesRecord[];
  skipped: SalesWindowSkipped[];
  stats: {
    booked: number;
    zeroValueSkipped: number;
    unpaidOrderSkipped: number;
    failedPaymentSkipped: number;
  };
}

/**
 * Window import with counted skips. Same booking behaviour as
 * {@link importSalesWindow}, plus the per-reason `skipped` list and `stats`
 * (notably `zeroValueSkipped`).
 */
export async function importSalesWindowDetailed(
  orders: OrdersSearchPort,
  payments: PaymentsListPort,
  query: SalesWindowQuery,
  opts?: AdaptOptions
): Promise<SalesWindowImportResult> {
  const [orderRows, paymentRows] = await Promise.all([
    listAllOrders(orders, {
      locationIds: query.locationIds,
      startAt: query.startAt,
      endAt: query.endAt,
      limit: query.limit,
    }),
    listAllPayments(payments, {
      locationIds: query.locationIds,
      beginTime: query.startAt,
      endTime: query.endAt,
      limit: query.limit,
    }),
  ]);

  const byOrderId = new Map<string, SquarePaymentRow[]>();
  const unlinked: SquarePaymentRow[] = [];
  for (const p of paymentRows) {
    if (p.orderId) {
      const group = byOrderId.get(p.orderId);
      if (group) group.push(p);
      else byOrderId.set(p.orderId, [p]);
    } else {
      unlinked.push(p);
    }
  }

  const records: SalesRecord[] = [];
  const skipped: SalesWindowSkipped[] = [];
  const seen = new Set<string>();
  const stats = { booked: 0, zeroValueSkipped: 0, unpaidOrderSkipped: 0, failedPaymentSkipped: 0 };
  const push = (r: SalesRecord): void => {
    if (seen.has(r.externalId)) return;
    if (isZeroValueRecord(r)) {
      seen.add(r.externalId);
      skipped.push({ externalId: r.externalId, reason: 'zero-value' });
      stats.zeroValueSkipped += 1;
      return;
    }
    seen.add(r.externalId);
    records.push(r);
    stats.booked += 1;
  };

  const knownOrderIds = new Set(orderRows.map((o) => o.id).filter((id): id is string => Boolean(id)));
  for (const order of orderRows) {
    if (!order.id) continue;
    const linked = byOrderId.get(order.id) ?? [];
    // Paid gate: an order books only with a linked successful payment.
    // Failed payments never contribute fees/refunds — adapt with the
    // successful subset only.
    if (!isBookableOrder(linked)) {
      const externalId = `order:${order.id}`;
      if (seen.has(externalId)) continue;
      seen.add(externalId);
      skipped.push({ externalId, reason: 'unpaid-order' });
      stats.unpaidOrderSkipped += 1;
      continue;
    }
    push(fromOrderWithPayments(order, successfulPaymentsOnly(linked), opts));
  }
  // Payments whose order row was not in this window (or is absent entirely)
  // still book — payment-only — so no sale is silently dropped, provided the
  // payment itself is successful.
  const pushPaymentOnly = (p: SquarePaymentRow): void => {
    if (!p.id) return;
    if (!isBookablePayment(p)) {
      const externalId = `payment:${p.id}`;
      if (seen.has(externalId)) return;
      seen.add(externalId);
      skipped.push({ externalId, reason: 'failed-payment' });
      stats.failedPaymentSkipped += 1;
      return;
    }
    push(fromPaymentOnly(p, opts));
  };
  for (const [orderId, group] of byOrderId) {
    if (knownOrderIds.has(orderId)) continue;
    for (const p of group) {
      pushPaymentOnly(p);
    }
  }
  for (const p of unlinked) {
    pushPaymentOnly(p);
  }
  return { records, skipped, stats };
}
