import Fastify from 'fastify';
import { loadEnv, createLogger } from '@integr8/core';

const env = loadEnv();
const logger = createLogger(env, { app: 'api' });

const app = Fastify({ loggerInstance: logger });

app.get('/healthz', async () => ({ ok: true, service: 'api' }));

try {
  await app.listen({ port: env.API_PORT, host: '0.0.0.0' });
  logger.info({ port: env.API_PORT }, 'api listening');
} catch (err) {
  logger.error({ err }, 'api failed to start');
  process.exit(1);
}
