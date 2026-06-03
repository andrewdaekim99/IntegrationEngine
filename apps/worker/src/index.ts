import {
  loadEnv,
  createLogger,
  SYNC_QUEUE_NAME,
  type SyncJobPayload,
} from '@integr8/core';
import { PrismaClient } from '@integr8/db';
import { BullMQQueue } from '@integr8/queue';
import { MockErpDestinationConnector } from '@integr8/connectors';
import { dispatch } from './dispatch.js';
import { DEFAULT_RETRY_POLICY } from './retry-policy.js';

const env = loadEnv();
const logger = createLogger(env, { app: 'worker' });
const prisma = new PrismaClient();
const queue = new BullMQQueue<SyncJobPayload>({
  queueName: SYNC_QUEUE_NAME,
  redisUrl: env.REDIS_URL,
});
const mockErp = new MockErpDestinationConnector({ baseUrl: env.MOCK_ERP_URL });

const consumer = await queue.consume(async (job) => {
  await dispatch(
    {
      prisma,
      queue,
      destination: mockErp,
      retryPolicy: DEFAULT_RETRY_POLICY,
      logger,
    },
    job,
  );
});

logger.info(
  {
    queue: SYNC_QUEUE_NAME,
    mockErpUrl: env.MOCK_ERP_URL,
    retryPolicy: DEFAULT_RETRY_POLICY,
  },
  'worker started — consuming sync queue with retry/DLQ enabled',
);

const shutdown = async (signal: string): Promise<void> => {
  logger.info({ signal }, 'worker shutting down');
  await consumer.close();
  await queue.close();
  await prisma.$disconnect();
  process.exit(0);
};

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
