import {
  loadEnv,
  createLogger,
  type SyncJobPayload,
} from '@integr8/core';
import { PrismaClient } from '@integr8/db';
import { makeQueue } from '@integr8/queue';
import {
  MockErpDestinationConnector,
  StripeDestinationConnector,
} from '@integr8/connectors';
import { dispatch } from './dispatch.js';
import type { DestinationSpec } from './process-event.js';
import { DEFAULT_RETRY_POLICY } from './retry-policy.js';
import {
  mapShopifyOrderToMockErp,
  mapShopifyOrderToStripe,
} from './mapping.js';

const env = loadEnv();
const logger = createLogger(env, { app: 'worker' });
const prisma = new PrismaClient();
const queue = makeQueue<SyncJobPayload>(env);

// Mock ERP is always wired.
const mockErp = new MockErpDestinationConnector({ baseUrl: env.MOCK_ERP_URL });
const destinations: DestinationSpec[] = [
  {
    name: 'mock-erp',
    connector: mockErp,
    hardcodedMapper: mapShopifyOrderToMockErp,
  },
];

// Stripe is conditional on STRIPE_TEST_KEY being present.
if (env.STRIPE_TEST_KEY) {
  const stripe = new StripeDestinationConnector({ apiKey: env.STRIPE_TEST_KEY });
  destinations.push({
    name: 'stripe',
    connector: stripe,
    hardcodedMapper: mapShopifyOrderToStripe,
  });
}

const consumer = await queue.consume(async (job) => {
  await dispatch(
    {
      prisma,
      queue,
      destinations,
      retryPolicy: DEFAULT_RETRY_POLICY,
      logger,
    },
    job,
  );
});

logger.info(
  {
    queueDriver: env.QUEUE_DRIVER,
    destinations: destinations.map((d) => d.name),
    mockErpUrl: env.MOCK_ERP_URL,
    stripeEnabled: Boolean(env.STRIPE_TEST_KEY),
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
