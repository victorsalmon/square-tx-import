/**
 * Offline webhook-verification demo — no network, no credentials.
 * Run: node examples/verify-webhook.mjs
 */
import { createHmac } from 'node:crypto';

const signatureKey = 'demo-signature-key';
const notificationUrl = 'https://example.com/hooks/square';
const body = JSON.stringify({
  merchant_id: 'm-123',
  type: 'payment.updated',
  event_id: 'evt-1',
  created_at: '2026-10-15T12:00:00Z',
  data: { type: 'payment', id: 'pay-1', object: { payment: { id: 'pay-1' } } },
});

const signature = createHmac('sha256', signatureKey)
  .update(notificationUrl + body, 'utf8')
  .digest('base64');

// Built output — run `npm run build` first.
const { verifySquareWebhook, parseSquareWebhookEvent, webhookRefreshTarget } = await import(
  '../dist/index.js'
);

const ok = verifySquareWebhook({
  requestBody: body,
  signatureHeader: signature,
  signatureKey,
  notificationUrl,
});
console.log('valid signature verifies:', ok);
console.log(
  'tampered body verifies:',
  verifySquareWebhook({ requestBody: body + 'x', signatureHeader: signature, signatureKey, notificationUrl })
);

const event = parseSquareWebhookEvent(body);
console.log('parsed type:', event.type, '| refresh target:', webhookRefreshTarget(event));
