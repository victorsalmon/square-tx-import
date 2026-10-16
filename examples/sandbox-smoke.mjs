// Dev-sandbox smoke: prove the sandbox is wired without booking anything.
//
// Run with: npm run build && node examples/sandbox-smoke.mjs
// Requires (environment only — never flags, never committed files):
//   SQUARE_ACCESS_TOKEN  sandbox token (see docs/SANDBOX.md for where it lives)
//   SQUARE_ENVIRONMENT   must be exactly `sandbox` — anything else (including
//                        `production`, including unset) refuses to run.
//   SQUARE_LOCATION_IDS  comma-separated sandbox location id(s).
// See docs/SANDBOX.md for setup.
//
// Makes read-only `SearchOrders` + `ListPayments` calls over a small trailing
// window only; adapts the rows in memory via `importSalesWindow`. No writes,
// no webhook delivery, no account changes, nothing is booked.
//
// Output contract: counts plus one projected line per record —
// { externalId, date, grossCents, taxCents, feeCents, netCents, currency }.
// Never prints raw payloads (`rawJson`), full records, or credential values.
// Missing/unacceptable env exits non-zero with names-only messages BEFORE any
// import or client construction (fail-closed; the missing-env and
// production-refusal paths are the zero-network proofs).
//
// Exit codes: 0 ok · 2 usage/config/refusal error · 1 Square API error.

// Small trailing window on purpose: this is a wiring check, not an import.
const SMOKE_WINDOW_DAYS = 7;
// Small pages on purpose: same reason.
const SMOKE_LIMIT = 25;

// --- Pre-flight: env-only, before ANY import or network. ---

const token = process.env.SQUARE_ACCESS_TOKEN;
if (!token) {
  // Names only — never print a credential value, even when set.
  console.error(
    'sandbox-smoke: SQUARE_ACCESS_TOKEN is not set. Export your sandbox token first (see docs/SANDBOX.md).'
  );
  process.exit(2);
}

const environmentName = (process.env.SQUARE_ENVIRONMENT ?? '').toLowerCase();
if (environmentName !== 'sandbox') {
  console.error(
    `sandbox-smoke: refusing to run — SQUARE_ENVIRONMENT must be exactly 'sandbox', got '${environmentName}'. ` +
      'This script never touches production.'
  );
  process.exit(2);
}

const locationIds = (process.env.SQUARE_LOCATION_IDS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter((s) => s.length > 0);
if (locationIds.length === 0) {
  // Names only — never print the (empty or malformed) value.
  console.error(
    'sandbox-smoke: SQUARE_LOCATION_IDS is not set or empty. Export a comma-separated sandbox location id list first (see docs/SANDBOX.md).'
  );
  process.exit(2);
}

// --- Wiring: imports happen only after the pre-flight above. ---

let SquareClient;
let SquareEnvironment;
try {
  ({ SquareClient, SquareEnvironment } = await import('square'));
} catch {
  console.error("sandbox-smoke: the 'square' package is not installed. Run `npm install` first.");
  process.exit(2);
}

let importSalesWindow;
try {
  ({ importSalesWindow } = await import('../dist/index.js'));
} catch {
  console.error('sandbox-smoke: built output not found. Run `npm run build` first.');
  process.exit(2);
}

const client = new SquareClient({
  token,
  environment: SquareEnvironment.Sandbox,
});

const endAt = new Date().toISOString();
const startAt = new Date(Date.now() - SMOKE_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();

// `SearchOrders` takes location id arrays natively.
const ordersPort = {
  searchOrders: async ({ locationIds: ids, startAt: s, endAt: e, cursor, limit }) => {
    const res = await client.orders.search({
      locationIds: ids,
      cursor,
      limit,
      query: { filter: { dateTimeFilter: { updatedAt: { startAt: s, endAt: e } } } },
    });
    return { orders: res.orders ?? [], cursor: res.cursor };
  },
};

// `ListPayments` takes ONE location id, so the smoke port fans out across the
// configured locations inside a single call (drains each location's cursor,
// returns the union with no cursor). Smoke-only adapter, not library code.
const paymentsPort = {
  listPayments: async ({ beginTime, endTime, limit }) => {
    const payments = [];
    for (const locationId of locationIds) {
      let cursor;
      for (;;) {
        const page = await client.payments.list({
          locationId,
          beginTime,
          endTime,
          cursor,
          limit,
        });
        payments.push(...page.data);
        const next = page.response?.cursor;
        if (!next) break;
        cursor = next;
      }
    }
    return { payments, cursor: undefined };
  },
};

try {
  console.log(`sandbox-smoke: window ${startAt}..${endAt} over ${locationIds.length} location(s)`);
  const records = await importSalesWindow(
    ordersPort,
    paymentsPort,
    { locationIds, startAt, endAt, limit: SMOKE_LIMIT }
  );

  console.log(`sandbox-smoke: imported ${records.length} sales records`);
  for (const record of records) {
    // Projected lines only — `rawJson` (the source rows) is never printed.
    console.log(
      JSON.stringify({
        externalId: record.externalId,
        date: record.date,
        grossCents: record.grossCents,
        taxCents: record.taxCents,
        feeCents: record.feeCents,
        netCents: record.netCents,
        currency: record.currency,
      })
    );
  }
  if (records.length === 0) {
    console.log('sandbox-smoke: no sales in the window — seed a sandbox test payment first (see docs/SANDBOX.md).');
  }
} catch (err) {
  console.error(`sandbox-smoke: import failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
