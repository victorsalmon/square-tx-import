/**
 * Shared types for `@clocklobster/square-sales`.
 *
 * Scope: Square SALES records for bookkeeping ONLY. No Invoices API, no
 * Reporting API, no MCP runtime code.
 *
 * All money is smallest-unit integer cents (e.g. CAD/USD cents). The Square
 * `square@46` SDK types `Money.amount` as `bigint`; the `*Row` input shapes
 * below are structural mirrors of the SDK shapes (tolerant of
 * `bigint | number | string` amounts) so the pure adapter stays unit-testable
 * without network access or a live SDK client.
 */

/** The single canonical bookkeeping record this package produces. */
export interface SalesRecord {
  /** Stable dedupe key: `order:<id>` for order-linked rows, `payment:<id>` otherwise. */
  externalId: string;
  /** ISO-8601 timestamp of the sale (`closed_at`, else `created_at`). */
  date: string;
  /** Pre-tax sales, smallest-unit cents. */
  grossCents: number;
  /** Tax collected, smallest-unit cents. */
  taxCents: number;
  /** Square processing fees (incl. adjustments), smallest-unit cents. */
  feeCents: number;
  /** Net proceeds: `grossCents + taxCents - feeCents - refundedCents`. */
  netCents: number;
  /** ISO 4217 currency code (e.g. `CAD`). */
  currency: string;
  /** Refunded amount, smallest-unit cents. */
  refundedCents: number;
  /** Payout this sale settled in, when known. */
  payoutId?: string;
  provider: 'square';
  /** The source order/payment row(s), for audit traceability. */
  rawJson: unknown;
}

/** Structural mirror of Square `Money` (`square@46`: `amount?: bigint`). */
export interface SquareMoneyLike {
  amount?: bigint | number | string | null;
  currency?: string | null;
}

/** Structural mirror of the Square `Order` fields this package reads. */
export interface SquareOrderRow {
  id?: string;
  locationId?: string;
  state?: string | null;
  createdAt?: string | null;
  closedAt?: string | null;
  /** Order total INCLUDES tax — `gross = total - tax`. */
  totalMoney?: SquareMoneyLike | null;
  totalTaxMoney?: SquareMoneyLike | null;
}

/** Structural mirror of a Square `ProcessingFee` entry (INITIAL or ADJUSTMENT). */
export interface SquareProcessingFeeLike {
  effectiveAt?: string | null;
  type?: string | null;
  amountMoney?: SquareMoneyLike | null;
}

/** Structural mirror of the Square `Payment` fields this package reads. */
export interface SquarePaymentRow {
  id?: string;
  createdAt?: string | null;
  updatedAt?: string | null;
  status?: string | null;
  locationId?: string | null;
  orderId?: string | null;
  totalMoney?: SquareMoneyLike | null;
  refundedMoney?: SquareMoneyLike | null;
  processingFee?: SquareProcessingFeeLike[] | null;
}

/** Structural mirror of the Square `Payout` fields this package reads. */
export interface SquarePayoutRow {
  id: string;
  locationId?: string | null;
  status?: string | null;
  createdAt?: string | null;
  amountMoney?: SquareMoneyLike | null;
}

/** Structural mirror of the Square `PayoutEntry` fields this package reads. */
export interface SquarePayoutEntryRow {
  id: string;
  payoutId: string;
  effectiveAt?: string | null;
  type?: string | null;
  grossAmountMoney?: SquareMoneyLike | null;
  feeAmountMoney?: SquareMoneyLike | null;
  netAmountMoney?: SquareMoneyLike | null;
}
