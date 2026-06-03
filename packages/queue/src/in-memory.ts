import { JobId } from '@integr8/core';
import type {
  Queue,
  QueueJob,
  QueueConsumer,
  EnqueueOptions,
  NackOptions,
} from './types.js';

/**
 * In-memory Queue<T> for tests and the conformance suite. Single-process,
 * non-durable, no persistence — but it must round-trip and obey ack/nack/DLQ
 * the same way a real driver does, because the same conformance tests run
 * against BullMQ and SQS in later phases.
 */
export class InMemoryQueue<T> implements Queue<T> {
  private pending: QueueJob<T>[] = [];
  private inFlight = new Map<JobId, QueueJob<T>>();
  private deadLetter = new Map<JobId, QueueJob<T>>();
  private deadLetterErrors = new Map<JobId, string>();
  private handler: ((job: QueueJob<T>) => Promise<void>) | null = null;
  private closed = false;
  private nextSeq = 0;

  async enqueue(payload: T, opts: EnqueueOptions = {}): Promise<JobId> {
    if (this.closed) throw new Error('queue is closed');
    const id = JobId(opts.jobId ?? `job-${++this.nextSeq}`);
    const job: QueueJob<T> = {
      id,
      payload,
      attempt: 1,
      enqueuedAt: new Date(),
    };
    if (opts.delayMs && opts.delayMs > 0) {
      setTimeout(() => this.pushAndDeliver(job), opts.delayMs);
    } else {
      this.pushAndDeliver(job);
    }
    return id;
  }

  async consume(handler: (job: QueueJob<T>) => Promise<void>): Promise<QueueConsumer> {
    if (this.closed) throw new Error('queue is closed');
    this.handler = handler;
    this.flush();
    return {
      close: async () => {
        if (this.handler === handler) this.handler = null;
      },
    };
  }

  async ack(jobId: JobId): Promise<void> {
    this.inFlight.delete(jobId);
  }

  async nack(jobId: JobId, opts: NackOptions = {}): Promise<void> {
    const job = this.inFlight.get(jobId);
    if (!job) throw new Error(`nack: no in-flight job ${jobId}`);
    this.inFlight.delete(jobId);
    const retry: QueueJob<T> = { ...job, attempt: job.attempt + 1 };
    if (opts.retryAfterMs && opts.retryAfterMs > 0) {
      setTimeout(() => this.pushAndDeliver(retry), opts.retryAfterMs);
    } else {
      this.pushAndDeliver(retry);
    }
  }

  async moveToDLQ(jobId: JobId, lastError: string): Promise<void> {
    const job = this.inFlight.get(jobId);
    if (!job) throw new Error(`moveToDLQ: no in-flight job ${jobId}`);
    this.inFlight.delete(jobId);
    this.deadLetter.set(jobId, job);
    this.deadLetterErrors.set(jobId, lastError);
  }

  async listDeadLetters(): Promise<QueueJob<T>[]> {
    return Array.from(this.deadLetter.values());
  }

  async replayDeadLetter(jobId: JobId): Promise<JobId> {
    const job = this.deadLetter.get(jobId);
    if (!job) throw new Error(`replayDeadLetter: no DLQ job ${jobId}`);
    this.deadLetter.delete(jobId);
    this.deadLetterErrors.delete(jobId);
    return this.enqueue(job.payload);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.handler = null;
  }

  /** Test helper — read the captured error string for a dead-lettered job. */
  getDeadLetterError(jobId: JobId): string | undefined {
    return this.deadLetterErrors.get(jobId);
  }

  private pushAndDeliver(job: QueueJob<T>): void {
    this.pending.push(job);
    this.flush();
  }

  private flush(): void {
    if (!this.handler || this.closed) return;
    queueMicrotask(async () => {
      while (this.pending.length > 0 && this.handler && !this.closed) {
        const job = this.pending.shift();
        if (!job) break;
        this.inFlight.set(job.id, job);
        try {
          await this.handler(job);
        } catch {
          // Handlers are responsible for nack/moveToDLQ themselves. A thrown
          // error here is treated as "handler bug" — leave the job in-flight
          // so tests can assert on the leak.
        }
      }
    });
  }
}
