/**
 * Poll-primary import demo with fake ports (offline) + real-SDK wiring notes.
 *
 * Offline demo: node examples/poll-import.mjs
 *
 * Real SDK wiring (needs SQUARE_ACCESS_TOKEN):
 *
 *   import { SquareClient, SquareEnvironment } from 'square';
 *   const client = new SquareClient({ token: process.env.SQUARE_ACCESS_TOKEN,
 *     environment: SquareEnvironment.Production });
 *   const ordersPort = {
 *     searchOrders: async ({ locationIds, startAt, endAt, cursor, limit }) => {
 *       const res = await client.orders.search({ locationIds, cursor, limit,
 *         query: { filter: { dateTimeFilter: { updatedAt: { startAt, endAt } } } } });
 *       return { orders: res.orders ?? [], cursor: res.cursor };
 *     },
 *   };
 *   const paymentsPort = {
 *     listPayments: async ({ locationIds, beginTime, endTime, cursor, limit }) => {
 *       const page = await client.payments.list({ locationId: locationIds?.[0],
 *         beginTime, endTime, cursor, limit });
 *       // `page` is async-iterable; collect one page then read its cursor.
 *       const payments = [];
 *       for await (const p of page) { payments.push(p); break; }
 *       return { payments, cursor: undefined };
 *     },
 *   };
 */

const mod = await import('../dist/index.js');
const { importSalesWindow } = mod;

const orders = [
  {
    id: 'ord-1',
    locationId: 'loc-1',
    state: 'COMPLETED',
    createdAt: '2026-10-14T10:00:00Z',
    closedAt: '2026-10-14T10:05:00Z',
    totalMoney: { amount: 1130n, currency: 'CAD' },
    totalTaxMoney: { amount: 130n, currency: 'CAD' },
  },
];
const payments = [
  {
    id: 'pay-1',
    orderId: 'ord-1',
    createdAt: '2026-10-14T10:05:00Z',
    totalMoney: { amount: 1130n, currency: 'CAD' },
    refundedMoney: { amount: 0n, currency: 'CAD' },
    processingFee: [{ type: 'INITIAL', amountMoney: { amount: 33n, currency: 'CAD' } }],
  },
];

const ordersPort = {
  searchOrders: async () => ({ orders, cursor: undefined }),
};
const paymentsPort = {
  listPayments: async () => ({ payments, cursor: undefined }),
};

const records = await importSalesWindow(ordersPort, paymentsPort, {
  locationIds: ['loc-1'],
  startAt: '2026-10-14T00:00:00Z',
  endAt: '2026-10-15T00:00:00Z',
});
console.log(JSON.stringify(records, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v), 2));
