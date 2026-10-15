import { describe, it, expect } from 'vitest';
import {
  AdaptError,
  PayoutMismatchError,
  assertPayoutEntriesBalanced,
  buildSalesRecord,
  checkRecordInvariant,
  fromOrderWithPayments,
  fromPaymentOnly,
  moneyToCents,
  pickCurrency,
  reconcilePayoutEntries,
  sumProcessingFees,
  sumRefunded,
} from '../src/index.js';
import type { SquareOrderRow, SquarePaymentRow } from '../src/index.js';

const orderLinked: SquareOrderRow = {
  id: 'ord-1',
  locationId: 'loc-1',
  state: 'COMPLETED',
  createdAt: '2026-10-14T10:00:00Z',
  closedAt: '2026-10-14T10:05:00Z',
  totalMoney: { amount: 1130n, currency: 'CAD' }, // includes tax
  totalTaxMoney: { amount: 130n, currency: 'CAD' },
};

const linkedPayments: SquarePaymentRow[] = [
  {
    id: 'pay-1',
    orderId: 'ord-1',
    createdAt: '2026-10-14T10:05:00Z',
    totalMoney: { amount: 1130n, currency: 'CAD' },
    refundedMoney: { amount: 0n, currency: 'CAD' },
    processingFee: [{ type: 'INITIAL', amountMoney: { amount: 33n, currency: 'CAD' } }],
  },
  {
    id: 'pay-2',
    orderId: 'ord-1',
    createdAt: '2026-10-14T10:06:00Z',
    totalMoney: { amount: 0n, currency: 'CAD' },
    refundedMoney: { amount: 0n, currency: 'CAD' },
    // Adjustment returns part of the fee (negative).
    processingFee: [{ type: 'ADJUSTMENT', amountMoney: { amount: -5n, currency: 'CAD' } }],
  },
];

describe('moneyToCents', () => {
  it('accepts bigint, number, and numeric-string amounts', () => {
    expect(moneyToCents({ amount: 100n })).toBe(100);
    expect(moneyToCents({ amount: 100 })).toBe(100);
    expect(moneyToCents({ amount: '100' })).toBe(100);
  });
  it('treats absent money as zero', () => {
    expect(moneyToCents()).toBe(0);
    expect(moneyToCents(null)).toBe(0);
    expect(moneyToCents({})).toBe(0);
    expect(moneyToCents({ amount: null })).toBe(0);
  });
  it('keeps negative adjustments', () => {
    expect(moneyToCents({ amount: -5n })).toBe(-5);
  });
  it('throws on non-numeric, fractional, or unsafe amounts', () => {
    expect(() => moneyToCents({ amount: 'abc' })).toThrow(AdaptError);
    expect(() => moneyToCents({ amount: 10.5 })).toThrow(AdaptError);
    expect(() => moneyToCents({ amount: '10.5' })).toThrow(AdaptError);
    expect(() => moneyToCents({ amount: BigInt(Number.MAX_SAFE_INTEGER) + 1n })).toThrow(AdaptError);
  });
});

describe('pickCurrency', () => {
  it('returns the first currency seen, else the default', () => {
    expect(pickCurrency([{ currency: 'CAD' }, { currency: 'USD' }])).toBe('CAD');
    expect(pickCurrency([null, {}])).toBe('USD');
    expect(pickCurrency([null], { defaultCurrency: 'CAD' })).toBe('CAD');
  });
});

