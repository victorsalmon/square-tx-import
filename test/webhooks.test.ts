import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  SIGNATURE_KEY_ROTATION_DAYS,
  isSignatureKeyStale,
  isSupportedSalesEvent,
  parseSquareWebhookEvent,
  verifySquareWebhook,
  webhookRefreshTarget,
} from '../src/index.js';

// Mirror of the Square signing algorithm: HMAC-SHA256(key, url + body), base64.
function sign(key: string, url: string, body: string): string {
  return createHmac('sha256', key).update(url + body, 'utf8').digest('base64');
}

const KEY = 'test-signature-key';
const URL = 'https://example.com/hooks/square';
const BODY = JSON.stringify({
  merchant_id: 'm-1',
  type: 'payment.updated',
  event_id: 'evt-1',
  created_at: '2026-10-15T12:00:00Z',
  data: { type: 'payment', id: 'pay-1', object: { payment: { id: 'pay-1' } } },
});

describe('verifySquareWebhook', () => {
  it('accepts a valid signature', () => {
    expect(
      verifySquareWebhook({ requestBody: BODY, signatureHeader: sign(KEY, URL, BODY), signatureKey: KEY, notificationUrl: URL })
    ).toBe(true);
  });

  it('rejects a tampered body', () => {
    const sig = sign(KEY, URL, BODY);
    expect(
      verifySquareWebhook({ requestBody: BODY + 'x', signatureHeader: sig, signatureKey: KEY, notificationUrl: URL })
    ).toBe(false);
  });

  it('rejects a wrong key', () => {
    const sig = sign(KEY, URL, BODY);
    expect(
      verifySquareWebhook({ requestBody: BODY, signatureHeader: sig, signatureKey: 'other', notificationUrl: URL })
    ).toBe(false);
  });

  it('rejects a mismatched notification URL (exact-match required)', () => {
    const sig = sign(KEY, URL, BODY);
    expect(
      verifySquareWebhook({ requestBody: BODY, signatureHeader: sig, signatureKey: KEY, notificationUrl: URL + '/' })
    ).toBe(false);
  });

  it('rejects missing inputs without throwing', () => {
    const sig = sign(KEY, URL, BODY);
    expect(verifySquareWebhook({ requestBody: '', signatureHeader: sig, signatureKey: KEY, notificationUrl: URL })).toBe(false);
    expect(verifySquareWebhook({ requestBody: BODY, signatureHeader: '', signatureKey: KEY, notificationUrl: URL })).toBe(false);
    expect(verifySquareWebhook({ requestBody: BODY, signatureHeader: sig, signatureKey: '', notificationUrl: URL })).toBe(false);
    expect(verifySquareWebhook({ requestBody: BODY, signatureHeader: sig, signatureKey: KEY, notificationUrl: '' })).toBe(false);
  });

  it('rejects a forged signature', () => {
    expect(
      verifySquareWebhook({ requestBody: BODY, signatureHeader: 'forged', signatureKey: KEY, notificationUrl: URL })
    ).toBe(false);
  });
});

describe('supported sales events', () => {
  it('allows payment/refund/payout updates only', () => {
    expect(isSupportedSalesEvent('payment.updated')).toBe(true);
    expect(isSupportedSalesEvent('refund.updated')).toBe(true);
    expect(isSupportedSalesEvent('payout.updated')).toBe(true);
    expect(isSupportedSalesEvent('order.updated')).toBe(false);
    expect(isSupportedSalesEvent('invoice.published')).toBe(false);
    expect(isSupportedSalesEvent(null)).toBe(false);
  });
});

describe('parseSquareWebhookEvent', () => {
  it('parses the envelope and nested entity', () => {
    const e = parseSquareWebhookEvent(BODY);
    expect(e.type).toBe('payment.updated');
    expect(e.eventId).toBe('evt-1');
    expect(e.merchantId).toBe('m-1');
    expect(e.dataType).toBe('payment');
    expect(e.dataId).toBe('pay-1');
  });

  it('returns nulls for invalid JSON', () => {
    const e = parseSquareWebhookEvent('not json');
    expect(e.type).toBeNull();
    expect(e.dataId).toBeNull();
  });
});

describe('webhookRefreshTarget', () => {
  it('maps payment/refund/payout/order snapshots to canonical re-fetches', () => {
    expect(webhookRefreshTarget(parseSquareWebhookEvent(BODY))).toEqual({ kind: 'payment', id: 'pay-1' });
    const refund = parseSquareWebhookEvent(
      JSON.stringify({ type: 'refund.updated', data: { type: 'refund', id: 'ref-1' } })
    );
    expect(webhookRefreshTarget(refund)).toEqual({ kind: 'payment', id: 'ref-1' });
    const payout = parseSquareWebhookEvent(
      JSON.stringify({ type: 'payout.updated', data: { type: 'payout', id: 'po-1' } })
    );
    expect(webhookRefreshTarget(payout)).toEqual({ kind: 'payout', id: 'po-1' });
  });

  it('returns unknown when the entity cannot be resolved', () => {
    expect(webhookRefreshTarget(parseSquareWebhookEvent('{}'))).toEqual({ kind: 'unknown', id: null });
  });
});

describe('signature-key rotation', () => {
  it('flags keys older than 90 days as stale', () => {
    expect(SIGNATURE_KEY_ROTATION_DAYS).toBe(90);
    const now = Date.parse('2026-10-15T00:00:00Z');
    const fresh = now - 89 * 24 * 60 * 60 * 1000;
    const stale = now - 91 * 24 * 60 * 60 * 1000;
    expect(isSignatureKeyStale(fresh, now)).toBe(false);
    expect(isSignatureKeyStale(stale, now)).toBe(true);
    expect(isSignatureKeyStale(Number.NaN, now)).toBe(true);
  });
});
