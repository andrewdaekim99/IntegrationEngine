import { SYNC_QUEUE_NAME, type Env } from '@integr8/core';
import { BullMQQueue } from './bullmq.js';
import { SqsQueue } from './sqs.js';
import type { Queue } from './types.js';

/**
 * Pick the right Queue<T> implementation based on `env.QUEUE_DRIVER`.
 *
 *   bullmq → local dev (BullMQ + Redis from docker-compose).
 *   sqs    → AWS deploy (Phase 8). Requires AWS_REGION + SQS_QUEUE_URL + SQS_DLQ_URL.
 *
 * Both apps/api and apps/worker call this so the queue swap is one env
 * variable, not a code change.
 */
export function makeQueue<T>(
  env: Pick<
    Env,
    | 'QUEUE_DRIVER'
    | 'REDIS_URL'
    | 'AWS_REGION'
    | 'SQS_QUEUE_URL'
    | 'SQS_DLQ_URL'
  >,
): Queue<T> {
  if (env.QUEUE_DRIVER === 'sqs') {
    if (!env.AWS_REGION || !env.SQS_QUEUE_URL || !env.SQS_DLQ_URL) {
      throw new Error(
        'QUEUE_DRIVER=sqs requires AWS_REGION, SQS_QUEUE_URL, and SQS_DLQ_URL to be set',
      );
    }
    return new SqsQueue<T>({
      region: env.AWS_REGION,
      queueUrl: env.SQS_QUEUE_URL,
      dlqUrl: env.SQS_DLQ_URL,
    });
  }
  return new BullMQQueue<T>({
    queueName: SYNC_QUEUE_NAME,
    redisUrl: env.REDIS_URL,
  });
}
