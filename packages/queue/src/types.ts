import type { JobId } from '@integr8/core';

// A single message on the queue. The driver attaches `attempt` so handlers can
// reason about whether they're seeing this payload for the first time or after
// a retry — the worker's reliability layer uses that to log + decide DLQ.
export interface QueueJob<T> {
  readonly id: JobId;
  readonly payload: T;
  readonly attempt: number; // 1-indexed
  readonly enqueuedAt: Date;
}

export interface QueueConsumer {
  close(): Promise<void>;
}

export interface EnqueueOptions {
  delayMs?: number;
  /** If the driver supports content-based dedupe, use this as the dedupe key. */
  jobId?: string;
}

export interface NackOptions {
  retryAfterMs?: number;
}

/**
 * Queue<T> — the only abstraction the engine core depends on for message
 * transport. Concrete impls (BullMQ, SQS, in-memory) live in their own
 * sub-packages and all face the same conformance suite.
 *
 * Lifecycle expectations:
 *   - enqueue → driver durably stores the payload and returns a JobId.
 *   - consume(handler) → driver delivers jobs to the handler. The handler is
 *     responsible for calling ack / nack / moveToDLQ before returning.
 *   - close → stop accepting/delivering. Idempotent.
 */
export interface Queue<T> {
  enqueue(payload: T, opts?: EnqueueOptions): Promise<JobId>;
  consume(handler: (job: QueueJob<T>) => Promise<void>): Promise<QueueConsumer>;
  ack(jobId: JobId): Promise<void>;
  nack(jobId: JobId, opts?: NackOptions): Promise<void>;
  moveToDLQ(jobId: JobId, lastError: string): Promise<void>;
  listDeadLetters(): Promise<QueueJob<T>[]>;
  replayDeadLetter(jobId: JobId): Promise<JobId>;
  close(): Promise<void>;
}
