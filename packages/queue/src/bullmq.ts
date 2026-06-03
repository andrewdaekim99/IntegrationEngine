import { Queue as BullQueue, Worker, type Job as BullJob, type JobsOptions } from 'bullmq';
import { JobId } from '@integr8/core';
import type {
  Queue,
  QueueJob,
  QueueConsumer,
  EnqueueOptions,
  NackOptions,
} from './types.js';

interface BullData<T> {
  payload: T;
  attempt: number;
}

interface DlqData<T> {
  payload: T;
  originalAttempt: number;
  lastError: string;
  dlqAt: string;
}

type Decision =
  | { type: 'ack' }
  | { type: 'nack'; retryAfterMs?: number }
  | { type: 'dlq'; lastError: string };

export interface BullMQQueueOptions {
  queueName: string;
  redisUrl: string;
}

/**
 * BullMQ + Redis implementation of Queue<T>. Bridges BullMQ's auto-ack
 * semantics to the explicit ack / nack / moveToDLQ contract by waiting on
 * a per-job decision promise inside the worker function. A separate Bull
 * queue named `${queueName}-dlq` holds dead-lettered items so the DLQ list
 * survives Redis restarts.
 */
export class BullMQQueue<T> implements Queue<T> {
  private readonly bull: BullQueue<BullData<T>>;
  private readonly dlq: BullQueue<DlqData<T>>;
  private readonly connection: { url: string; maxRetriesPerRequest: null };
  private readonly decisions = new Map<JobId, (d: Decision) => void>();
  private worker: Worker<BullData<T>> | null = null;
  private closed = false;

  constructor(opts: BullMQQueueOptions) {
    this.connection = { url: opts.redisUrl, maxRetriesPerRequest: null };
    this.bull = new BullQueue<BullData<T>>(opts.queueName, { connection: this.connection });
    this.dlq = new BullQueue<DlqData<T>>(`${opts.queueName}-dlq`, { connection: this.connection });
  }

  async enqueue(payload: T, opts: EnqueueOptions = {}): Promise<JobId> {
    if (this.closed) throw new Error('queue is closed');
    const data: BullData<T> = { payload, attempt: 1 };
    const bullOpts: JobsOptions = {};
    if (opts.delayMs && opts.delayMs > 0) bullOpts.delay = opts.delayMs;
    if (opts.jobId) bullOpts.jobId = opts.jobId;
    const job = await this.bull.add('job', data, bullOpts);
    return JobId(job.id ?? '');
  }

  async consume(handler: (job: QueueJob<T>) => Promise<void>): Promise<QueueConsumer> {
    if (this.closed) throw new Error('queue is closed');
    if (this.worker) throw new Error('consume already called on this queue');

    this.worker = new Worker<BullData<T>>(
      this.bull.name,
      async (bullJob: BullJob<BullData<T>>) => {
        const id = JobId(bullJob.id ?? '');
        const myJob: QueueJob<T> = {
          id,
          payload: bullJob.data.payload,
          attempt: bullJob.data.attempt,
          enqueuedAt: new Date(bullJob.timestamp),
        };

        const decision = await new Promise<Decision>((resolve) => {
          this.decisions.set(id, resolve);
          // Schedule the user handler on the next microtask so the decisions
          // map is fully wired before the handler can call ack/nack/moveToDLQ.
          queueMicrotask(() => {
            handler(myJob).catch(() => {
              // Handler threw without explicit decision — treat as nack.
              const pending = this.decisions.get(id);
              if (pending) {
                this.decisions.delete(id);
                pending({ type: 'nack' });
              }
            });
          });
        });

        this.decisions.delete(id);

        if (decision.type === 'nack') {
          // Re-enqueue with incremented attempt count. From BullMQ's PoV the
          // original job completes; the retry is a new job with the same
          // payload and attempt+1.
          const nextData: BullData<T> = {
            payload: bullJob.data.payload,
            attempt: bullJob.data.attempt + 1,
          };
          const nextOpts: JobsOptions = {};
          if (decision.retryAfterMs && decision.retryAfterMs > 0) {
            nextOpts.delay = decision.retryAfterMs;
          }
          await this.bull.add('job', nextData, nextOpts);
        } else if (decision.type === 'dlq') {
          await this.dlq.add('dlq', {
            payload: bullJob.data.payload,
            originalAttempt: bullJob.data.attempt,
            lastError: decision.lastError,
            dlqAt: new Date().toISOString(),
          });
        }
        // For ack / nack / dlq, returning normally tells BullMQ the original
        // job is done. Re-enqueue / DLQ write happens above as needed.
      },
      { connection: this.connection },
    );

    await this.worker.waitUntilReady();

    return {
      close: async () => {
        if (this.worker) {
          await this.worker.close();
          this.worker = null;
        }
      },
    };
  }

  async ack(jobId: JobId): Promise<void> {
    const decide = this.decisions.get(jobId);
    if (decide) decide({ type: 'ack' });
  }

  async nack(jobId: JobId, opts: NackOptions = {}): Promise<void> {
    const decide = this.decisions.get(jobId);
    if (decide) {
      const decision: Decision = { type: 'nack' };
      if (opts.retryAfterMs !== undefined) decision.retryAfterMs = opts.retryAfterMs;
      decide(decision);
    }
  }

  async moveToDLQ(jobId: JobId, lastError: string): Promise<void> {
    const decide = this.decisions.get(jobId);
    if (decide) decide({ type: 'dlq', lastError });
  }

  async listDeadLetters(): Promise<QueueJob<T>[]> {
    const jobs = await this.dlq.getJobs(['waiting', 'delayed', 'paused']);
    return jobs.map(
      (j): QueueJob<T> => ({
        id: JobId(j.id ?? ''),
        payload: j.data.payload,
        attempt: j.data.originalAttempt,
        enqueuedAt: new Date(j.timestamp),
      }),
    );
  }

  async replayDeadLetter(jobId: JobId): Promise<JobId> {
    const job = await this.dlq.getJob(jobId);
    if (!job) throw new Error(`replayDeadLetter: no DLQ job ${jobId}`);
    const newId = await this.enqueue(job.data.payload);
    await job.remove();
    return newId;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.worker) {
      await this.worker.close();
      this.worker = null;
    }
    await this.bull.close();
    await this.dlq.close();
  }
}
