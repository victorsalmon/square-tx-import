import { describe, it, expect } from 'vitest';
import {
  EVENTS_RETENTION_DAYS,
  EventsRetentionError,
  assertWithinRetention,
  backfillSalesFromEvents,
  collectBackfillEvents,
} from '../src/index.js';
import type { BackfillEvent } from '../src/index.js';

const NOW = Date.parse('2026-10-15T00:00:00Z');
const iso = (ms: number): string => new Date(ms).toISOString();
const DAY = 24 * 60 * 60 * 1000;

describe('28-day retention cap', () => {
  it('is a 28-day constant', () => {
    expect(EVENTS_RETENTION_DAYS).toBe(28);
  });

  it('accepts windows inside retention', () => {
    expect(() =>
      assertWithinRetention(iso(NOW - 27 * DAY), iso(NOW - DAY), NOW)
    ).not.toThrow();
    expect(() => assertWithinRetention(iso(NOW - DAY), undefined, NOW)).not.toThrow();
  });

  it('rejects a startAt older than 28 days', () => {
    expect(() => assertWithinRetention(iso(NOW - 29 * DAY), iso(NOW - DAY), NOW)).toThrow(
      EventsRetentionError
    );
  });

  it('rejects a window spanning more than 28 days', () => {
    expect(() =>
      assertWithinRetention(iso(NOW - 20 * DAY), iso(NOW + 9 * DAY), NOW)
    ).toThrow(EventsRetentionError);
  });

  it('rejects unparseable bounds and inverted windows', () => {
    expect(() => assertWithinRetention('nope', undefined, NOW)).toThrow(EventsRetentionError);
    expect(() => assertWithinRetention(iso(NOW - DAY), iso(NOW - 2 * DAY), NOW)).toThrow(
      EventsRetentionError
    );
  });

  it('collectBackfillEvents enforces the cap before any request', async () => {
    let calls = 0;
    const port = {
      searchEvents: async () => {
        calls += 1;
        return { events: [], cursor: undefined };
      },
    };
    await expect(
      collectBackfillEvents(port, { startAt: iso(NOW - 60 * DAY), nowMs: NOW })
    ).rejects.toThrow(EventsRetentionError);
    expect(calls).toBe(0);
  });
});

describe('collectBackfillEvents cursor loop', () => {
  it('accumulates pages until the cursor is omitted', async () => {
    const e = (id: string): BackfillEvent => ({
      eventId: id,
      type: 'payment.updated',
      entityKind: 'payment',
      entityId: `pay-${id}`,
      raw: {},
    });
    const port = {
      searchEvents: async ({ cursor }: { cursor?: string }) =>
        cursor === undefined
          ? { events: [e('1'), e('2')], cursor: 'next' }
          : { events: [e('3')], cursor: undefined },
    };
    const events = await collectBackfillEvents(port, { startAt: iso(NOW - 2 * DAY), nowMs: NOW });
    expect(events.map((x) => x.eventId)).toEqual(['1', '2', '3']);
  });
});

describe('backfillSalesFromEvents', () => {
  const events: BackfillEvent[] = [
    { eventId: 'e1', type: 'order.updated', entityKind: 'order', entityId: 'ord-1', raw: {} },
    // Same canonical order twice → deduped to one record.
    { eventId: 'e2', type: 'order.updated', entityKind: 'order', entityId: 'ord-1', raw: {} },
    // Event payload carries tempting fake amounts — must NEVER be booked.
    {
      eventId: 'e3',
      type: 'payment.updated',
      entityKind: 'payment',
      entityId: 'pay-1',
      raw: { data: { object: { payment: { total_money: { amount: 999999 } } } } },
    },
    { eventId: 'e4', type: 'payout.updated', entityKind: 'payout', entityId: 'po-1', raw: {} },
    { eventId: 'e5', type: 'dispute.updated', entityKind: 'unknown', entityId: 'd-1', raw: {} },
    { eventId: 'e6', type: 'payment.updated', entityKind: 'payment', entityId: 'pay-gone', raw: {} },
  ];

  it('re-fetches canonical rows, dedupes, and skips the rest with reasons', async () => {
    const fetchers = {
      getOrder: async (id: string) =>
        id === 'ord-1'
          ? {
              id: 'ord-1',
              closedAt: '2026-10-14T10:05:00Z',
              totalMoney: { amount: 1130, currency: 'CAD' },
              totalTaxMoney: { amount: 130, currency: 'CAD' },
            }
          : null,
      getPayment: async (id: string) =>
        id === 'pay-1'
          ? {
              id: 'pay-1',
              createdAt: '2026-10-14T11:00:00Z',
              totalMoney: { amount: 2000, currency: 'CAD' },
              processingFee: [{ type: 'INITIAL', amountMoney: { amount: 60, currency: 'CAD' } }],
            }
          : null,
    };
    const { records, skipped } = await backfillSalesFromEvents(events, fetchers);

    // Canonical values win — the event payload's 999999 never leaks in.
    const byExt = new Map(records.map((r) => [r.externalId, r]));
    expect(byExt.get('order:ord-1')?.grossCents).toBe(1000);
    expect(byExt.get('payment:pay-1')?.grossCents).toBe(2000);
    expect(byExt.get('payment:pay-1')?.netCents).toBe(1940);
    expect(records).toHaveLength(2); // deduped

    const reasons = new Map(skipped.map((s) => [s.eventId, s.reason]));
    expect(reasons.get('e4')).toBe('payout-requires-entries');
    expect(reasons.get('e5')).toBe('unknown-entity-kind');
    expect(reasons.get('e6')).toBe('canonical-row-missing');
  });

  it('resolves order payments through getOrderPayments when provided', async () => {
    const fetchers = {
      getOrder: async () => ({
        id: 'ord-2',
        closedAt: '2026-10-14T10:05:00Z',
        totalMoney: { amount: 1000, currency: 'CAD' },
        totalTaxMoney: { amount: 0, currency: 'CAD' },
      }),
      getPayment: async () => null,
    };
    const { records } = await backfillSalesFromEvents(
      [{ eventId: 'e1', type: 'order.updated', entityKind: 'order', entityId: 'ord-2', raw: {} }],
      fetchers,
      {
        getOrderPayments: async () => [
          { id: 'p', totalMoney: { amount: 1000, currency: 'CAD' }, processingFee: [{ type: 'INITIAL', amountMoney: { amount: 29, currency: 'CAD' } }] },
        ],
      }
    );
    expect(records[0]?.feeCents).toBe(29);
  });
});
