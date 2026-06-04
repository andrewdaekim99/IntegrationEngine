import {
  applyMapping,
  mappingSpecSchema,
  SHOPIFY_SOURCE,
  type Logger,
} from '@integr8/core';
import { PrismaClient } from '@integr8/db';
import {
  type DestinationConnector,
  shopifyOrderSchema,
  type ShopifyOrder,
} from '@integr8/connectors';

/**
 * Per-destination configuration the worker fans an event out to. The connector
 * does the delivery; `hardcodedMapper` is the fallback used when no active
 * `MappingConfig` exists for `(SHOPIFY_SOURCE, name)`.
 */
export interface DestinationSpec {
  name: string;
  connector: DestinationConnector<unknown>;
  hardcodedMapper: (order: ShopifyOrder) => unknown;
}

export type ProcessOutcome =
  | { kind: 'SUCCEEDED' }
  | { kind: 'DEDUPED' }
  | { kind: 'NOT_FOUND' }
  | { kind: 'RETRYABLE_FAILURE'; error: string }
  | { kind: 'TERMINAL_FAILURE'; error: string };

export interface ProcessEventOptions {
  prisma: PrismaClient;
  destinations: DestinationSpec[];
  eventId: string;
  attempt: number;
  log: Logger;
}

/**
 * Phase 7 pipeline. Loads the event, re-parses the payload, fans out to every
 * configured destination (each gets its own SyncRun + per-destination dedupe),
 * then aggregates a single `ProcessOutcome` the dispatcher routes on:
 *   - all destinations SUCCEEDED or DEDUPED → SUCCEEDED (DEDUPED only when
 *     every destination was deduped — useful for the dispatcher's bookkeeping).
 *   - any TERMINAL_FAILURE → TERMINAL_FAILURE (whole event goes to DLQ; replay
 *     re-runs each destination, but per-destination dedupe skips ones that
 *     already succeeded).
 *   - else (only RETRYABLE failures) → RETRYABLE_FAILURE.
 *
 * `IngestedEvent.status` is updated to SUCCEEDED on the all-ok path; the
 * dispatcher owns transitions to RETRYING / DEAD_LETTERED.
 */
export async function processEvent(opts: ProcessEventOptions): Promise<ProcessOutcome> {
  const { prisma, destinations, eventId, attempt, log } = opts;

  const event = await prisma.ingestedEvent.findUnique({ where: { id: eventId } });
  if (!event) {
    log.error({ eventId }, 'event not found');
    return { kind: 'NOT_FOUND' };
  }

  await prisma.ingestedEvent.update({
    where: { id: eventId },
    data: { status: 'PROCESSING' },
  });

  const parsed = shopifyOrderSchema.safeParse(event.rawPayload);
  if (!parsed.success) {
    const error = `stored payload doesn't match Shopify schema: ${parsed.error.message}`;
    log.error({ err: error }, 'payload re-parse failed');
    return { kind: 'TERMINAL_FAILURE', error };
  }
  const order = parsed.data;

  const perDest: Array<{ name: string; outcome: ProcessOutcome }> = [];
  for (const dest of destinations) {
    const outcome = await deliverToDestination({
      prisma,
      dest,
      order,
      eventId,
      attempt,
      log,
    });
    perDest.push({ name: dest.name, outcome });
  }

  const allDeduped =
    perDest.length > 0 && perDest.every((r) => r.outcome.kind === 'DEDUPED');
  const allOk = perDest.every(
    (r) => r.outcome.kind === 'SUCCEEDED' || r.outcome.kind === 'DEDUPED',
  );

  if (allOk) {
    await prisma.ingestedEvent.update({
      where: { id: eventId },
      data: { status: 'SUCCEEDED', processedAt: new Date() },
    });
    return allDeduped ? { kind: 'DEDUPED' } : { kind: 'SUCCEEDED' };
  }

  const anyTerminal = perDest.some((r) => r.outcome.kind === 'TERMINAL_FAILURE');
  const errors = perDest
    .filter(
      (r) =>
        r.outcome.kind === 'TERMINAL_FAILURE' || r.outcome.kind === 'RETRYABLE_FAILURE',
    )
    .map((r) => {
      const o = r.outcome as { error: string };
      return `${r.name}: ${o.error}`;
    })
    .join('; ');

  if (anyTerminal) return { kind: 'TERMINAL_FAILURE', error: errors };
  return { kind: 'RETRYABLE_FAILURE', error: errors };
}

async function deliverToDestination(opts: {
  prisma: PrismaClient;
  dest: DestinationSpec;
  order: ShopifyOrder;
  eventId: string;
  attempt: number;
  log: Logger;
}): Promise<ProcessOutcome> {
  const { prisma, dest, order, eventId, attempt, log } = opts;
  const destLog = log.child({ destination: dest.name });

  // Per-destination dedupe.
  const priorSuccess = await prisma.syncRun.findFirst({
    where: { eventId, outcome: 'SUCCEEDED', destination: dest.name },
  });
  if (priorSuccess) {
    destLog.info({ priorRunId: priorSuccess.id }, 'already succeeded — deduping');
    await prisma.syncRun.create({
      data: {
        eventId,
        destination: dest.name,
        attempt,
        outcome: 'DEDUPED',
        finishedAt: new Date(),
      },
    });
    return { kind: 'DEDUPED' };
  }

  const syncRun = await prisma.syncRun.create({
    data: { eventId, destination: dest.name, attempt, outcome: 'PENDING' },
  });
  const runLog = destLog.child({ runId: syncRun.id });

  const mappingConfig = await prisma.mappingConfig.findFirst({
    where: {
      sourceSystem: SHOPIFY_SOURCE,
      destinationSystem: dest.name,
      isActive: true,
    },
    orderBy: { version: 'desc' },
  });

  let input: unknown;
  if (mappingConfig) {
    const specResult = mappingSpecSchema.safeParse(mappingConfig.fields);
    if (specResult.success) {
      runLog.info(
        { mappingConfigId: mappingConfig.id, version: mappingConfig.version },
        'applying AI-approved mapping',
      );
      input = applyMapping(order, specResult.data);
    } else {
      runLog.warn(
        { mappingConfigId: mappingConfig.id, err: specResult.error.message },
        'active MappingConfig.fields failed validation — using hardcoded mapper',
      );
      input = dest.hardcodedMapper(order);
    }
  } else {
    runLog.debug('no active MappingConfig — using hardcoded mapper');
    try {
      input = dest.hardcodedMapper(order);
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      runLog.error({ err: error }, 'hardcoded mapper threw');
      await prisma.syncRun.update({
        where: { id: syncRun.id },
        data: { outcome: 'TERMINAL_FAILURE', finishedAt: new Date(), errorMessage: error },
      });
      return { kind: 'TERMINAL_FAILURE', error };
    }
  }

  const idempotencyKey = `event-${eventId}`;
  runLog.info({ idempotencyKey }, 'delivering');

  const result = await dest.connector.deliver(input, idempotencyKey);

  if (result.ok) {
    runLog.info('delivery succeeded');
    await prisma.syncRun.update({
      where: { id: syncRun.id },
      data: { outcome: 'SUCCEEDED', finishedAt: new Date() },
    });
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
  return { kind: outcomeKind, error: result.error.message };
}
