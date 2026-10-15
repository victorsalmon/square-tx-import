import { describe, expect } from 'vitest';
import { fc, test as fcTest } from '@fast-check/vitest';
import {
  checkRecordInvariant,
  fromOrderWithPayments,
  fromPaymentOnly,
} from '../src/index.js';

const cents = fc.integer({ min: 0, max: 10_000_00 });
const currency = fc.constantFrom('CAD', 'USD');
const dateIso = fc
  .integer({ min: Date.parse('2020-01-01T00:00:00Z'), max: Date.parse('2026-10-15T00:00:00Z') })
  .map((ms) => new Date(ms).toISOString());

describe('money invariant', () => {
  fcTest.prop([
    fc.record({
      gross: cents,
      tax: cents,
      fee: cents,
      refunded: cents,
      currency,
      date: dateIso,
      id: fc.uuid(),
    }),
  ])('order-linked records satisfy gross + tax − fee − refunded === net', (v) => {
    const r = fromOrderWithPayments(
      {
        id: v.id,
        closedAt: v.date,
        totalMoney: { amount: v.gross + v.tax, currency: v.currency },
        totalTaxMoney: { amount: v.tax, currency: v.currency },
      },
      [
        {
          id: `p-${v.id}`,
          totalMoney: { amount: v.gross + v.tax, currency: v.currency },
          refundedMoney: { amount: v.refunded, currency: v.currency },
          processingFee: [{ type: 'INITIAL', amountMoney: { amount: v.fee, currency: v.currency } }],
        },
      ]
    );
    expect(r.netCents).toBe(v.gross + v.tax - v.fee - v.refunded);
    expect(checkRecordInvariant(r)).toBe(true);
  });

  fcTest.prop([
    fc.record({
      gross: cents,
      fee: cents,
      refunded: cents,
      currency,
      date: dateIso,
      id: fc.uuid(),
    }),
  ])('payment-only records satisfy gross − fee − refunded === net', (v) => {
    fc.pre(v.fee + v.refunded <= v.gross);
    const r = fromPaymentOnly({
      id: v.id,
      createdAt: v.date,
      totalMoney: { amount: v.gross, currency: v.currency },
      refundedMoney: { amount: v.refunded, currency: v.currency },
      processingFee: [{ type: 'INITIAL', amountMoney: { amount: v.fee, currency: v.currency } }],
    });
    expect(r.netCents).toBe(v.gross - v.fee - v.refunded);
    expect(checkRecordInvariant(r)).toBe(true);
  });
});
