import { describe, it, expect } from 'vitest';
import {
  backfillSalesFromEvents,
  importSalesWindowDetailed,
  isBookableOrder,
  isBookablePayment,
  isSuccessfulPayment,
  isZeroValueRecord,
} from '../src/index.js';
import type { SquareOrderRow, SquarePaymentRow } from '../src/index.js';

// Regression fixtures for the SI-B2 booking gates (see
// docs/BOOKABLE-MATRIX.md): the all-zero skip and the paid/closed gate.

const successful = (over: Partial<SquarePaymentRow> = {}): SquarePaymentRow => ({
  id: 'pay-ok',
  createdAt: '2026-10-14T10:05:00Z',
  status: 'COMPLETED',
  totalMoney: { amount: 1130, currency: 'CAD' },
  processingFee: [{ type: 'INITIAL', amountMoney: { amount: 33, currency: 'CAD' } }],
  ...over,
});

const failed = (over: Partial<SquarePaymentRow> = {}): SquarePaymentRow => ({
  id: 'pay-bad',
  createdAt: '2026-10-14T10:05:00Z',
  status: 'FAILED',
  totalMoney: { amount: 1130, currency: 'CAD' },
  processingFee: [{ type: 'INITIAL', amountMoney: { amount: 33, currency: 'CAD' } }],
  ...over,
});

const orderOf = (over: Partial<SquareOrderRow> = {}): SquareOrderRow => ({
  id: 'ord-1',
  locationId: 'loc-1',
  state: 'COMPLETED',
  closedAt: '2026-10-14T10:05:00Z',
  totalMoney: { amount: 1130, currency: 'CAD' },
  totalTaxMoney: { amount: 130, currency: 'CAD' },
  ...over,
});

const ports = (orders: SquareOrderRow[], payments: SquarePaymentRow[]) => ({
  ordersPort: { searchOrders: async () => ({ orders, cursor: undefined }) },
  paymentsPort: { listPayments: async () => ({ payments, cursor: undefined }) },
});

const query = { locationIds: ['loc-1'], startAt: '2026-10-13T00:00:00Z' };

describe('paid/closed gate predicates', () => {
  it('COMPLETED and absent-status payments are successful; FAILED/CANCELED/APPROVED are not', () => {
    expect(isSuccessfulPayment(successful())).toBe(true);
    expect(isSuccessfulPayment(successful({ status: 'completed' }))).toBe(true);
    expect(isSuccessfulPayment(successful({ status: null }))).toBe(true);
    expect(isSuccessfulPayment(successful({ status: undefined }))).toBe(true);
    expect(isSuccessfulPayment(failed())).toBe(false);
    expect(isSuccessfulPayment(failed({ status: 'CANCELED' }))).toBe(false);
    expect(isSuccessfulPayment(failed({ status: 'CANCELLED' }))).toBe(false);
    expect(isSuccessfulPayment(failed({ status: 'APPROVED' }))).toBe(false);
  });

  it('an order is bookable only with a linked successful payment', () => {
    expect(isBookableOrder([successful()])).toBe(true);
    expect(isBookableOrder([failed(), successful()])).toBe(true);
    expect(isBookableOrder([])).toBe(false);
    expect(isBookableOrder([failed()])).toBe(false);
    expect(isBookablePayment(successful())).toBe(true);
    expect(isBookablePayment(failed())).toBe(false);
  });

  it('all-zero means every leg is zero; any refund keeps the row bookable', () => {
    expect(
      isZeroValueRecord({
        externalId: 'x',
        date: '2026-10-14T00:00:00Z',
        grossCents: 0,
        taxCents: 0,
        feeCents: 0,
        refundedCents: 0,
        netCents: 0,
        currency: 'CAD',
        provider: 'square',
        rawJson: {},
      })
    ).toBe(true);
    // Fully-refunded sale: refund linkage, not zero-value.
    expect(
      isZeroValueRecord({
        externalId: 'x',
        date: '2026-10-14T00:00:00Z',
        grossCents: 1000,
        taxCents: 130,
        feeCents: 33,
        refundedCents: 1130,
        netCents: -33,
        currency: 'CAD',
        provider: 'square',
        rawJson: {},
      })
    ).toBe(false);
  });
});

