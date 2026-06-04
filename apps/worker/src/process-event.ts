import {
  applyMapping,
  mappingSpecSchema,
  SHOPIFY_SOURCE,
  type Logger,
} from '@integr8/core';
import { PrismaClient } from '@integr8/db';
import {
  type DestinationConnector,
  type MockErpOrderInput,
  shopifyOrderSchema,
} from '@integr8/connectors';
import { mapShopifyOrderToMockErp } from './mapping.js';

const MOCK_ERP_DESTINATION = 'mock-erp';

export type ProcessOutcome =
  | { kind: 'SUCCEEDED' }
  | { kind: 'NOT_FOUND' }
  | { kind: 'RETRYABLE_FAILURE'; error: string }
  | { kind: 'TERMINAL_FAILURE'; error: string };

export interface ProcessEventOptions {
  prisma: PrismaClient;
  destination: DestinationConnector<MockErpOrderInput>;
  destinationName?: string;
  eventId: string;
  attempt: number;
  log: Logger;
}

/**
 * Pipeline: load the persisted IngestedEvent, mark PROCESSING, re-parse the
 * payload, map to the destination shape, deliver, write a SyncRun row.
 *
 * Updates `IngestedEvent.status` to `SUCCEEDED` on success only. On any
 * failure, the SyncRun row is written but the event status is left for the
 * dispatcher to set — `RETRYING` (will be retried) or `DEAD_LETTERED`
 * (terminal / out of retries).
 */
export async function processEvent(opts: ProcessEventOptions): Promise<ProcessOutcome> {
  const { prisma, destination, eventId, attempt, log } = opts;
  const destinationName = opts.destinationName ?? destination.name;

  const event = await prisma.ingestedEvent.findUnique({ where: { id: eventId } });
  if (!event) {
    log.error({ eventId }, 'event not found');
    return { kind: 'NOT_FOUND' };
  }

  await prisma.ingestedEvent.update({
    where: { id: eventId },
    data: { status: 'PROCESSING' },
  });

  const syncRun = await prisma.syncRun.create({
    data: {
      eventId,
      destination: destinationName,
      attempt,
      outcome: 'PENDING',
    },
  });
  const runLog = log.child({ runId: syncRun.id });

  const parsed = shopifyOrderSchema.safeParse(event.rawPayload);
  if (!parsed.success) {
    const error = `stored payload doesn't match Shopify schema: ${parsed.error.message}`;
    runLog.error({ err: error }, 'payload re-parse failed');
    await prisma.syncRun.update({
      where: { id: syncRun.id },
      data: { outcome: 'TERMINAL_FAILURE', finishedAt: new Date(), errorMessage: error },
    });
    return { kind: 'TERMINAL_FAILURE', error };
  }

  const mockErpInput = await resolveMockErpInput({
    prisma,
    shopifyOrder: parsed.data,
    log: runLog,
  });
  const idempotencyKey = `event-${eventId}`;
  runLog.info({ idempotencyKey, destinationName }, 'delivering');

  const result = await destination.deliver(mockErpInput, idempotencyKey);

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
  await prisma.syncRun.update({
    where: { id: syncRun.id },
    data: {
      outcome: outcomeKind,
      finishedAt: new Date(),
      errorMessage: result.error.message,
    },
  });
  // Event status intentionally left for the dispatcher to set.
  return { kind: outcomeKind, error: result.error.message };
}

/**
 * Phase 6: prefer the active MappingConfig for (shopify, mock-erp) over the
 * hardcoded mapper. Falls back if no config is approved or if the stored spec
 * fails validation — so an AI-produced mapping never silently breaks deliveries.
 */
async function resolveMockErpInput(opts: {
  prisma: PrismaClient;
  shopifyOrder: Parameters<typeof mapShopifyOrderToMockErp>[0];
  log: Logger;
}): Promise<MockErpOrderInput> {
  const { prisma, shopifyOrder, log } = opts;

  const config = await prisma.mappingConfig.findFirst({
    where: {
      sourceSystem: SHOPIFY_SOURCE,
      destinationSystem: MOCK_ERP_DESTINATION,
      isActive: true,
    },
    orderBy: { version: 'desc' },
  });

  if (!config) {
    log.debug('no active MappingConfig — using hardcoded mapper');
    return mapShopifyOrderToMockErp(shopifyOrder);
  }

  const specResult = mappingSpecSchema.safeParse(config.fields);
  if (!specResult.success) {
    log.warn(
      { mappingConfigId: config.id, err: specResult.error.message },
      'active MappingConfig.fields failed validation — falling back to hardcoded mapper',
    );
    return mapShopifyOrderToMockErp(shopifyOrder);
  }

  log.info(
    { mappingConfigId: config.id, version: config.version },
    'applying AI-approved mapping',
  );
  // The MappingSpec output is structurally unconstrained; trust the operator's
  // approval (and let the connector + retry/DLQ layer catch any shape errors).
  return applyMapping(shopifyOrder, specResult.data) as unknown as MockErpOrderInput;
}
