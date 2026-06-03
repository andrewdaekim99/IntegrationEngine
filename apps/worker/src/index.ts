import { loadEnv, createLogger } from '@integr8/core';

const env = loadEnv();
const logger = createLogger(env, { app: 'worker' });

logger.info('worker started — Phase 0 no-op; queue consumption lands in Phase 3');

const heartbeat = setInterval(() => {
  logger.debug('worker idle');
}, 30_000);

const shutdown = (signal: string): void => {
  logger.info({ signal }, 'worker shutting down');
  clearInterval(heartbeat);
  process.exit(0);
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
