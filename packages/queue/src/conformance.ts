import { describe, it, expect } from 'vitest';
import type { JobId } from '@integr8/core';
import type { Queue, QueueJob } from './types.js';

/**
 * The contract every Queue<T> implementation must honor. Imported and run by
 * each concrete adapter (in-memory, BullMQ, SQS, …) so the engine can swap
 * drivers without code changes.
 *
 * Pass a `makeQueue` factory that returns a fresh Queue<T> per test.
 */
export function runQueueConformance<T>(opts: {
  name: string;
  makeQueue: () => Queue<T> | Promise<Queue<T>>;
  samplePayload: () => T;
}): void {
  describe(`Queue conformance — ${opts.name}`, () => {
    it('round-trips a payload through enqueue → consume → ack', async () => {
      const queue = await opts.makeQueue();
      const received: QueueJob<T>[] = [];
      const done = new Promise<void>((resolve) => {
        queue.consume(async (job) => {
          received.push(job);
          await queue.ack(job.id);
          resolve();
        });
      });
      const payload = opts.samplePayload();
      const id = await queue.enqueue(payload);
      await done;
      expect(received).toHaveLength(1);
      expect(received[0]?.id).toBe(id);
      expect(received[0]?.payload).toEqual(payload);
      expect(received[0]?.attempt).toBe(1);
      await queue.close();
    });

    it('nack re-delivers the job with an incremented attempt count', async () => {
      const queue = await opts.makeQueue();
      const attempts: number[] = [];
      const done = new Promise<void>((resolve) => {
        queue.consume(async (job) => {
          attempts.push(job.attempt);
          if (job.attempt < 3) {
            await queue.nack(job.id);
          } else {
            await queue.ack(job.id);
            resolve();
          }
        });
      });
      await queue.enqueue(opts.samplePayload());
      await done;
      expect(attempts).toEqual([1, 2, 3]);
      await queue.close();
    });

    it('moveToDLQ places the job in the dead-letter list', async () => {
      const queue = await opts.makeQueue();
      const done = new Promise<void>((resolve) => {
        queue.consume(async (job) => {
          await queue.moveToDLQ(job.id, 'forced failure');
          resolve();
        });
      });
      await queue.enqueue(opts.samplePayload());
      await done;
      const dlq = await queue.listDeadLetters();
      expect(dlq).toHaveLength(1);
      await queue.close();
    });

    it('replayDeadLetter re-enqueues the original payload', async () => {
      const queue = await opts.makeQueue();
      const seen: T[] = [];
      let dlqId: JobId | undefined;

      const replayedSuccessfully = new Promise<void>((resolve) => {
        queue.consume(async (job) => {
          seen.push(job.payload);
          if (seen.length === 1) {
            await queue.moveToDLQ(job.id, 'forced failure');
            dlqId = job.id;
          } else {
            await queue.ack(job.id);
            resolve();
          }
        });
      });

      const original = opts.samplePayload();
      await queue.enqueue(original);

      // Wait until the first attempt has landed in DLQ.
      await waitFor(async () => (await queue.listDeadLetters()).length === 1);

      if (!dlqId) throw new Error('test invariant: dlqId not captured');
      await queue.replayDeadLetter(dlqId);
      await replayedSuccessfully;

      expect(seen).toHaveLength(2);
      expect(seen[1]).toEqual(original);
      expect(await queue.listDeadLetters()).toHaveLength(0);
      await queue.close();
    });

    it('rejects enqueue after close', async () => {
      const queue = await opts.makeQueue();
      await queue.close();
      await expect(queue.enqueue(opts.samplePayload())).rejects.toThrow();
    });
  });
}

async function waitFor(
  predicate: () => Promise<boolean>,
  { timeoutMs = 1_000, intervalMs = 5 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor: predicate did not become true within ${timeoutMs}ms`);
}
