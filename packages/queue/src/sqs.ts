import {
  SQSClient,
  SendMessageCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  type Message,
} from '@aws-sdk/client-sqs';
import { JobId } from '@integr8/core';
import type {
  Queue,
  QueueJob,
  QueueConsumer,
  EnqueueOptions,
  NackOptions,
} from './types.js';

interface Envelope<T> {
  payload: T;
  attempt: number;
}

interface DlqEnvelope<T> {
  payload: T;
  originalAttempt: number;
  lastError: string;
  dlqAt: string;
}

type Decision =
  | { type: 'ack' }
  | { type: 'nack'; retryAfterMs?: number }
  | { type: 'dlq'; lastError: string };

export interface SqsQueueOptions {
  region: string;
  /** Pre-created main queue URL. */
  queueUrl: string;
  /** Pre-created dead-letter queue URL. */
  dlqUrl: string;
  /** SQS long-poll seconds. Defaults to 20 (SQS max). */
  waitTimeSeconds?: number;
  /** Max messages to fetch per poll. Defaults to 1. */
  maxMessagesPerPoll?: number;
}

/**
 * SQS + AWS implementation of Queue<T>. Same bridge pattern as BullMQ: each
 * received message is delivered to the user handler, which calls
 * ack/nack/moveToDLQ; a per-message decision promise resolves what the worker
 * does next (DeleteMessage / SendMessage-with-attempt+1 / SendMessage-to-DLQ).
 *
 * Queues must be pre-created. We pass the URLs in — auto-creation needs
 * separate IAM permissions and is brittle when scaling out workers.
 *
 * `JobId` is the SQS `MessageId` from the SendMessage response. Attempts are
 * carried in the JSON envelope (`{payload, attempt}`) — SQS's own
 * ApproximateReceiveCount resets when we re-send for retries, so we track it
 * ourselves.
 */
export class SqsQueue<T> implements Queue<T> {
  private readonly client: SQSClient;
  private readonly queueUrl: string;
  private readonly dlqUrl: string;
  private readonly waitTimeSeconds: number;
  private readonly maxMessagesPerPoll: number;
  private readonly decisions = new Map<JobId, (d: Decision) => void>();
  private readonly receiptHandles = new Map<JobId, string>();
  private polling = false;
  private closed = false;

  constructor(opts: SqsQueueOptions) {
    this.client = new SQSClient({ region: opts.region });
    this.queueUrl = opts.queueUrl;
    this.dlqUrl = opts.dlqUrl;
    this.waitTimeSeconds = opts.waitTimeSeconds ?? 20;
    this.maxMessagesPerPoll = opts.maxMessagesPerPoll ?? 1;
  }

  async enqueue(payload: T, opts: EnqueueOptions = {}): Promise<JobId> {
    if (this.closed) throw new Error('queue is closed');
    const envelope: Envelope<T> = { payload, attempt: 1 };
    const cmd = new SendMessageCommand({
      QueueUrl: this.queueUrl,
      MessageBody: JSON.stringify(envelope),
      ...(opts.delayMs && opts.delayMs > 0
        ? { DelaySeconds: Math.min(Math.ceil(opts.delayMs / 1000), 900) }
        : {}),
    });
    const res = await this.client.send(cmd);
    return JobId(res.MessageId ?? '');
  }

