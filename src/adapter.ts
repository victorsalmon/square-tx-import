/**
 * Pure adapter: Square Order/Payment/Payout rows → {@link SalesRecord}.
 *
 * No I/O. All functions are total over their documented inputs and throw
 * descriptive errors on malformed rows (missing ids, non-numeric money).
 *
 * Booking rules:
 * - Prefer the **Order** row when a payment links to one: the order is the
 *   canonical sale (`date = closed_at`, `gross = total_money − total_tax_money`,
 *   `tax = total_tax_money`), fees are the sum of the linked payments'
 *   `processing_fee` entries **including adjustments** (negative `ADJUSTMENT`
 *   entries reduce the fee), and `net = gross + tax − fees − refunds`.
 * - Otherwise book the **Payment** row: `gross = total_money`,
 *   `refunded = refunded_money`, `net = gross − fees − refunded` (tax 0).
 * - A payout's `entries[]` (`{ gross, fee, net }`) must sum to the payout
 *   `amount_money`. {@link reconcilePayoutEntries} reports the mismatch and
 *   {@link assertPayoutEntriesBalanced} throws — entries are never silently
 *   coerced to fit.
 */

import type {
  SalesRecord,
  SquareMoneyLike,
  SquareOrderRow,
  SquarePaymentRow,
  SquarePayoutEntryRow,
  SquarePayoutRow,
} from './types.js';

export interface AdaptOptions {
  /** Currency fallback when no row carries one. Defaults to `'USD'`. */
  defaultCurrency?: string;
}

/** Error thrown when a Square row cannot be adapted (missing id/date/money). */
export class AdaptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdaptError';
  }
}

/** Error thrown when payout entries do not sum to the payout amount. */
export class PayoutMismatchError extends Error {
  readonly payoutId: string;
  readonly expectedCents: number;
  readonly actualCents: number;
  readonly mismatchCents: number;
  constructor(payoutId: string, expectedCents: number, actualCents: number) {
    super(
      `Payout ${payoutId} entries sum to ${actualCents} but payout amount is ${expectedCents} ` +
        `(mismatch ${actualCents - expectedCents}); refusing to coerce — investigate in the Square dashboard.`
    );
    this.name = 'PayoutMismatchError';
    this.payoutId = payoutId;
    this.expectedCents = expectedCents;
    this.actualCents = actualCents;
    this.mismatchCents = actualCents - expectedCents;
  }
}

/**
 * Coerce a Square money-like value to integer cents.
 *
 * Accepts the SDK's `bigint`, plain `number`, and numeric strings (the wire
 * format); `null`/`undefined` means "absent" and yields 0. Throws
 * {@link AdaptError} on non-numeric or non-integer values — a fractional cent
 * is a data bug, not something to round away silently.
 */
export function moneyToCents(money?: SquareMoneyLike | null): number {
  if (money == null || money.amount == null) return 0;
  const raw = money.amount;
  const num = typeof raw === 'bigint' ? Number(raw) : typeof raw === 'string' ? Number(raw) : raw;
  if (typeof num !== 'number' || !Number.isFinite(num) || !Number.isInteger(num)) {
    throw new AdaptError(`Non-integer money amount: ${JSON.stringify(String(raw))}`);
  }
  if (!Number.isSafeInteger(num)) {
    throw new AdaptError(`Money amount exceeds safe integer range: ${String(raw)}`);
  }
  return num;
}

/** First non-empty currency seen across the given money values. */
export function pickCurrency(
  monies: Array<SquareMoneyLike | null | undefined>,
  opts?: AdaptOptions
): string {
  for (const m of monies) {
    if (m?.currency) return m.currency;
  }
  return opts?.defaultCurrency ?? 'USD';
}

/**
 * Sum every `processing_fee[].amount_money` entry across payments.
 * Both `INITIAL` fees and `ADJUSTMENT` entries count — adjustments may be
 * negative (fee returned to the seller) and reduce the total.
 */
export function sumProcessingFees(payments: SquarePaymentRow[]): number {
  let total = 0;
  for (const p of payments) {
    for (const fee of p.processingFee ?? []) {
      total += moneyToCents(fee.amountMoney);
    }
  }
  return total;
}

/** Sum `refunded_money` across payments. */
export function sumRefunded(payments: SquarePaymentRow[]): number {
  let total = 0;
  for (const p of payments) {
    total += moneyToCents(p.refundedMoney);
  }
  return total;
}

/**
 * Assemble a {@link SalesRecord}, computing `netCents` from the invariant
 * `gross + tax − fee − refunded`. All constructors funnel through here so the
 * invariant holds by construction.
 */
