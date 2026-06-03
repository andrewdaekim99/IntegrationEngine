import Fastify from 'fastify';
import { loadEnv, createLogger } from '@integr8/core';

const env = loadEnv();
const logger = createLogger(env, { app: 'mock-erp' });

const app = Fastify({ loggerInstance: logger });

app.get('/healthz', async () => ({ ok: true, service: 'mock-erp' }));

try {
  await app.listen({ port: env.MOCK_ERP_PORT, host: '0.0.0.0' });
  logger.info({ port: env.MOCK_ERP_PORT }, 'mock-erp listening');
} catch (err) {
  logger.error({ err }, 'mock-erp failed to start');
  process.exit(1);
}
