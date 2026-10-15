#!/usr/bin/env node
/**
 * Provision the app-owned Square webhook subscription (ops script, NOT runtime).
 *
 * The importer fan-out is per-seller in the importing application; Square only
 * ever sees ONE app-owned subscription pointing at our endpoint, carrying the
 * sales event types. This script lists existing subscriptions, creates the
 * subscription when missing, updates it when the URL or event types drift,
 * and fires a test delivery on request.
 *
 * Usage:
 *   SQUARE_ACCESS_TOKEN=... SQUARE_WEBHOOK_URL=https://example.com/hooks/square \
 *     node scripts/provision-webhooks.mjs [--test] [--rotate-key] [--dry-run]
 *
 * Env:
 *   SQUARE_ACCESS_TOKEN  (required) app token for the target environment
 *   SQUARE_WEBHOOK_URL   (required) https notification endpoint
 *   SQUARE_ENVIRONMENT   `production` (default) or `sandbox`
 *   SQUARE_SUBSCRIPTION_NAME  subscription name (default `square-tx-import`)
 *
 * Flags:
 *   --test        send a test event after create/update (default off)
 *   --rotate-key  rotate the subscription signature key (90-day rotation;
 *                 store the NEW key — the old one stops working immediately)
 *   --dry-run     print the planned create/update, change nothing
 *
 * Exit codes: 0 ok · 1 usage/config error · 2 Square API error.
 */

const WANT_EVENTS = ['payment.updated', 'refund.updated', 'payout.updated'];

const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has('--dry-run');
const WANT_TEST = args.has('--test');
const ROTATE_KEY = args.has('--rotate-key');

const token = process.env.SQUARE_ACCESS_TOKEN;
const notificationUrl = process.env.SQUARE_WEBHOOK_URL;
const environmentName = (process.env.SQUARE_ENVIRONMENT ?? 'production').toLowerCase();
const subscriptionName = process.env.SQUARE_SUBSCRIPTION_NAME ?? 'square-tx-import';

if (!token) {
  console.error('Missing SQUARE_ACCESS_TOKEN');
  process.exit(1);
}
if (!notificationUrl || !notificationUrl.startsWith('https://')) {
  console.error('Missing or non-https SQUARE_WEBHOOK_URL (Square requires https)');
  process.exit(1);
}
if (environmentName !== 'production' && environmentName !== 'sandbox') {
  console.error(`SQUARE_ENVIRONMENT must be 'production' or 'sandbox', got '${environmentName}'`);
  process.exit(1);
}

let SquareClient;
let SquareEnvironment;
try {
  ({ SquareClient, SquareEnvironment } = await import('square'));
} catch {
  console.error("The 'square' package is not installed. Run `npm install` first.");
  process.exit(1);
}

const client = new SquareClient({
  token,
  environment:
    environmentName === 'sandbox' ? SquareEnvironment.Sandbox : SquareEnvironment.Production,
});

const sameEventSet = (a = [], b = []) =>
  a.length === b.length && [...a].sort().join(',') === [...b].sort().join(',');

try {
  const listed = await client.webhooks.subscriptions.list();
  const existing = (listed.subscriptions ?? []).find((s) => s.name === subscriptionName);
  let subscription = existing;

  if (!existing) {
    console.log(`No subscription named '${subscriptionName}' — creating.`);
    if (DRY_RUN) {
      console.log(
        JSON.stringify(
          { action: 'create', name: subscriptionName, notificationUrl, eventTypes: WANT_EVENTS },
          null,
          2
        )
      );
    } else {
      const created = await client.webhooks.subscriptions.create({
        idempotencyKey: `square-tx-import-${Date.now()}`,
        subscription: {
          name: subscriptionName,
          notificationUrl,
          eventTypes: WANT_EVENTS,
          apiVersion: '2026-09-16',
        },
      });
      subscription = created.subscription;
      console.log(`Created subscription ${subscription?.id}`);
      console.log('Store this signature key (shown once per rotation):', subscription?.signatureKey);
    }
  } else if (existing.notificationUrl !== notificationUrl || !sameEventSet(existing.eventTypes, WANT_EVENTS)) {
    console.log(`Subscription ${existing.id} drifted — updating.`);
    console.log(`  url:    ${existing.notificationUrl} -> ${notificationUrl}`);
    console.log(`  events: ${(existing.eventTypes ?? []).join(',')} -> ${WANT_EVENTS.join(',')}`);
    if (DRY_RUN) {
      console.log(JSON.stringify({ action: 'update', id: existing.id }, null, 2));
    } else {
      const updated = await client.webhooks.subscriptions.update({
        subscriptionId: existing.id,
        subscription: { notificationUrl, eventTypes: WANT_EVENTS },
      });
      subscription = updated.subscription;
      console.log(`Updated subscription ${subscription?.id}`);
    }
  } else {
    console.log(`Subscription ${existing.id} already matches (url + event types).`);
  }

  if (ROTATE_KEY) {
    if (!subscription?.id) {
      console.error('--rotate-key needs an existing (non-dry-run) subscription id');
      process.exit(1);
    }
    if (DRY_RUN) {
      console.log(JSON.stringify({ action: 'rotate-key', id: subscription.id }, null, 2));
    } else {
      const rotated = await client.webhooks.subscriptions.updateSignatureKey({
        subscriptionId: subscription.id,
        idempotencyKey: `rotate-${Date.now()}`,
      });
      console.log('Rotated signature key. Store the NEW key (old one is dead):', rotated.subscription?.signatureKey);
    }
  }

  if (WANT_TEST) {
    if (!subscription?.id) {
      console.error('--test needs an existing (non-dry-run) subscription id');
      process.exit(1);
    }
    if (DRY_RUN) {
      console.log(JSON.stringify({ action: 'test', id: subscription.id }, null, 2));
    } else {
      await client.webhooks.subscriptions.test({
        subscriptionId: subscription.id,
        eventType: 'payment.updated',
      });
      console.log('Test event sent.');
    }
  }
} catch (err) {
  console.error('Square API error:', err?.message ?? err);
  process.exit(2);
}
