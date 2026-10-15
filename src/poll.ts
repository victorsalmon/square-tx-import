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
  type AdaptOptions,
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
 * Only orders with a usable date (`closed_at`, else `created_at`) are booked;
 * open orders outside the window surface as payment-only rows when their
 * payments fall inside it — the `externalId` scheme keeps both sides deduped
 * on re-import.
 */
export async function importSalesWindow(
  orders: OrdersSearchPort,
  payments: PaymentsListPort,
  query: SalesWindowQuery,
  opts?: AdaptOptions
): Promise<SalesRecord[]> {
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
  const seen = new Set<string>();
  const push = (r: SalesRecord): void => {
    if (seen.has(r.externalId)) return;
    seen.add(r.externalId);
    records.push(r);
  };

  const knownOrderIds = new Set(orderRows.map((o) => o.id).filter((id): id is string => Boolean(id)));
  for (const order of orderRows) {
    if (!order.id) continue;
    push(fromOrderWithPayments(order, byOrderId.get(order.id) ?? [], opts));
  }
  // Payments whose order row was not in this window (or is absent entirely)
  // still book — payment-only — so no sale is silently dropped.
  for (const [orderId, group] of byOrderId) {
    if (knownOrderIds.has(orderId)) continue;
    for (const p of group) {
      if (!p.id) continue;
      push(fromPaymentOnly(p, opts));
    }
  }
  for (const p of unlinked) {
    if (!p.id) continue;
    push(fromPaymentOnly(p, opts));
  }
  return records;
}
