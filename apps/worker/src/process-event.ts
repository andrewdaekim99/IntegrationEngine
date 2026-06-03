import type { Logger } from '@integr8/core';
import { PrismaClient } from '@integr8/db';
import {
  MockErpDestinationConnector,
  shopifyOrderSchema,
} from '@integr8/connectors';
import { mapShopifyOrderToMockErp } from './mapping.js';

export type ProcessOutcome =
  | { kind: 'SUCCEEDED' }
  | { kind: 'RETRYABLE_FAILURE'; error: string }
  | { kind: 'TERMINAL_FAILURE'; error: string };

export interface ProcessEventOptions {
  prisma: PrismaClient;
  mockErp: MockErpDestinationConnector;
  eventId: string;
  attempt: number;
  log: Logger;
}

/**
 * Phase 3 pipeline: load the persisted IngestedEvent, re-parse the payload,
 * map to the MockErp shape, deliver, record a SyncRun, update event status.
 *
 * No retry / DLQ routing here — Phase 4 wraps this with proper reliability
 * semantics. For now every outcome ends in a row; failures mark the event
 * DEAD_LETTERED so it's visible but not retried.
 */
export async function processEvent(opts: ProcessEventOptions): Promise<ProcessOutcome> {
  const { prisma, mockErp, eventId, attempt } = opts;
  const log = opts.log;

  const event = await prisma.ingestedEvent.findUnique({ where: { id: eventId } });
  if (!event) {
    log.error({ eventId }, 'event not found');
    return { kind: 'TERMINAL_FAILURE', error: `event ${eventId} not found` };
  }

  await prisma.ingestedEvent.update({
    where: { id: eventId },
    data: { status: 'PROCESSING' },
  });

  const syncRun = await prisma.syncRun.create({
    data: {
      eventId,
      destination: 'mock-erp',
      attempt,
      outcome: 'PENDING',
    },
  });
  const runLog = log.child({ runId: syncRun.id });

  const parsed = shopifyOrderSchema.safeParse(event.rawPayload);
  if (!parsed.success) {
    const error = `stored payload doesn't match Shopify schema: ${parsed.error.message}`;
    runLog.error({ err: error }, 'payload re-parse failed');
    await Promise.all([
      prisma.syncRun.update({
        where: { id: syncRun.id },
        data: { outcome: 'TERMINAL_FAILURE', finishedAt: new Date(), errorMessage: error },
      }),
      prisma.ingestedEvent.update({
        where: { id: eventId },
        data: { status: 'DEAD_LETTERED', processedAt: new Date() },
      }),
    ]);
    return { kind: 'TERMINAL_FAILURE', error };
  }

  const mockErpInput = mapShopifyOrderToMockErp(parsed.data);
  const idempotencyKey = `event-${eventId}`;
  runLog.info({ idempotencyKey }, 'delivering to mock-erp');

  const result = await mockErp.deliver(mockErpInput, idempotencyKey);

  if (result.ok) {
    runLog.info('delivery succeeded');
    await Promise.all([
      prisma.syncRun.update({
        where: { id: syncRun.id },
        data: { outcome: 'SUCCEEDED', finishedAt: new Date() },
      }),
      prisma.ingestedEvent.update({
        where: { id: eventId },
        data: { status: 'SUCCEEDED', processedAt: new Date() },
      }),
    ]);
    return { kind: 'SUCCEEDED' };
  }

  const outcomeKind = result.error.retryable ? 'RETRYABLE_FAILURE' : 'TERMINAL_FAILURE';
  runLog.warn(
    { err: result.error.message, retryable: result.error.retryable },
    'delivery failed',
  );
  await Promise.all([
    prisma.syncRun.update({
      where: { id: syncRun.id },
      data: {
        outcome: outcomeKind,
        finishedAt: new Date(),
        errorMessage: result.error.message,
      },
    }),
    prisma.ingestedEvent.update({
      where: { id: eventId },
      data: { status: 'DEAD_LETTERED', processedAt: new Date() },
    }),
  ]);
  return { kind: outcomeKind, error: result.error.message };
}
