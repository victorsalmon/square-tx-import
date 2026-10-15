# Webhooks — freshness signal, never the books

Subscribe (via `scripts/provision-webhooks.mjs`) to exactly:

- `payment.updated`
- `refund.updated`
- `payout.updated`

One app-owned subscription; per-seller fan-out happens in the importer.

## Verification

Each delivery carries `x-square-hmacsha256-signature`: base64 HMAC-SHA256 of
`notificationUrl + rawBody` keyed with the subscription signature key. Use
`verifySquareWebhook()` and discard non-verifying deliveries without logging
the key. The `notificationUrl` must match the subscribed URL **exactly**
(scheme, host, path, trailing slash).

## Handling rule

A verified event means *"something changed — go look"*. The importer must:

1. `parseSquareWebhookEvent()` → `webhookRefreshTarget()` to get the
   canonical `{ kind, id }`;
2. re-fetch the Order / Payment / Payout via the API;
3. adapt the canonical row (`adapter.ts`) and upsert by `externalId`.

Never book from `data.object` — it is a point-in-time snapshot that can
arrive out of order or duplicated. `refund.updated` carries the *refund* id;
resolve the parent payment via the Refunds API before adapting.

## Signature-key rotation (90 days)

Rotate the subscription signature key at least every **90 days**:

```bash
SQUARE_ACCESS_TOKEN=... SQUARE_WEBHOOK_URL=https://... \
  node scripts/provision-webhooks.mjs --rotate-key
```

The old key dies immediately — store the new key first, then cut over the
verifier. `isSignatureKeyStale(keyCreatedAtMs)` computes the deadline;
alert when it returns true.
