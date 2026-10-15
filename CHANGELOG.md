# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
