/**
 * Phase 4 reliability tests — the headline of the project.
 *
 * Cover the five scenarios from `ROADMAP.md` §Phase 4:
 *   1. Dedupe (same eventId twice → exactly one destination call)
 *   2. Retry with backoff up to the cap, then succeed
 *   3. Exhausted retries → DLQ
 *   4. Terminal failure → straight to DLQ, zero retries
 *   5. Replay re-runs the event and marks DLQ resolved on success
 *   6. Crash-then-redeliver still dedupes via SUCCEEDED SyncRun
 *
 * Run against real Postgres (host port 5433). Skip if DB is down.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  JobId,
  createLogger,
  err,
  ok,
  type Logger,
  type SyncJobPayload,
  UpstreamClientError,
  UpstreamServerError,
} from '@integr8/core';
import { PrismaClient } from '@integr8/db';
import {
  ControllableDestinationConnector,
  type MockErpOrderInput,
} from '@integr8/connectors';
import type { Queue, QueueJob } from '@integr8/queue';
import { dispatch } from '../dispatch.js';
import type { RetryPolicy } from '../retry-policy.js';

const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://integr8:integr8@localhost:5433/integr8?schema=public';

async function dbReachable(): Promise<boolean> {
  const probe = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
  try {
    await probe.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  } finally {
    await probe.$disconnect();
  }
}

const dbUp = await dbReachable();
const suite = dbUp ? describe : describe.skip;

// Lightweight Queue stub. Records ack/nack/enqueue calls so tests can assert
// without spinning up real BullMQ or even the InMemoryQueue's delivery loop.
class StubQueue implements Queue<SyncJobPayload> {
  readonly acked: JobId[] = [];
  readonly nacked: Array<{ id: JobId; retryAfterMs?: number }> = [];
  readonly enqueued: SyncJobPayload[] = [];

  async enqueue(payload: SyncJobPayload): Promise<JobId> {
    this.enqueued.push(payload);
    return JobId(`fake-${this.enqueued.length}`);
  }
  async consume(): Promise<{ close: () => Promise<void> }> {
    throw new Error('StubQueue.consume not used in tests');
  }
  async ack(id: JobId): Promise<void> {
    this.acked.push(id);
  }
  async nack(id: JobId, opts?: { retryAfterMs?: number }): Promise<void> {
    this.nacked.push({ id, retryAfterMs: opts?.retryAfterMs });
  }
  async moveToDLQ(): Promise<void> {
    // dispatcher doesn't call this; included for the interface
  }
  async listDeadLetters(): Promise<QueueJob<SyncJobPayload>[]> {
    return [];
  }
  async replayDeadLetter(): Promise<JobId> {
    return JobId('');
  }
  async close(): Promise<void> {
    // no-op
  }
}

suite('Phase 4 — reliability dispatcher', () => {
  let prisma: PrismaClient;
  let logger: Logger;

  // Tiny, deterministic policy so tests don't sleep.
  const fastPolicy: RetryPolicy = {
    maxAttempts: 3,
    baseDelayMs: 10,
    maxDelayMs: 100,
    jitter: false,
  };

  const samplePayload = {
    id: 12345,
    email: 'buyer@example.com',
    created_at: '2026-06-03T14:00:00Z',
    total_price: '29.50',
    currency: 'USD',
    customer: { id: 99, email: 'buyer@example.com', first_name: 'T', last_name: 'B' },
    line_items: [{ id: 1, title: 'Tee', quantity: 1, price: '29.50', sku: 'TEE-001' }],
  };

  beforeAll(() => {
    prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
    logger = createLogger({ LOG_LEVEL: 'error', NODE_ENV: 'test' }, { app: 'test' });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    // Surgical cleanup. Deleting the IngestedEvents cascades to their SyncRun
    // and DeadLetterItem rows via the FK constraints — so we never touch data
    // belonging to concurrently-running test suites (e.g. the Phase 3 e2e
    // integration test that races against this one).
    await prisma.ingestedEvent.deleteMany({
      where: { source: 'shopify', externalId: { startsWith: 'phase4-' } },
    });
  });

  async function makeEvent(suffix: string): Promise<string> {
    const e = await prisma.ingestedEvent.create({
      data: {
        source: 'shopify',
        externalId: `phase4-${suffix}-${Date.now()}`,
        topic: 'orders/create',
        rawPayload: samplePayload as object,
        signatureVerified: true,
        status: 'RECEIVED',
      },
    });
    return e.id;
  }

  function makeJob(eventId: string, attempt = 1): QueueJob<SyncJobPayload> {
    return {
      id: JobId(`job-${attempt}`),
      payload: { eventId },
      attempt,
      enqueuedAt: new Date(),
    };
  }

  function makeDeps(
    destination: ControllableDestinationConnector<MockErpOrderInput>,
    queue: StubQueue,
  ) {
    return { prisma, queue, destination, retryPolicy: fastPolicy, logger };
  }

  it('1. dedupes a re-delivered job after a prior SUCCEEDED SyncRun', async () => {
    const eventId = await makeEvent('dedupe');
    const dest = new ControllableDestinationConnector<MockErpOrderInput>();
    const queue = new StubQueue();
    const deps = makeDeps(dest, queue);

    const r1 = await dispatch(deps, makeJob(eventId, 1));
    expect(r1.kind).toBe('SUCCEEDED');
    expect(dest.deliveries).toHaveLength(1);

    const r2 = await dispatch(deps, makeJob(eventId, 1));
    expect(r2.kind).toBe('DEDUPED');
    expect(dest.deliveries).toHaveLength(1); // critically: not 2

    const runs = await prisma.syncRun.findMany({
      where: { eventId },
      orderBy: { startedAt: 'asc' },
    });
    expect(runs.map((r) => r.outcome)).toEqual(['SUCCEEDED', 'DEDUPED']);
  });

  it('2. retries with backoff and succeeds on the 3rd attempt', async () => {
    const eventId = await makeEvent('retry-then-succeed');
    const dest = new ControllableDestinationConnector<MockErpOrderInput>()
      .on(() => err(new UpstreamServerError('500 first')))
      .on(() => err(new UpstreamServerError('500 second')))
      .on(() => ok(undefined));
    const queue = new StubQueue();
    const deps = makeDeps(dest, queue);

    const r1 = await dispatch(deps, makeJob(eventId, 1));
    expect(r1.kind).toBe('RETRYING');
    if (r1.kind === 'RETRYING') expect(r1.nextDelayMs).toBe(10);
    expect(queue.nacked).toHaveLength(1);

    const r2 = await dispatch(deps, makeJob(eventId, 2));
    expect(r2.kind).toBe('RETRYING');
    if (r2.kind === 'RETRYING') expect(r2.nextDelayMs).toBe(20);

    const r3 = await dispatch(deps, makeJob(eventId, 3));
    expect(r3.kind).toBe('SUCCEEDED');

    const evt = await prisma.ingestedEvent.findUnique({ where: { id: eventId } });
    expect(evt?.status).toBe('SUCCEEDED');
    expect(dest.deliveries).toHaveLength(3);

    const runs = await prisma.syncRun.findMany({
      where: { eventId },
      orderBy: { attempt: 'asc' },
    });
    expect(runs.map((r) => ({ attempt: r.attempt, outcome: r.outcome }))).toEqual([
      { attempt: 1, outcome: 'RETRYABLE_FAILURE' },
      { attempt: 2, outcome: 'RETRYABLE_FAILURE' },
      { attempt: 3, outcome: 'SUCCEEDED' },
    ]);
  });

  it('3. routes to DLQ after maxAttempts retryable failures', async () => {
    const eventId = await makeEvent('exhaust');
    const dest = new ControllableDestinationConnector<MockErpOrderInput>()
      .on(() => err(new UpstreamServerError('500 a')))
      .on(() => err(new UpstreamServerError('500 b')))
      .on(() => err(new UpstreamServerError('500 final')));
    const queue = new StubQueue();
    const deps = makeDeps(dest, queue);

    await dispatch(deps, makeJob(eventId, 1));
    await dispatch(deps, makeJob(eventId, 2));
    const r3 = await dispatch(deps, makeJob(eventId, 3));

    expect(r3.kind).toBe('DEAD_LETTERED');
    if (r3.kind === 'DEAD_LETTERED') expect(r3.error).toContain('500 final');

    const evt = await prisma.ingestedEvent.findUnique({ where: { id: eventId } });
    expect(evt?.status).toBe('DEAD_LETTERED');
    expect(evt?.processedAt).not.toBeNull();

    const dlq = await prisma.deadLetterItem.findUnique({ where: { eventId } });
    expect(dlq?.attempts).toBe(3);
    expect(dlq?.lastError).toContain('500 final');
    expect(dlq?.resolvedAt).toBeNull();

    // queue.ack on terminal route — NO further nack
    expect(queue.acked).toHaveLength(1);
    expect(queue.nacked).toHaveLength(2); // attempts 1 + 2 nacked, attempt 3 acked
  });

  it('4. terminal failure goes straight to DLQ with zero retries', async () => {
    const eventId = await makeEvent('terminal');
    const dest = new ControllableDestinationConnector<MockErpOrderInput>().on(() =>
      err(new UpstreamClientError('422 schema mismatch')),
    );
    const queue = new StubQueue();
    const deps = makeDeps(dest, queue);

    const r = await dispatch(deps, makeJob(eventId, 1));
    expect(r.kind).toBe('DEAD_LETTERED');

    expect(queue.nacked).toHaveLength(0); // never retried
    expect(queue.acked).toHaveLength(1);

    const dlq = await prisma.deadLetterItem.findUnique({ where: { eventId } });
    expect(dlq?.attempts).toBe(1);
    expect(dlq?.lastError).toContain('422');
  });

  it('5. replay re-runs the event and marks the DLQ row resolved on success', async () => {
    const eventId = await makeEvent('replay');
    const dest = new ControllableDestinationConnector<MockErpOrderInput>()
      .on(() => err(new UpstreamServerError('outage attempt 1')))
      .on(() => err(new UpstreamServerError('outage attempt 2')))
      .on(() => err(new UpstreamServerError('outage attempt 3')))
      // Replay path:
      .on(() => ok(undefined));
    const queue = new StubQueue();
    const deps = makeDeps(dest, queue);

    // Original attempts exhaust retries → DLQ
    await dispatch(deps, makeJob(eventId, 1));
    await dispatch(deps, makeJob(eventId, 2));
    await dispatch(deps, makeJob(eventId, 3));

    let dlq = await prisma.deadLetterItem.findUnique({ where: { eventId } });
    expect(dlq?.resolvedAt).toBeNull();

    // Replay (the API endpoint would re-enqueue with attempt=1)
    const replay = await dispatch(deps, makeJob(eventId, 1));
    expect(replay.kind).toBe('SUCCEEDED');

    dlq = await prisma.deadLetterItem.findUnique({ where: { eventId } });
    expect(dlq?.resolvedAt).not.toBeNull();

    const evt = await prisma.ingestedEvent.findUnique({ where: { id: eventId } });
    expect(evt?.status).toBe('SUCCEEDED');
  });

  it('6. crash-then-redeliver still dedupes via the prior SUCCEEDED SyncRun', async () => {
    // Simulates: worker processed event, wrote SUCCEEDED SyncRun, then crashed
    // before acking the queue. Queue redelivers; the consumer's dedupe check
    // catches it and avoids a second destination call.
    const eventId = await makeEvent('crash');
    const dest = new ControllableDestinationConnector<MockErpOrderInput>();
    const queue = new StubQueue();
    const deps = makeDeps(dest, queue);

    const r1 = await dispatch(deps, makeJob(eventId, 1));
    expect(r1.kind).toBe('SUCCEEDED');
    expect(dest.deliveries).toHaveLength(1);

    // Queue redelivers (attempt counter higher because BullMQ would have incremented it).
    const r2 = await dispatch(deps, makeJob(eventId, 2));
    expect(r2.kind).toBe('DEDUPED');
    expect(dest.deliveries).toHaveLength(1); // critically: NOT 2
  });
});
