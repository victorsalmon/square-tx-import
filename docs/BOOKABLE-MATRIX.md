# Bookable vs. excluded sales rows

Which Square rows become `SalesRecord`s — and which are skipped, with what
counted reason. The predicates live in `src/adapter.ts`
(`isSuccessfulPayment`, `isBookableOrder`, `isBookablePayment`,
`isZeroValueRecord`); the poll import (`src/poll.ts`,
`importSalesWindowDetailed`) and the Events-API backfill
(`src/events-backfill.ts`, `backfillSalesFromEvents`) enforce them.
`importSalesWindow` books the same set and returns the records only — use the
detailed variant (or the backfill `counts`) for the skip counts.

## Payment success

A payment counts as money captured when `status` is `COMPLETED`
(case-insensitive). An **absent** status (`null`/`undefined`/empty) counts as
successful for backward compatibility — rows produced before status was
surfaced carry no status and keep booking. Every other explicit status does
**not** book: `FAILED`, `CANCELED`/`CANCELLED`, and also `APPROVED`
(authorized, not yet captured) and `PENDING`.

Failed payments **never book** and **never contribute** fees/refunds to an
order record: order adaption runs over the successful subset only
(`successfulPaymentsOnly`).

## Matrix

| # | Row shape | Verdict | Skip reason (counted where reported) |
| - | --------- | ------- | ----------------------------------- |
| 1 | Order + ≥1 linked successful payment, non-zero money | **Books** (`order:<id>`) | — |
| 2 | Order + ≥1 linked successful payment, but adapted record is all-zero | Excluded | `zero-value` (`stats.zeroValueSkipped` / `counts.zeroValueSkipped`) |
| 3 | Order whose linked payments are ALL failed/canceled/authorized-only | Excluded | `unpaid-order` |
| 4 | Order with NO linked payments in the window | Excluded | `unpaid-order` |
| 5 | Lone (order-less, or order-row-missing) payment, successful, non-zero | **Books** (`payment:<id>`) | — |
| 6 | Lone successful payment, all-zero money | Excluded | `zero-value` |
| 7 | Lone payment with explicit non-success status (`FAILED`, `CANCELED`, `APPROVED`, …) | Excluded — never books | `failed-payment` |
| 8 | Fully-refunded sale (`refundedCents > 0`, negative net) | **Books** — a refund is linkage, not zero-value | — |
| 9 | Backfill order event without `getOrderPayments` | **Books** — linkage unknown, gate cannot be evaluated (pass `getOrderPayments` for full enforcement) | — |
| 10 | Backfill payout / unknown-kind / missing-entity events | Excluded (plumbing, unchanged) | `payout-requires-entries` / `unknown-entity-kind` / `canonical-row-missing` / `no-entity-id` |

## All-zero definition

`grossCents == taxCents == feeCents == refundedCents == netCents == 0`
(`isZeroValueRecord`). These are Square $0 placeholders ($0 draft orders, $0
verification payments), not sales. The `refundedCents == 0` conjunct is the
"no refund linkage" clause: any refund keeps the row bookable (row 8).

## Notes

- The low-level adaptors (`fromOrderWithPayments`, `fromPaymentOnly`) stay
  total over their inputs — they adapt, they do not judge. All gating happens
  in the import layers above, so money math remains directly unit-testable.
- `order.state` (e.g. `OPEN` vs `COMPLETED`) is informational; the paid gate
  is the linked-payment test. An `OPEN` order without a successful payment is
  excluded by row 3/4, not by its state string.
- Deduping by `externalId` happens before *and* after the zero-value test, so
  a repeated $0 row counts its skip once.
