# `square-sales`

Import Square **sales** records for bookkeeping — and nothing else.

The package adapts canonical Square rows (`SearchOrders`, `ListPayments`,
`ListPayoutEntries`) into a single money-safe `SalesRecord` shape
(smallest-unit cents), treats webhooks as a freshness signal (never the
books), and repairs missed deliveries through the Events API with the 28-day
retention cap enforced in code.

**Out of scope by design:** no Invoices API, no Reporting API
(analytics-shaped, ~15-minute staleness — evaluated and rejected; do **not**
request `REPORTING_READ`), no MCP runtime code (dev-aid only). OAuth scopes:
`PAYMENTS_READ` + `ORDERS_READ` + `PAYOUTS_READ` only — see
[`docs/OAUTH-SCOPES.md`](./docs/OAUTH-SCOPES.md).

---

## Installation

```bash
npm install @clocklobster/square-sales
```

Requires the [`square`](https://www.npmjs.com/package/square) SDK `^46.0.0`
(Square API version `2026-09-16`) — installed automatically as a dependency.

---

## Quick start

```typescript
import { SquareClient, SquareEnvironment } from 'square';
import { importSalesWindow } from '@clocklobster/square-sales';

const client = new SquareClient({
  token: process.env.SQUARE_ACCESS_TOKEN!,
  environment: SquareEnvironment.Production,
});

const records = await importSalesWindow(
  {
    searchOrders: async ({ locationIds, startAt, endAt, cursor, limit }) => {
      const res = await client.orders.search({
        locationIds,
        cursor,
        limit,
        query: { filter: { dateTimeFilter: { updatedAt: { startAt, endAt } } } },
      });
      return { orders: res.orders ?? [], cursor: res.cursor };
    },
  },
  {
    listPayments: async ({ locationIds, beginTime, endTime, cursor, limit }) => {
      const page = await client.payments.list({
        locationId: locationIds?.[0],
        beginTime,
        endTime,
        cursor,
        limit,
      });
      const payments = [];
      for await (const p of page) payments.push(p);
      return { payments, cursor: undefined };
    },
  },
  { locationIds: ['LOC_ID'], startAt: '2026-10-01T00:00:00Z' }
);
// records: SalesRecord[] — gross/tax/fee/refund/net in cents, provider 'square'
```

### Verify a webhook (freshness signal)

```typescript
import { verifySquareWebhook, parseSquareWebhookEvent, webhookRefreshTarget } from '@clocklobster/square-sales';

if (!verifySquareWebhook({ requestBody, signatureHeader, signatureKey, notificationUrl })) {
  return new Response('unauthorized', { status: 401 });
}
const target = webhookRefreshTarget(parseSquareWebhookEvent(requestBody));
// → { kind: 'payment'|'order'|'payout', id } — re-fetch THIS via the API.
```

Runnable examples (run `npm run build` first):

- [`examples/verify-webhook.mjs`](./examples/verify-webhook.mjs) — offline signature round-trip.
- [`examples/poll-import.mjs`](./examples/poll-import.mjs) — offline window import over fake ports.

Provision the webhook subscription (operator step):

```bash
SQUARE_ACCESS_TOKEN=... SQUARE_WEBHOOK_URL=https://you.example/hooks/square \
  node scripts/provision-webhooks.mjs --test
```

---

## Quality and test discipline

| Suite | Command | Notes |
| ----- | ------- | ----- |
| Unit tests | `npm test` | Vitest, offline (injected fake clients) |
| Property test | `npm test` | fast-check: adapted records always satisfy `gross + tax − fee − refunded === net` |
| Typecheck | `npm run typecheck` | `tsc --noEmit` |

---

## Documentation

- [`docs/OAUTH-SCOPES.md`](./docs/OAUTH-SCOPES.md) — the three scopes, and why Invoices / Reporting / MCP are out.
- [`docs/WEBHOOKS.md`](./docs/WEBHOOKS.md) — verification, freshness-only handling, 90-day key rotation.
- [`docs/EVENTS-BACKFILL.md`](./docs/EVENTS-BACKFILL.md) — 28-day cap, never-book-from-event, PAT auth note.

---

## License

MIT — see [LICENSE](./LICENSE).

Built by [Clock Lobster](https://clocklobster.com).
