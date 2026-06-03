import Fastify from 'fastify';
import { loadEnv, createLogger } from '@integr8/core';
import { PrismaClient } from '@integr8/db';

const env = loadEnv();
const logger = createLogger(env, { app: 'mock-erp' });
const prisma = new PrismaClient();

const app = Fastify({ loggerInstance: logger });

app.get('/healthz', async () => ({ ok: true, service: 'mock-erp' }));

/**
 * POST /orders — accepts an arbitrary JSON body and an Idempotency-Key header.
 *   - First time we see the key  → 201 with the stored row.
 *   - Duplicate key              → 200 with the prior row (no second insert).
 *   - Missing header / bad JSON  → 400.
 *
 * Idempotency is enforced by the UNIQUE constraint on MockErpOrder.idempotencyKey,
 * so concurrent calls with the same key race safely — the loser catches the
 * unique violation and returns the winner's row.
 */
app.post('/orders', async (req, reply) => {
  const rawKey = req.headers['idempotency-key'];
  const idempotencyKey = Array.isArray(rawKey) ? rawKey[0] : rawKey;
  if (!idempotencyKey || typeof idempotencyKey !== 'string') {
    return reply.code(400).send({ error: 'Idempotency-Key header is required' });
  }

  const existing = await prisma.mockErpOrder.findUnique({ where: { idempotencyKey } });
  if (existing) {
    return reply.code(200).send({ ...existing, status: 'duplicate' });
  }

  try {
    const created = await prisma.mockErpOrder.create({
      data: {
        idempotencyKey,
        payload: (req.body as object | null) ?? {},
      },
    });
    return reply.code(201).send({ ...created, status: 'created' });
  } catch (err) {
    // Race: another request inserted with the same idempotency key between
    // our findUnique and our create. The unique constraint caught it; return
    // the winning row.
    if (err instanceof Error && /Unique constraint/i.test(err.message)) {
      const row = await prisma.mockErpOrder.findUnique({ where: { idempotencyKey } });
      if (row) return reply.code(200).send({ ...row, status: 'duplicate' });
    }
    logger.error({ err }, 'mock-erp POST /orders failed');
    return reply.code(500).send({ error: 'internal error' });
  }
});

const shutdown = async (signal: string): Promise<void> => {
  logger.info({ signal }, 'mock-erp shutting down');
  await app.close();
  await prisma.$disconnect();
  process.exit(0);
};

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

try {
  await app.listen({ port: env.MOCK_ERP_PORT, host: '0.0.0.0' });
  logger.info({ port: env.MOCK_ERP_PORT }, 'mock-erp listening');
} catch (err) {
  logger.error({ err }, 'mock-erp failed to start');
  process.exit(1);
}
