/** The BullMQ queue name shared by the API (enqueue) and the worker (consume). */
export const SYNC_QUEUE_NAME = 'integr8-sync-events';

/**
 * Job payload on the sync queue. We only enqueue the IngestedEvent id; the
 * worker loads the row to read the raw payload. Keeping the job small avoids
 * Redis bloat and means the payload-of-record is always the DB, not the queue.
 */
export interface SyncJobPayload {
  eventId: string;
}

/** Source system identifier. Used as `IngestedEvent.source`. */
export const SHOPIFY_SOURCE = 'shopify';

/** Webhook topic for Shopify order creation events. */
export const SHOPIFY_ORDERS_CREATE_TOPIC = 'orders/create';