  async consume(handler: (job: QueueJob<T>) => Promise<void>): Promise<QueueConsumer> {
    if (this.closed) throw new Error('queue is closed');
    if (this.polling) throw new Error('consume already called on this queue');
    this.polling = true;
    void this.pollLoop(handler);
    return {
      close: async () => {
        this.polling = false;
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
    // Peek without claiming — VisibilityTimeout=0 leaves messages available
    // for other consumers. For demos this returns the first batch; production
    // would page through with multiple receives.
    const res = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: this.dlqUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 0,
        VisibilityTimeout: 0,
        MessageSystemAttributeNames: ['SentTimestamp'],
      }),
    );
    return (res.Messages ?? []).map((m) => this.parseDlqMessage(m));
  }

  async replayDeadLetter(jobId: JobId): Promise<JobId> {
    // SQS doesn't let you GET-by-MessageId; we scan a single batch.
    const res = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: this.dlqUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 0,
      }),
    );
    const target = (res.Messages ?? []).find((m) => m.MessageId === jobId);
    if (!target) {
      throw new Error(`replayDeadLetter: no DLQ message with MessageId=${jobId}`);
    }
    const envelope = JSON.parse(target.Body ?? '{}') as DlqEnvelope<T>;
    const send = await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: JSON.stringify({ payload: envelope.payload, attempt: 1 }),
      }),
    );
    await this.client.send(
      new DeleteMessageCommand({
        QueueUrl: this.dlqUrl,
        ReceiptHandle: target.ReceiptHandle ?? '',
      }),
    );
    return JobId(send.MessageId ?? '');
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.polling = false;
    this.client.destroy();
  }

  // ---------------------------------------------------------------------------

  private async pollLoop(
    handler: (job: QueueJob<T>) => Promise<void>,
  ): Promise<void> {
    while (this.polling && !this.closed) {
      let res;
      try {
        res = await this.client.send(
          new ReceiveMessageCommand({
            QueueUrl: this.queueUrl,
            MaxNumberOfMessages: this.maxMessagesPerPoll,
            WaitTimeSeconds: this.waitTimeSeconds,
            MessageSystemAttributeNames: ['SentTimestamp', 'ApproximateReceiveCount'],
          }),
        );
      } catch {
        // Transient network / throttling — short pause then retry.
        await sleep(1000);
        continue;
      }

      for (const msg of res.Messages ?? []) {
        if (!this.polling || this.closed) break;
        await this.handleOne(msg, handler);
      }
    }
  }

  private async handleOne(
    msg: Message,
    handler: (job: QueueJob<T>) => Promise<void>,
  ): Promise<void> {
    const id = JobId(msg.MessageId ?? '');
    let envelope: Envelope<T>;
    try {
      envelope = JSON.parse(msg.Body ?? '{}') as Envelope<T>;
    } catch {
      // Malformed envelope — delete and move on; can't process it.
      await this.deleteMessage(this.queueUrl, msg.ReceiptHandle);
      return;
    }

    this.receiptHandles.set(id, msg.ReceiptHandle ?? '');

    const job: QueueJob<T> = {
      id,
      payload: envelope.payload,
      attempt: envelope.attempt ?? 1,
      enqueuedAt: this.timestampFrom(msg),
    };

    const decision = await new Promise<Decision>((resolve) => {
      this.decisions.set(id, resolve);
      queueMicrotask(() => {
        handler(job).catch(() => {
          const pending = this.decisions.get(id);
          if (pending) {
            this.decisions.delete(id);
            pending({ type: 'nack' });
          }
        });
      });
    });

    this.decisions.delete(id);
    const receipt = this.receiptHandles.get(id) ?? '';
    this.receiptHandles.delete(id);

    if (decision.type === 'ack') {
      await this.deleteMessage(this.queueUrl, receipt);
      return;
    }

    if (decision.type === 'nack') {
      // Delete the original + re-send with attempt+1. SQS's
      // ApproximateReceiveCount would reset on a fresh enqueue anyway.
      const next: Envelope<T> = {
        payload: envelope.payload,
        attempt: envelope.attempt + 1,
      };
      const sendOpts: { QueueUrl: string; MessageBody: string; DelaySeconds?: number } = {
        QueueUrl: this.queueUrl,
        MessageBody: JSON.stringify(next),
      };
      if (decision.retryAfterMs && decision.retryAfterMs > 0) {
        sendOpts.DelaySeconds = Math.min(Math.ceil(decision.retryAfterMs / 1000), 900);
      }
      await Promise.all([
        this.client.send(new SendMessageCommand(sendOpts)),
        this.deleteMessage(this.queueUrl, receipt),
      ]);
      return;
    }

    // decision.type === 'dlq'
    const dlqEnvelope: DlqEnvelope<T> = {
      payload: envelope.payload,
      originalAttempt: envelope.attempt,
      lastError: decision.lastError,
      dlqAt: new Date().toISOString(),
    };
    await Promise.all([
      this.client.send(
        new SendMessageCommand({
          QueueUrl: this.dlqUrl,
          MessageBody: JSON.stringify(dlqEnvelope),
        }),
      ),
      this.deleteMessage(this.queueUrl, receipt),
    ]);
  }

  private async deleteMessage(queueUrl: string, receiptHandle: string | undefined): Promise<void> {
    if (!receiptHandle) return;
    await this.client.send(
      new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: receiptHandle }),
    );
  }

  private parseDlqMessage(m: Message): QueueJob<T> {
    let envelope: DlqEnvelope<T> | null = null;
    try {
      envelope = JSON.parse(m.Body ?? '{}') as DlqEnvelope<T>;
    } catch {
      // fall through with empty envelope
    }
    return {
      id: JobId(m.MessageId ?? ''),
      payload: (envelope?.payload as T) ?? ({} as T),
      attempt: envelope?.originalAttempt ?? 1,
      enqueuedAt: this.timestampFrom(m),
    };
  }

  private timestampFrom(m: Message): Date {
    const sent = m.Attributes?.SentTimestamp;
    if (!sent) return new Date();
    const n = Number(sent);
    if (!Number.isFinite(n)) return new Date();
    return new Date(n);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
