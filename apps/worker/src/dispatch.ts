import type { Logger, SyncJobPayload } from '@integr8/core';
import { PrismaClient } from '@integr8/db';
import type { DestinationConnector, MockErpOrderInput } from '@integr8/connectors';
import type { Queue, QueueJob } from '@integr8/queue';
import { processEvent } from './process-event.js';
import { backoffDelayMs, shouldRetry, type RetryPolicy } from './retry-policy.js';

export interface DispatchDeps {
  prisma: PrismaClient;
  queue: Queue<SyncJobPayload>;
  destination: DestinationConnector<MockErpOrderInput>;
  /** Override the recorded `SyncRun.destination` value. Defaults to `destination.name`. */
  destinationName?: string;
  retryPolicy: RetryPolicy;
  logger: Logger;
}

export type DispatchResult =
  | { kind: 'SUCCEEDED' }
  | { kind: 'DEDUPED' }
  | { kind: 'RETRYING'; nextDelayMs: number }
  | { kind: 'DEAD_LETTERED'; error: string };

/**
 * The reliability core. Called for each job pulled off the queue:
 *
 *   1. Dedupe: if this eventId already has a SUCCEEDED SyncRun, record a
 *      DEDUPED row and ack. Catches at-least-once re-deliveries and accidental
 *      double-enqueues from the API.
 *   2. Process: run `processEvent` to talk to the destination.
 *   3. Route:
 *      - SUCCEEDED → ack; mark any open DeadLetterItem resolved (replay path).
 *      - RETRYABLE_FAILURE + retries left → nack with exponential backoff;
 *        event status → RETRYING.
 *      - TERMINAL_FAILURE or RETRYABLE_FAILURE + retries exhausted →
 *        write/refresh DeadLetterItem, event status → DEAD_LETTERED, ack.
 *
 * NOTE: we do NOT call `queue.moveToDLQ` operationally. The
 * `DeadLetterItem` table in Postgres is the source of truth for the dashboard
 * and the manual replay endpoint; the queue's DLQ is just there for the
 * conformance suite. Acking on DLQ keeps the active queue clean.
 */
export async function dispatch(
  deps: DispatchDeps,
  job: QueueJob<SyncJobPayload>,
): Promise<DispatchResult> {
  const { prisma, queue, destination, retryPolicy } = deps;
  const destinationName = deps.destinationName ?? destination.name;
  const log = deps.logger.child({
    jobId: job.id,
    eventId: job.payload.eventId,
    attempt: job.attempt,
  });

  // 1. Consumer-side dedupe by prior success.
  const priorSuccess = await prisma.syncRun.findFirst({
    where: { eventId: job.payload.eventId, outcome: 'SUCCEEDED' },
  });
  if (priorSuccess) {
    log.info({ priorRunId: priorSuccess.id }, 'event already succeeded — deduping');
    await prisma.syncRun.create({
      data: {
        eventId: job.payload.eventId,
        destination: destinationName,
        attempt: job.attempt,
        outcome: 'DEDUPED',
        finishedAt: new Date(),
      },
    });
    await queue.ack(job.id);
    return { kind: 'DEDUPED' };
  }

  // 2. Process.
  const result = await processEvent({
    prisma,
    destination,
    destinationName,
    eventId: job.payload.eventId,
    attempt: job.attempt,
    log,
  });

  // 3. Route.
  if (result.kind === 'NOT_FOUND') {
    log.error('event not found in DB; acking to prevent loop');
    await queue.ack(job.id);
    return { kind: 'DEAD_LETTERED', error: `event ${job.payload.eventId} not found` };
  }

  if (result.kind === 'SUCCEEDED') {
    // Replay path: mark any open DLQ row resolved.
    await prisma.deadLetterItem.updateMany({
      where: { eventId: job.payload.eventId, resolvedAt: null },
      data: { resolvedAt: new Date() },
    });
    await queue.ack(job.id);
    return { kind: 'SUCCEEDED' };
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
    // Reopen a previously-resolved DLQ item.
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
