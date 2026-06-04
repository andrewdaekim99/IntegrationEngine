import { randomUUID } from 'node:crypto';
import { describe, it } from 'vitest';
import {
  SQSClient,
  CreateQueueCommand,
  DeleteQueueCommand,
} from '@aws-sdk/client-sqs';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { runQueueConformance } from '../conformance.js';
import { SqsQueue } from '../sqs.js';

const REGION = process.env.AWS_REGION ?? 'us-east-1';

/**
 * Probe AWS to decide whether the SQS conformance suite runs. Skips on dev
 * machines without credentials configured (mirrors the BullMQ adapter's Redis
 * probe) — same `pnpm test` works whether you've done Phase 8 prep or not.
 */
async function awsReachable(): Promise<boolean> {
  let sts: STSClient | null = null;
  try {
    sts = new STSClient({ region: REGION });
    await Promise.race([
      sts.send(new GetCallerIdentityCommand({})),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000)),
    ]);
    return true;
  } catch {
    return false;
  } finally {
    sts?.destroy();
  }
}

interface Payload {
  message: string;
}

const aws = await awsReachable();

if (!aws) {
  describe.skip('Queue conformance — SqsQueue (AWS not reachable)', () => {
    it('is skipped', () => {});
  });
} else {
  // Each test creates its own pair of queues so state doesn't leak across runs.
  // Setup adds ~1-2s per test but is reliable.
  runQueueConformance<Payload>({
    name: 'SqsQueue',
    makeQueue: async () => {
      const client = new SQSClient({ region: REGION });
      const id = randomUUID().slice(0, 8);
      const mainName = `integr8-conformance-${id}`;
      const dlqName = `integr8-conformance-${id}-dlq`;
      const [main, dlq] = await Promise.all([
        client.send(new CreateQueueCommand({ QueueName: mainName })),
        client.send(new CreateQueueCommand({ QueueName: dlqName })),
      ]);
      const queueUrl = main.QueueUrl ?? '';
      const dlqUrl = dlq.QueueUrl ?? '';

      const queue = new SqsQueue<Payload>({
        region: REGION,
        queueUrl,
        dlqUrl,
        waitTimeSeconds: 1,
      });

      // The conformance suite calls queue.close() in each test; piggyback on
      // close to also delete the queues so the AWS account stays clean.
      const originalClose = queue.close.bind(queue);
      queue.close = async () => {
        await originalClose();
        await Promise.allSettled([
          client.send(new DeleteQueueCommand({ QueueUrl: queueUrl })),
          client.send(new DeleteQueueCommand({ QueueUrl: dlqUrl })),
        ]);
        client.destroy();
      };
      return queue;
    },
    samplePayload: () => ({ message: 'hello' }),
  });
}
