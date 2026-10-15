# Events-API backfill — missed-delivery repair

When webhook deliveries are missed (receiver outage, subscription lapse),
replay the gap with `SearchEvents` (`collectBackfillEvents`) filtered by
seller (`merchantIds`), `locationIds`, and `created_at`, then re-fetch each
hit's canonical order/payment by ID and reconcile (`backfillSalesFromEvents`).

## 28-day retention cap

The Events API only searches the trailing **28 days**. The cap is enforced in
code (`assertWithinRetention` / `EventsRetentionError`): a window starting
earlier than 28 days ago, or spanning more than 28 days, throws. Repair older
gaps with a poll-primary re-import (`importSalesWindow` over Orders/Payments),
which has no such cap. Split long gaps into ≤28-day chunks.

## Never book from the event

`data.object` snapshots are point-in-time and may be stale, partial, or
duplicated. Every event resolves through `CanonicalFetchers.getOrder` /
`getPayment` first; events with no resolvable entity land in
`result.skipped` with a reason (`no-entity-id`, `unknown-entity-kind`,
`canonical-row-missing`, `adapt-failed: ...`). Payout events skip with
`payout-requires-entries` — payouts reconcile via `ListPayoutEntries`
(`listAllPayoutEntries` + `reconcilePayoutEntries`), not via a single row.

## Authentication

The Events API requires the **application personal access token** —
per-seller OAuth tokens are rejected with 401. Seller OAuth grants
(`PAYMENTS_READ` + `ORDERS_READ` + `PAYOUTS_READ`) still gate *visibility*:
only events for sellers that granted the app are searchable. In practice:
search with the app token + `merchantIds` filter, then re-fetch canonical
rows with the per-seller OAuth token.
