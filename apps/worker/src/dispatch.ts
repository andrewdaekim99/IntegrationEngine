import type { Logger, SyncJobPayload } from '@integr8/core';
import { PrismaClient } from '@integr8/db';
import type { Queue, QueueJob } from '@integr8/queue';
import { processEvent, type DestinationSpec } from './process-event.js';
import { backoffDelayMs, shouldRetry, type RetryPolicy } from './retry-policy.js';

export interface DispatchDeps {
  prisma: PrismaClient;
  queue: Queue<SyncJobPayload>;
  destinations: DestinationSpec[];
  retryPolicy: RetryPolicy;
  logger: Logger;
}

export type DispatchResult =
  | { kind: 'SUCCEEDED' }
  | { kind: 'DEDUPED' }
  | { kind: 'RETRYING'; nextDelayMs: number }
  | { kind: 'DEAD_LETTERED'; error: string };

/**
 * The reliability core. Phase 7: per-destination fan-out happens inside
 * `processEvent`, which writes one SyncRun per destination with per-destination
 * dedupe. The dispatcher just routes on the aggregate outcome:
 *
 *   - SUCCEEDED / DEDUPED → mark any open DeadLetterItem resolved; ack.
 *   - RETRYABLE_FAILURE + retries left → nack with exponential backoff;
 *     event status → RETRYING.
 *   - TERMINAL_FAILURE or retries exhausted → write/refresh DeadLetterItem,
 *     event status → DEAD_LETTERED, ack.
 *
 * NOTE: we do NOT call `queue.moveToDLQ` operationally. The `DeadLetterItem`
 * table in Postgres is the source of truth for the dashboard and the manual
 * replay endpoint; the queue's DLQ is just there for the conformance suite.
 * Acking on DLQ keeps the active queue clean.
 *
 * The Phase 4 single-destination top-level dedupe is gone — per-destination
 * dedupe inside `processEvent` is strictly more accurate (won't skip a stripe
 * retry just because mock-erp already succeeded).
 */
export async function dispatch(
  deps: DispatchDeps,
  job: QueueJob<SyncJobPayload>,
): Promise<DispatchResult> {
  const { prisma, queue, destinations, retryPolicy } = deps;
  const log = deps.logger.child({
    jobId: job.id,
    eventId: job.payload.eventId,
    attempt: job.attempt,
  });

  const result = await processEvent({
    prisma,
    destinations,
    eventId: job.payload.eventId,
    attempt: job.attempt,
    log,
  });

  if (result.kind === 'NOT_FOUND') {
    log.error('event not found in DB; acking to prevent loop');
    await queue.ack(job.id);
    return { kind: 'DEAD_LETTERED', error: `event ${job.payload.eventId} not found` };
  }

  if (result.kind === 'SUCCEEDED' || result.kind === 'DEDUPED') {
    await prisma.deadLetterItem.updateMany({
      where: { eventId: job.payload.eventId, resolvedAt: null },
      data: { resolvedAt: new Date() },
    });
    await queue.ack(job.id);
    return { kind: result.kind };
  }

  if (result.kind === 'RETRYABLE_FAILURE' && shouldRetry(job.attempt, retryPolicy)) {
    const delayMs = backoffDelayMs(job.attempt, retryPolicy);
    await prisma.ingestedEvent.update({
      where: { id: job.payload.eventId },
      data: { status: 'RETRYING' },
    });
    log.info({ delayMs, nextAttempt: job.attempt + 1 }, 'scheduling retry');
    await queue.nack(job.id, { retryAfterMs: delayMs });
    return { kind: 'RETRYING', nextDelayMs: delayMs };
  }

  // Terminal OR retries exhausted.
  log.warn(
    { err: result.error, kind: result.kind, attempts: job.attempt },
    'routing to DLQ',
  );
  await routeToDeadLetter({
    prisma,
    eventId: job.payload.eventId,
    error: result.error,
    attempts: job.attempt,
  });
  await queue.ack(job.id);
  return { kind: 'DEAD_LETTERED', error: result.error };
}

async function routeToDeadLetter(opts: {
  prisma: PrismaClient;
  eventId: string;
  error: string;
  attempts: number;
}): Promise<void> {
  const { prisma, eventId, error, attempts } = opts;

  const existing = await prisma.deadLetterItem.findUnique({ where: { eventId } });
  if (!existing) {
    await prisma.deadLetterItem.create({
      data: { eventId, lastError: error, attempts },
    });
  } else if (existing.resolvedAt) {
    await prisma.deadLetterItem.update({
      where: { eventId },
      data: { lastError: error, attempts, resolvedAt: null, createdAt: new Date() },
    });
  } else {
    await prisma.deadLetterItem.update({
      where: { eventId },
      data: { lastError: error, attempts },
    });
  }

  await prisma.ingestedEvent.update({
    where: { id: eventId },
    data: { status: 'DEAD_LETTERED', processedAt: new Date() },
  });
}
