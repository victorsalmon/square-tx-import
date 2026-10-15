import { describe, it, expect } from 'vitest';
import {
  importSalesWindow,
  listAllOrders,
  listAllPayoutEntries,
  listAllPayments,
} from '../src/index.js';
import type {
  OrdersSearchPort,
  PaymentsListPort,
  PayoutEntriesPort,
  SquareOrderRow,
  SquarePaymentRow,
  SquarePayoutEntryRow,
} from '../src/index.js';

function pageOf<T>(items: T[][], cursor?: string): { items: T[]; cursor?: string } {
  const idx = cursor === undefined ? 0 : Number(cursor);
  const next = idx + 1;
  return { items: items[idx] ?? [], cursor: next < items.length ? String(next) : undefined };
}

function ordersPort(pages: SquareOrderRow[][]): OrdersSearchPort {
  return {
    searchOrders: async ({ cursor }) => {
      const { items, cursor: next } = pageOf(pages, cursor);
      return { orders: items, cursor: next };
    },
  };
}

function paymentsPort(pages: SquarePaymentRow[][]): PaymentsListPort {
  return {
    listPayments: async ({ cursor }) => {
      const { items, cursor: next } = pageOf(pages, cursor);
      return { payments: items, cursor: next };
    },
  };
}

function entriesPort(pages: SquarePayoutEntryRow[][]): PayoutEntriesPort {
  return {
    listPayoutEntries: async ({ cursor }) => {
      const { items, cursor: next } = pageOf(pages, cursor);
      return { entries: items, cursor: next };
    },
  };
}

describe('cursor pagination', () => {
  it('listAllOrders follows cursor across pages', async () => {
    const pages: SquareOrderRow[][] = [
      [{ id: 'o1' }, { id: 'o2' }],
      [{ id: 'o3' }],
      [],
    ];
    const port = ordersPort(pages);
    const orders = await listAllOrders(port, { locationIds: ['l1'], startAt: '2026-10-01T00:00:00Z' });
    expect(orders.map((o) => o.id)).toEqual(['o1', 'o2', 'o3']);
  });

  it('listAllPayments follows cursor across pages', async () => {
    const pages: SquarePaymentRow[][] = [[{ id: 'p1' }], [{ id: 'p2' }, { id: 'p3' }]];
    const port = paymentsPort(pages);
    const payments = await listAllPayments(port, { beginTime: '2026-10-01T00:00:00Z' });
    expect(payments.map((p) => p.id)).toEqual(['p1', 'p2', 'p3']);
  });

  it('listAllPayoutEntries follows cursor across pages', async () => {
    const pages: SquarePayoutEntryRow[][] = [
      [{ id: 'e1', payoutId: 'po-1' }],
      [{ id: 'e2', payoutId: 'po-1' }],
    ];
    const port = entriesPort(pages);
    const entries = await listAllPayoutEntries(port, 'po-1');
    expect(entries.map((e) => e.id)).toEqual(['e1', 'e2']);
  });
});

describe('importSalesWindow', () => {
  const order: SquareOrderRow = {
    id: 'ord-1',
    locationId: 'loc-1',
    state: 'COMPLETED',
    closedAt: '2026-10-14T10:05:00Z',
    totalMoney: { amount: 1130, currency: 'CAD' },
    totalTaxMoney: { amount: 130, currency: 'CAD' },
  };
  const linked: SquarePaymentRow = {
    id: 'pay-1',
    orderId: 'ord-1',
    createdAt: '2026-10-14T10:05:00Z',
    totalMoney: { amount: 1130, currency: 'CAD' },
    processingFee: [{ type: 'INITIAL', amountMoney: { amount: 33, currency: 'CAD' } }],
  };
  const orphan: SquarePaymentRow = {
    id: 'pay-9',
    createdAt: '2026-10-13T09:00:00Z',
    totalMoney: { amount: 500, currency: 'CAD' },
  };
  const ghostLinked: SquarePaymentRow = {
    id: 'pay-8',
    orderId: 'ord-missing',
    createdAt: '2026-10-13T09:30:00Z',
    totalMoney: { amount: 700, currency: 'CAD' },
  };

  it('prefers order-linked rows and books leftovers payment-only, deduped', async () => {
    const ordersPort = { searchOrders: async () => ({ orders: [order], cursor: undefined }) };
    const paymentsPort = {
      listPayments: async () => ({ payments: [linked, orphan, ghostLinked], cursor: undefined }),
    };
    const records = await importSalesWindow(ordersPort, paymentsPort, {
      locationIds: ['loc-1'],
      startAt: '2026-10-13T00:00:00Z',
    });
    expect(records.map((r) => r.externalId).sort()).toEqual([
      'order:ord-1',
      'payment:pay-8',
      'payment:pay-9',
    ]);
    expect(records.find((r) => r.externalId === 'order:ord-1')?.feeCents).toBe(33);
  });

  it('dedupes repeat imports by externalId', async () => {
    const ordersPort = {
      searchOrders: async () => ({ orders: [order, order], cursor: undefined }),
    };
    const paymentsPort = { listPayments: async () => ({ payments: [], cursor: undefined }) };
    const records = await importSalesWindow(ordersPort, paymentsPort, {
      locationIds: ['loc-1'],
      startAt: '2026-10-14T00:00:00Z',
    });
    expect(records).toHaveLength(1);
  });
});
