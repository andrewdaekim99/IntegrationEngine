import {
  loadEnv,
  createLogger,
  SYNC_QUEUE_NAME,
  type SyncJobPayload,
} from '@integr8/core';
import { PrismaClient } from '@integr8/db';
import { BullMQQueue } from '@integr8/queue';
import { MockErpDestinationConnector } from '@integr8/connectors';
import { processEvent } from './process-event.js';

const env = loadEnv();
const logger = createLogger(env, { app: 'worker' });
const prisma = new PrismaClient();
const queue = new BullMQQueue<SyncJobPayload>({
  queueName: SYNC_QUEUE_NAME,
  redisUrl: env.REDIS_URL,
});
const mockErp = new MockErpDestinationConnector({ baseUrl: env.MOCK_ERP_URL });

const consumer = await queue.consume(async (job) => {
  const log = logger.child({
    jobId: job.id,
    eventId: job.payload.eventId,
    attempt: job.attempt,
  });
  log.info('event received');
  try {
    const result = await processEvent({
      prisma,
      mockErp,
      eventId: job.payload.eventId,
      attempt: job.attempt,
      log,
    });
    log.info({ outcome: result.kind }, 'event completed');
  } catch (err) {
    log.error({ err }, 'unexpected error processing event');
  }
  // Phase 3: ack every outcome to prevent infinite redelivery loops.
  // Phase 4 will reroute retryable failures via nack(retryAfterMs) and
  // terminal failures via moveToDLQ.
  await queue.ack(job.id);
});

logger.info(
  { queue: SYNC_QUEUE_NAME, mockErpUrl: env.MOCK_ERP_URL },
  'worker started — consuming sync queue',
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
