# Dev-sandbox runbook

Prove this package against a Square sandbox **before** pointing it at
anything real. The library is code-ready (unit + cursor + backfill-cap +
invariant suites, `npm test`) but sandbox-unproven: the first live
`SearchOrders` page, the first `ListPayments` page, and the first verified
sandbox webhook should all happen here.

> For assisted signup (a guided hand through the Square account /
> Developer Console app creation clicks), use the fleet `web-create-account`
> skill. This runbook covers what to do once the account exists.

## 1. Account + sandbox model

1. Create a Square account (email + business details — no code, no API
   calls needed for this step). Do **not** create any account on behalf of
   a third party from this task context — account creation is an operator
   step.
2. In the Developer Console, create an **application** for this
   integration. Each application carries its own sandbox test environment,
   so seed orders, test payments, and webhook subscriptions for this
   package cannot leak into other work. Request exactly the three OAuth
   scopes this package needs — `PAYMENTS_READ` + `ORDERS_READ` +
   `PAYOUTS_READ` — and nothing more (see
   [`docs/OAUTH-SCOPES.md`](./OAUTH-SCOPES.md)).
3. Do all proving work in the application's **sandbox**. The sandbox
   seller, locations, and catalog are test-only fixtures; nothing created
   or charged there touches real money, and nothing learned there grants
   access to the production seller.

## 2. Sandbox token + test authorizations (where they live)

Sandbox credentials live in the Developer Console on the application's
pages (console labels drift — look for the sandbox/test equivalents):

- **Sandbox access token** — the application's **Credentials** page shows
  a sandbox token for the test environment. That token is what the smoke
  script and local proving use. It authorizes only the sandbox seller.
- **Per-permission test authorizations** — the application's **OAuth**
  page issues sandbox test authorization tokens scoped to the permissions
  the app requests. Use those test tokens when exercising the per-seller
  OAuth path; each one carries only the three read scopes above.
- Production tokens (production access token, production OAuth grants)
  must never appear in sandbox proving. The smoke script enforces this in
  code: anything other than `SQUARE_ENVIRONMENT=sandbox` refuses to run.

| Env var | Value | Used by |
| :--- | :--- | :--- |
| `SQUARE_ACCESS_TOKEN` | Sandbox token from the app Credentials page (test environment only) | `examples/sandbox-smoke.mjs`; `scripts/provision-webhooks.mjs` (with `SQUARE_ENVIRONMENT=sandbox`) |
| `SQUARE_ENVIRONMENT` | Must be exactly `sandbox` for all proving work | `examples/sandbox-smoke.mjs` (refuses anything else); `scripts/provision-webhooks.mjs` (defaults to `production` — set explicitly) |
| `SQUARE_LOCATION_IDS` | Comma-separated sandbox location id(s) (sandbox seller dashboard → Locations) | `examples/sandbox-smoke.mjs` (orders search + per-location payments fan-out) |

Rules:

- Export credentials into the environment only (`export
  SQUARE_ACCESS_TOKEN=…` / `$env:SQUARE_ACCESS_TOKEN=…`). Never commit
  them, never paste them into docs, chat logs, or fixtures.
- Sandbox tokens stay in the sandbox. A production token must never be
  exported as `SQUARE_ACCESS_TOKEN` during integration work — the smoke
  script's environment gate is the backstop, not the plan.

## 3. Seed guidance

The sandbox starts empty, and `SearchOrders` / `ListPayments` only list
what has moved money. Generate activity with sandbox test payments:

- **Sandbox test payments** — take payments in the sandbox seller
  environment (sandbox POS / payment form / virtual terminal) using the
  **test card values published in Square's sandbox testing docs**. Test
  values are never charged and never settle; each completed test sale
  yields an order row plus a payment row with processing fees, exactly
  the shapes `importSalesWindow` adapts.
- **Refunds** — refund one test payment in the sandbox dashboard to get a
  `refund.updated` event and a `refunded_money` linkage for the
  payment-only path.
- **Payouts** — sandbox payouts follow their own cadence; the
  `ListPayoutEntries` reconciliation path is proven by the unit suite
  until a sandbox payout lands. Do not wait for one to run the smoke —
  orders plus payments alone prove the wiring.

Two or three test sales are enough for the smoke script below.

## 4. No real personal data in the sandbox

Treat the sandbox as a non-production environment: use fictitious buyer,
item, and location names only. Per Square's docs, test environments must
not contain real personal data — a data-minimisation / GDPR concern, not
just hygiene. Never copy production customers, orders, or payouts into a
sandbox to "prove with real data"; the seeded test sales above are the
proof set. If a real value ever lands in the sandbox, treat it as a data
incident (rotate the sandbox token, delete the fixture).

## 5. Smoke check

```bash
npm run build
node examples/sandbox-smoke.mjs   # needs SQUARE_ACCESS_TOKEN + SQUARE_ENVIRONMENT=sandbox + SQUARE_LOCATION_IDS
```

The script runs `importSalesWindow` over a deliberately small trailing
window (7 days, small pages) and prints only counts plus one projected
line per record (`externalId`, `date`, `grossCents`, `taxCents`,
`feeCents`, `netCents`, `currency`) — no raw payloads, no credential
values. With any of the three env vars unset it exits non-zero with a
names-only message (fail-closed; the missing-env path is the
zero-network proof). With `SQUARE_ENVIRONMENT` set to anything but
`sandbox` it refuses before any import or client construction (the
production-refusal path — also zero-network).

Success looks like: the window/​location line prints, then the record
count, then one line per record with sane cents (`grossCents + taxCents
− feeCents − refunded === net` per the package invariant, `currency`
your sandbox currency). Zero records with a fresh sandbox is normal —
seed test payments (§3) and re-run.

## 6. Webhooks against localhost

Sandbox event deliveries need a public HTTPS endpoint, which localhost
is not. Forward them locally during proving:

1. Expose your handler through an HTTPS tunnel forwarder (localhost port
   → public URL) for the duration of the proving session.
2. Provision a **sandbox** subscription pointing at the tunnel URL:
   `SQUARE_ENVIRONMENT=sandbox SQUARE_ACCESS_TOKEN=… \
   SQUARE_WEBHOOK_URL=https://<tunnel>/hooks/square \
   node scripts/provision-webhooks.mjs --test` (see
   [`docs/WEBHOOKS.md`](./WEBHOOKS.md) for verification and the 90-day
   rotation rule).
3. Trigger a sandbox test sale; handle the delivery as freshness-only
   (verify → re-fetch the canonical order/payment → adapt → upsert by
   `externalId`).
4. Tear the tunnel subscription down when done, and never point the
   **production** subscription at a tunnel URL.
