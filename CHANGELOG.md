# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Booking gates with counted skips (see `docs/BOOKABLE-MATRIX.md` for the
  full bookable-vs-excluded matrix):
  - All-zero skip: adapted records with gross = tax = fee = refunded = net =
    0 (no refund linkage) are skipped as `zero-value` — reported via
    `importSalesWindowDetailed().stats.zeroValueSkipped` and
    `backfillSalesFromEvents().counts.zeroValueSkipped`. A fully-refunded
    sale (`refundedCents > 0`) still books.
  - Paid/closed gate: order rows book only with a linked successful
    (`COMPLETED`, or absent-status) payment — `unpaid-order` skip otherwise,
    with failed payments excluded from the order's fee/refund sums;
    payment-only rows book only when the payment itself is successful —
    `failed-payment` skip otherwise (failed payments never book, including
    `FAILED`/`CANCELED`/`APPROVED`). New pure predicates
    (`isSuccessfulPayment`, `isBookableOrder`, `isBookablePayment`,
    `isZeroValueRecord`, `successfulPaymentsOnly`) plus
    `importSalesWindowDetailed` (counted `records`/`skipped`/`stats`;
    `importSalesWindow` keeps its records-only signature).
- `docs/RATE_LIMITS.md`: vendor-verified Square throttling notes (no
  published numeric limits, `429 RATE_LIMITED` shape, exponential backoff +
  jitter, worker-queue and filter/cursor list-loop guidance) plus the host
  checklist. `Retry-After` presence on the sales APIs and any fixed QPS
  figures are marked UNVERIFIED (undocumented by the vendor).
- Dev-sandbox readiness: `examples/sandbox-smoke.mjs` (env-only creds,
  sandbox-enforced, read-only `SearchOrders` + `ListPayments` wiring check
  over a small trailing window, projected-lines-only output) and
  `docs/SANDBOX.md` (token locations, seed guidance, no-PII rule,
  localhost webhook forwarding).

## [0.1.0] - 2026-10-15

### Added

- `SalesRecord` canonical bookkeeping shape (smallest-unit cents, `provider:
  'square'`).
- Pure `adapter.ts` transforms: order-linked preferred, payment-only fallback,
  payout-entries sum reconciliation (assert + report, never coerce).
- Webhook signature verification for `payment.updated` / `refund.updated` /
  `payout.updated` as a freshness signal (never booked from the event alone);
  90-day signature-key rotation documented.
- Poll-primary import (`SearchOrders` + `ListPayments` + `ListPayoutEntries`)
  with cursor pagination over injected clients (unit-testable, no network).
- Events-API missed-delivery backfill with the 28-day retention cap enforced
  in code; canonical re-fetch by ID, never booking from the event payload.
- Ops script `scripts/provision-webhooks.mjs` (webhook-subscription
  create/update/test, app-owned single subscription).
- OAuth scope note: request `PAYMENTS_READ` + `ORDERS_READ` + `PAYOUTS_READ`
  only. The Invoices API and the Reporting API (analytics-shaped, ~15-minute
  staleness) are out of scope by design.

[0.1.0]: https://github.com/victorsalmon/square-tx-import/releases/tag/v0.1.0
