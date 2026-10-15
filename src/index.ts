/**
 * Public exports for `@clocklobster/square-tx-import`.
 *
 * The ops script (`scripts/provision-webhooks.mjs`) is intentionally NOT
 * re-exported here — it is run by operators, never bundled into consumers.
 */

export type {
  SalesRecord,
  SquareMoneyLike,
  SquareOrderRow,
  SquareProcessingFeeLike,
  SquarePaymentRow,
  SquarePayoutRow,
  SquarePayoutEntryRow,
} from './types.js';

export {
  AdaptError,
  PayoutMismatchError,
  moneyToCents,
  pickCurrency,
  sumProcessingFees,
  sumRefunded,
  buildSalesRecord,
  checkRecordInvariant,
  fromOrderWithPayments,
  fromPaymentOnly,
  reconcilePayoutEntries,
  assertPayoutEntriesBalanced,
  type AdaptOptions,
  type PayoutReconciliation,
} from './adapter.js';

export {
  SUPPORTED_SALES_WEBHOOK_EVENTS,
  SIGNATURE_KEY_ROTATION_DAYS,
  isSupportedSalesEvent,
  verifySquareWebhook,
  parseSquareWebhookEvent,
  webhookRefreshTarget,
  isSignatureKeyStale,
  type SupportedSalesWebhookEvent,
  type VerifySquareWebhookArgs,
  type SquareWebhookEvent,
  type CanonicalRef,
} from './webhooks.js';

export {
  listAllOrders,
  listAllPayments,
  listAllPayoutEntries,
  importSalesWindow,
  type OrdersSearchPort,
  type PaymentsListPort,
  type PayoutEntriesPort,
  type SalesWindowQuery,
} from './poll.js';

export {
  EVENTS_RETENTION_DAYS,
  BACKFILL_EVENT_TYPES,
  EventsRetentionError,
  assertWithinRetention,
  collectBackfillEvents,
  backfillSalesFromEvents,
  type BackfillEvent,
  type EventsSearchPort,
  type CanonicalFetchers,
  type BackfillResult,
} from './events-backfill.js';