describe('fromOrderWithPayments (order-linked preferred)', () => {
  it('books gross = total − tax with summed fees incl. adjustments', () => {
    const r = fromOrderWithPayments(orderLinked, linkedPayments);
    expect(r.externalId).toBe('order:ord-1');
    expect(r.date).toBe('2026-10-14T10:05:00Z'); // closed_at
    expect(r.grossCents).toBe(1000);
    expect(r.taxCents).toBe(130);
    expect(r.feeCents).toBe(28); // 33 + (-5)
    expect(r.refundedCents).toBe(0);
    expect(r.netCents).toBe(1000 + 130 - 28);
    expect(r.currency).toBe('CAD');
    expect(r.provider).toBe('square');
    expect(checkRecordInvariant(r)).toBe(true);
  });

  it('falls back to created_at when closed_at is absent', () => {
    const r = fromOrderWithPayments({ ...orderLinked, closedAt: null }, []);
    expect(r.date).toBe('2026-10-14T10:00:00Z');
  });

  it('throws on missing id or dates', () => {
    expect(() => fromOrderWithPayments({ ...orderLinked, id: undefined }, [])).toThrow(AdaptError);
    expect(() => fromOrderWithPayments({ ...orderLinked, closedAt: null, createdAt: null }, [])).toThrow(
      AdaptError
    );
  });
});

describe('fromPaymentOnly (payment-only fallback)', () => {
  it('books gross = total_money with refunded_money', () => {
    const payment: SquarePaymentRow = {
      id: 'pay-9',
      createdAt: '2026-10-13T09:00:00Z',
      totalMoney: { amount: 5000, currency: 'USD' },
      refundedMoney: { amount: 1200, currency: 'USD' },
      processingFee: [{ type: 'INITIAL', amountMoney: { amount: 150, currency: 'USD' } }],
    };
    const r = fromPaymentOnly(payment);
    expect(r.externalId).toBe('payment:pay-9');
    expect(r.grossCents).toBe(5000);
    expect(r.taxCents).toBe(0);
    expect(r.feeCents).toBe(150);
    expect(r.refundedCents).toBe(1200);
    expect(r.netCents).toBe(5000 - 150 - 1200);
    expect(checkRecordInvariant(r)).toBe(true);
  });

  it('sums fees and refunds across helpers', () => {
    expect(sumProcessingFees(linkedPayments)).toBe(28);
    expect(sumRefunded(linkedPayments)).toBe(0);
  });
});

describe('buildSalesRecord', () => {
  it('computes net from the invariant', () => {
    const r = buildSalesRecord({
      externalId: 'x',
      date: '2026-10-14T00:00:00Z',
      grossCents: 100,
      taxCents: 13,
      feeCents: 4,
      refundedCents: 10,
      currency: 'CAD',
      rawJson: {},
    });
    expect(r.netCents).toBe(99);
    expect(r.payoutId).toBeUndefined();
  });
});

describe('payout entries reconciliation', () => {
  const payout = { id: 'po-1', amountMoney: { amount: 2972n, currency: 'CAD' } };
  const entries = [
    { id: 'e1', payoutId: 'po-1', grossAmountMoney: { amount: 2000n }, feeAmountMoney: { amount: 20n }, netAmountMoney: { amount: 1980n } },
    { id: 'e2', payoutId: 'po-1', grossAmountMoney: { amount: 1000n }, feeAmountMoney: { amount: 8n }, netAmountMoney: { amount: 992n } },
  ];

  it('balances when entries sum to the payout amount', () => {
    const res = reconcilePayoutEntries(payout, entries);
    expect(res.balanced).toBe(true);
    expect(res.mismatchCents).toBe(0);
    expect(res.grossCents).toBe(3000);
    expect(res.feeCents).toBe(28);
    expect(res.netCents).toBe(2972);
    expect(res.entryCount).toBe(2);
    expect(() => assertPayoutEntriesBalanced(payout, entries)).not.toThrow();
  });

  it('reports — never coerces — a mismatch, and the assert throws', () => {
    const off = [
      { id: 'e1', payoutId: 'po-1', grossAmountMoney: { amount: 2000n }, feeAmountMoney: { amount: 20n }, netAmountMoney: { amount: 1980n } },
    ];
    const res = reconcilePayoutEntries(payout, off);
    expect(res.balanced).toBe(false);
    expect(res.mismatchCents).toBe(1980 - 2972);
    expect(() => assertPayoutEntriesBalanced(payout, off)).toThrow(PayoutMismatchError);
  });
});
