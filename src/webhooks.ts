/**
 * Webhook verification for Square sales events.
 *
 * Square signs each delivery with HMAC-SHA256: the signature key (from the
 * Developer Dashboard for the webhook subscription) keyed over
 * `notificationUrl + rawRequestBody`, base64-encoded, sent in the
 * `x-square-hmacsha256-signature` header. This mirrors the semantics of the
 * `square@46` SDK's `WebhooksHelper.verifySignature` as a dependency-free
 * synchronous function.
 *
 * Webhooks are a **freshness signal only**: a verified event tells the
 * importer *something changed* — the importer must re-fetch the canonical
 * Order/Payment/Payout via the API and adapt that. Never book ledger entries
 * from the event payload alone (payloads are point-in-time snapshots and can
 * arrive out of order or duplicated).
 *
 * Covered event types: `payment.updated`, `refund.updated`, `payout.updated`.
 *
 * Signature-key rotation: rotate the subscription signature key at least every
 * **90 days** (`updateSignatureKey` on the Webhook Subscriptions API, or the
 * ops script's `--rotate-key` flag). {@link isSignatureKeyStale} computes the
 * rotation deadline from the key's creation timestamp.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

/** Sales events this package treats as import freshness signals. */
export const SUPPORTED_SALES_WEBHOOK_EVENTS = [
  'payment.updated',
  'refund.updated',
  'payout.updated',
] as const;

export type SupportedSalesWebhookEvent = (typeof SUPPORTED_SALES_WEBHOOK_EVENTS)[number];

/** Rotation deadline for webhook signature keys, in days. */
export const SIGNATURE_KEY_ROTATION_DAYS = 90;

/** True when `type` is one of the supported sales freshness signals. */
export function isSupportedSalesEvent(type: string | null | undefined): type is SupportedSalesWebhookEvent {
  return (
    type === 'payment.updated' || type === 'refund.updated' || type === 'payout.updated'
  );
}

export interface VerifySquareWebhookArgs {
  /** Raw request body string, exactly as received (before JSON.parse). */
  requestBody: string;
  /** Value of the `x-square-hmacsha256-signature` header. */
  signatureHeader: string;
  /** Signature key from the Developer Dashboard for this subscription. */
  signatureKey: string;
  /** Notification URL configured on the subscription (must match exactly). */
  notificationUrl: string;
}

/**
 * Verify a Square webhook delivery. Returns true only when the HMAC matches;
 * on mismatch (or missing inputs) returns false — the caller must discard the
 * request. Never logs the key or the expected digest.
 */
export function verifySquareWebhook(args: VerifySquareWebhookArgs): boolean {
  const { requestBody, signatureHeader, signatureKey, notificationUrl } = args;
  if (!requestBody || !signatureHeader || !signatureKey || !notificationUrl) return false;
  let expected: string;
  try {
    expected = createHmac('sha256', signatureKey)
      .update(notificationUrl + requestBody, 'utf8')
      .digest('base64');
  } catch {
    return false;
  }
  const actualBytes = Buffer.from(signatureHeader, 'utf8');
  const expectedBytes = Buffer.from(expected, 'utf8');
  if (actualBytes.length !== expectedBytes.length) return false;
  try {
    return timingSafeEqual(actualBytes, expectedBytes);
  } catch {
    return false;
  }
}

/** Parsed Square webhook envelope (v2 shape). */
export interface SquareWebhookEvent {
  /** e.g. `payment.updated`. Null when the body is not parseable. */
  type: string | null;
  eventId: string | null;
  merchantId: string | null;
  locationId: string | null;
  createdAt: string | null;
  /** Inner `data.type` (e.g. `payment`, `refund`, `payout`, `order`). */
  dataType: string | null;
  /** Inner `data.id` — the entity to re-fetch canonically. */
  dataId: string | null;
  raw: Record<string, unknown>;
}

/** Parse the webhook envelope; never throws. */
export function parseSquareWebhookEvent(rawBody: string): SquareWebhookEvent {
  const empty: SquareWebhookEvent = {
    type: null,
    eventId: null,
    merchantId: null,
    locationId: null,
    createdAt: null,
    dataType: null,
    dataId: null,
    raw: {},
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return empty;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return empty;
  const record = parsed as Record<string, unknown>;
  const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
  const data =
    record.data && typeof record.data === 'object' && !Array.isArray(record.data)
      ? (record.data as Record<string, unknown>)
      : null;
  // `data.object` carries the snapshot — its id confirms the entity; location
  // may live on the nested object when the envelope omits it.
  const nested =
    data?.object && typeof data.object === 'object' && !Array.isArray(data.object)
      ? (data.object as Record<string, unknown>)
      : null;
  return {
    type: str(record.type),
    eventId: str(record.event_id),
    merchantId: str(record.merchant_id),
    locationId: str(record.location_id) ?? str(nested?.location_id),
    createdAt: str(record.created_at),
    dataType: data ? str(data.type) : null,
    dataId: data ? str(data.id) : null,
    raw: record,
  };
}

/** Canonical re-fetch target derived from a verified event. */
export type CanonicalRef =
  | { kind: 'payment'; id: string }
  | { kind: 'order'; id: string }
  | { kind: 'payout'; id: string }
  | { kind: 'unknown'; id: null };

/**
 * Map a parsed event to the canonical record to re-fetch.
 *
 * `refund.updated` carries the *refund* id — the importer should fetch the
 * refund's parent payment (or the refund) via the API and adapt the canonical
 * payment row, never the event snapshot. `order` snapshots (delivered by some
 * subscriptions alongside payments) map to an order re-fetch.
 */
export function webhookRefreshTarget(event: SquareWebhookEvent): CanonicalRef {
  if (!event.dataId) return { kind: 'unknown', id: null };
  switch (event.dataType) {
    case 'payment':
      return { kind: 'payment', id: event.dataId };
    case 'refund':
      // Refund id; the caller resolves the parent payment via the Refunds API.
      return { kind: 'payment', id: event.dataId };
    case 'payout':
      return { kind: 'payout', id: event.dataId };
    case 'order':
      return { kind: 'order', id: event.dataId };
    default:
      return { kind: 'unknown', id: null };
  }
}

/**
 * True when the signature key is past its rotation deadline.
 *
 * @param keyCreatedAtMs - when the current signature key was created (epoch ms)
 * @param nowMs - current time (injectable for tests)
 * @param rotationDays - rotation deadline window (default 90)
 */
export function isSignatureKeyStale(
  keyCreatedAtMs: number,
  nowMs: number = Date.now(),
  rotationDays: number = SIGNATURE_KEY_ROTATION_DAYS
): boolean {
  if (!Number.isFinite(keyCreatedAtMs) || !Number.isFinite(nowMs)) return true;
  return nowMs - keyCreatedAtMs > rotationDays * 24 * 60 * 60 * 1000;
}