export function buildSalesRecord(args: {
  externalId: string;
  date: string;
  grossCents: number;
  taxCents: number;
  feeCents: number;
  refundedCents: number;
  currency: string;
  payoutId?: string;
  rawJson: unknown;
}): SalesRecord {
  const netCents = args.grossCents + args.taxCents - args.feeCents - args.refundedCents;
  return {
    externalId: args.externalId,
    date: args.date,
    grossCents: args.grossCents,
    taxCents: args.taxCents,
    feeCents: args.feeCents,
    netCents,
    currency: args.currency,
    refundedCents: args.refundedCents,
    ...(args.payoutId !== undefined ? { payoutId: args.payoutId } : {}),
    provider: 'square',
    rawJson: args.rawJson,
  };
}

/** Re-check the money invariant on a finished record. */
export function checkRecordInvariant(record: SalesRecord): boolean {
  return record.grossCents + record.taxCents - record.feeCents - record.refundedCents === record.netCents;
}

/**
 * Adapt one closed order plus its linked payments.
 *
 * `date` is `closed_at` (falling back to `created_at`); `gross` is
 * `total_money − total_tax_money` because the Square order total includes tax.
 */
export function fromOrderWithPayments(
  order: SquareOrderRow,
  payments: SquarePaymentRow[],
  opts?: AdaptOptions
): SalesRecord {
  if (!order.id) throw new AdaptError('Order has no id');
  const date = order.closedAt ?? order.createdAt ?? undefined;
  if (!date) throw new AdaptError(`Order ${order.id} has neither closed_at nor created_at`);
  const totalCents = moneyToCents(order.totalMoney);
  const taxCents = moneyToCents(order.totalTaxMoney);
  const feeCents = sumProcessingFees(payments);
  const refundedCents = sumRefunded(payments);
  return buildSalesRecord({
    externalId: `order:${order.id}`,
    date,
    grossCents: totalCents - taxCents,
    taxCents,
    feeCents,
    refundedCents,
    currency: pickCurrency(
      [order.totalMoney, order.totalTaxMoney, ...payments.map((p) => p.totalMoney)],
      opts
    ),
    rawJson: { order, payments },
  });
}

/** Adapt a lone payment (no linked order row available). */
export function fromPaymentOnly(payment: SquarePaymentRow, opts?: AdaptOptions): SalesRecord {
  if (!payment.id) throw new AdaptError('Payment has no id');
  const date = payment.createdAt ?? payment.updatedAt ?? undefined;
  if (!date) throw new AdaptError(`Payment ${payment.id} has neither created_at nor updated_at`);
  const grossCents = moneyToCents(payment.totalMoney);
  const feeCents = sumProcessingFees([payment]);
  const refundedCents = moneyToCents(payment.refundedMoney);
  return buildSalesRecord({
    externalId: `payment:${payment.id}`,
    date,
    grossCents,
    taxCents: 0,
    feeCents,
    refundedCents,
    currency: pickCurrency([payment.totalMoney, payment.refundedMoney], opts),
    rawJson: { payment },
  });
}

export interface PayoutReconciliation {
  payoutId: string;
  /** The payout's own `amount_money`, in cents. */
  expectedCents: number;
  grossCents: number;
  feeCents: number;
  netCents: number;
  entryCount: number;
  balanced: boolean;
  /** `netCents − expectedCents`; 0 when balanced. */
  mismatchCents: number;
}

/**
 * Reconcile a payout against its entries. The entries' net must equal the
 * payout amount; gross/fee are reported for the ledger split. A mismatch is
 * reported, never coerced — call {@link assertPayoutEntriesBalanced} to fail
 * closed, or inspect `balanced`/`mismatchCents` to route the payout to manual
 * review.
 */
export function reconcilePayoutEntries(
  payout: SquarePayoutRow,
  entries: SquarePayoutEntryRow[]
): PayoutReconciliation {
  const expectedCents = moneyToCents(payout.amountMoney);
  let grossCents = 0;
  let feeCents = 0;
  let netCents = 0;
  for (const e of entries) {
    grossCents += moneyToCents(e.grossAmountMoney);
    feeCents += moneyToCents(e.feeAmountMoney);
    netCents += moneyToCents(e.netAmountMoney);
  }
  const mismatchCents = netCents - expectedCents;
  return {
    payoutId: payout.id,
    expectedCents,
    grossCents,
    feeCents,
    netCents,
    entryCount: entries.length,
    balanced: mismatchCents === 0,
    mismatchCents,
  };
}

/** Fail closed when payout entries do not sum to the payout amount. */
export function assertPayoutEntriesBalanced(
  payout: SquarePayoutRow,
  entries: SquarePayoutEntryRow[]
): PayoutReconciliation {
  const result = reconcilePayoutEntries(payout, entries);
  if (!result.balanced) {
    throw new PayoutMismatchError(payout.id, result.expectedCents, result.netCents);
  }
  return result;
}