describe('importSalesWindowDetailed booking gates', () => {
  it('skips an all-zero order with a counted zero-value skip', async () => {
    const zeroOrder = orderOf({
      totalMoney: { amount: 0, currency: 'CAD' },
      totalTaxMoney: { amount: 0, currency: 'CAD' },
    });
    const zeroPay = successful({
      id: 'pay-zero',
      orderId: 'ord-1',
      totalMoney: { amount: 0, currency: 'CAD' },
      refundedMoney: { amount: 0, currency: 'CAD' },
      processingFee: [],
    });
    const { ordersPort, paymentsPort } = ports([zeroOrder], [zeroPay]);
    const res = await importSalesWindowDetailed(ordersPort, paymentsPort, query);
    expect(res.records).toHaveLength(0);
    expect(res.stats.zeroValueSkipped).toBe(1);
    expect(res.skipped).toEqual([{ externalId: 'order:ord-1', reason: 'zero-value' }]);
  });

  it('skips an all-zero payment-only row with a counted zero-value skip', async () => {
    const zeroPay = successful({
      id: 'pay-zero',
      orderId: undefined,
      totalMoney: { amount: 0, currency: 'CAD' },
      refundedMoney: { amount: 0, currency: 'CAD' },
      processingFee: [],
    });
    const { ordersPort, paymentsPort } = ports([], [zeroPay]);
    const res = await importSalesWindowDetailed(ordersPort, paymentsPort, query);
    expect(res.records).toHaveLength(0);
    expect(res.stats.zeroValueSkipped).toBe(1);
    expect(res.skipped).toEqual([{ externalId: 'payment:pay-zero', reason: 'zero-value' }]);
  });

  it('still books a fully-refunded sale (refund linkage, not zero-value)', async () => {
    const refundedPay = successful({
      id: 'pay-r',
      orderId: 'ord-1',
      refundedMoney: { amount: 1130, currency: 'CAD' },
    });
    const { ordersPort, paymentsPort } = ports([orderOf()], [refundedPay]);
    const res = await importSalesWindowDetailed(ordersPort, paymentsPort, query);
    expect(res.records).toHaveLength(1);
    expect(res.records[0]?.refundedCents).toBe(1130);
    expect(res.stats.zeroValueSkipped).toBe(0);
  });

  it('excludes an order whose only linked payment failed (unpaid-order)', async () => {
    const bad = failed({ id: 'pay-bad', orderId: 'ord-1' });
    const { ordersPort, paymentsPort } = ports([orderOf()], [bad]);
    const res = await importSalesWindowDetailed(ordersPort, paymentsPort, query);
    expect(res.records).toHaveLength(0);
    expect(res.stats.unpaidOrderSkipped).toBe(1);
    expect(res.skipped).toEqual([{ externalId: 'order:ord-1', reason: 'unpaid-order' }]);
  });

  it('excludes an order with no linked payments at all (unpaid-order)', async () => {
    const other = successful({ id: 'pay-other', orderId: undefined });
    const { ordersPort, paymentsPort } = ports([orderOf()], [other]);
    const res = await importSalesWindowDetailed(ordersPort, paymentsPort, query);
    expect(res.records.map((r) => r.externalId)).toEqual(['payment:pay-other']);
    expect(res.stats.unpaidOrderSkipped).toBe(1);
  });

  it('never books a failed payment-only row (failed-payment)', async () => {
    const bad = failed({ id: 'pay-bad', orderId: undefined });
    const { ordersPort, paymentsPort } = ports([], [bad, successful({ id: 'pay-ok', orderId: undefined })]);
    const res = await importSalesWindowDetailed(ordersPort, paymentsPort, query);
    expect(res.records.map((r) => r.externalId)).toEqual(['payment:pay-ok']);
    expect(res.stats.failedPaymentSkipped).toBe(1);
    expect(res.skipped).toEqual([{ externalId: 'payment:pay-bad', reason: 'failed-payment' }]);
  });

  it('books a mixed order from the successful subset only (failed fee excluded)', async () => {
    const good = successful({ id: 'pay-ok', orderId: 'ord-1' }); // fee 33
    const bad = failed({ id: 'pay-bad', orderId: 'ord-1' }); // fee 33, must not count
    const { ordersPort, paymentsPort } = ports([orderOf()], [good, bad]);
    const res = await importSalesWindowDetailed(ordersPort, paymentsPort, query);
    expect(res.records).toHaveLength(1);
    expect(res.records[0]?.externalId).toBe('order:ord-1');
    expect(res.records[0]?.feeCents).toBe(33);
    expect(res.stats.failedPaymentSkipped).toBe(0);
    expect(res.stats.unpaidOrderSkipped).toBe(0);
  });
});

describe('backfillSalesFromEvents booking gates', () => {
  const orderFetchers = {
    getOrder: async (id: string) => (id === 'ord-1' ? orderOf() : null),
    getPayment: async () => null,
  };

  it('skips a zero-value canonical payment with counts', async () => {
    const fetchers = {
      getOrder: async () => null,
      getPayment: async () => successful({ id: 'pay-zero', totalMoney: { amount: 0 }, refundedMoney: { amount: 0 }, processingFee: [] }),
    };
    const res = await backfillSalesFromEvents(
      [{ eventId: 'e1', type: 'payment.updated', entityKind: 'payment', entityId: 'pay-zero', raw: {} }],
      fetchers
    );
    expect(res.records).toHaveLength(0);
    expect(res.counts.zeroValueSkipped).toBe(1);
  });

  it('never books a failed canonical payment', async () => {
    const fetchers = {
      getOrder: async () => null,
      getPayment: async () => failed({ id: 'pay-bad' }),
    };
    const res = await backfillSalesFromEvents(
      [{ eventId: 'e1', type: 'payment.updated', entityKind: 'payment', entityId: 'pay-bad', raw: {} }],
      fetchers
    );
    expect(res.records).toHaveLength(0);
    expect(res.counts.failedPaymentSkipped).toBe(1);
    expect(res.skipped).toEqual([{ eventId: 'e1', reason: 'failed-payment' }]);
  });

  it('skips an order event whose linked payments are all failed', async () => {
    const res = await backfillSalesFromEvents(
      [{ eventId: 'e1', type: 'order.updated', entityKind: 'order', entityId: 'ord-1', raw: {} }],
      orderFetchers,
      { getOrderPayments: async () => [failed({ id: 'pay-bad' })] }
    );
    expect(res.records).toHaveLength(0);
    expect(res.counts.unpaidOrderSkipped).toBe(1);
    expect(res.skipped).toEqual([{ eventId: 'e1', reason: 'unpaid-order' }]);
  });

  it('books an order event from the successful payment subset', async () => {
    const res = await backfillSalesFromEvents(
      [{ eventId: 'e1', type: 'order.updated', entityKind: 'order', entityId: 'ord-1', raw: {} }],
      orderFetchers,
      { getOrderPayments: async () => [failed({ id: 'pay-bad' }), successful({ id: 'pay-ok' })] }
    );
    expect(res.records).toHaveLength(1);
    expect(res.records[0]?.feeCents).toBe(33);
    expect(res.counts.booked).toBe(1);
  });
});
