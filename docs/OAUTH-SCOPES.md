# OAuth scopes

Request **exactly** these three scopes and nothing more:

| Scope | Why |
| :--- | :--- |
| `PAYMENTS_READ` | `ListPayments` / `GetPayment` — payment rows, processing fees, refunds. |
| `ORDERS_READ` | `SearchOrders` / `GetOrder` — canonical sale (total, tax, `closed_at`). |
| `PAYOUTS_READ` | `ListPayouts` / `GetPayout` / `ListPayoutEntries` — payout reconciliation. |

Seller OAuth grants gate *visibility*: the app only sees sellers (merchant
ids) that granted it. Request the scopes once at OAuth time; per-seller
fan-out happens in the importer.

## Explicitly out of scope

- **Invoices API** — not requested, not used. Invoicing is a receivables flow;
  this package books *settled sales*.
- **`REPORTING_READ` / Reporting API** — evaluated and **rejected**. The
  Reporting API is analytics-shaped (pre-aggregated reports, not canonical
  rows) with roughly **15-minute staleness**, which breaks the
  poll-primary/book-from-canonical-rows contract. Requesting `REPORTING_READ`
  would widen the OAuth consent screen for data this package must not book
  from. Do not add it.
- **MCP runtime code** — this package ships no Model Context Protocol server
  or tool wiring. MCP use is dev-aid only (docs, exploration); nothing under
  `src/` depends on it.
