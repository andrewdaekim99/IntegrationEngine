import Fastify, { type FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  loadEnv,
  createLogger,
  SYNC_QUEUE_NAME,
  SHOPIFY_SOURCE,
  SHOPIFY_ORDERS_CREATE_TOPIC,
  type SyncJobPayload,
} from '@integr8/core';
import { PrismaClient, type Prisma } from '@integr8/db';
import { BullMQQueue } from '@integr8/queue';
import { ShopifyOrderConnector } from '@integr8/connectors';

const env = loadEnv();
const logger = createLogger(env, { app: 'api' });
const prisma = new PrismaClient();

const queue = new BullMQQueue<SyncJobPayload>({
  queueName: SYNC_QUEUE_NAME,
  redisUrl: env.REDIS_URL,
});

const shopify = new ShopifyOrderConnector({
  webhookSecret: env.SHOPIFY_WEBHOOK_SECRET ?? '',
});

const app = Fastify({ loggerInstance: logger });

// Replace the default JSON parser with one that hands the route the *raw* body
// string. Shopify's HMAC is computed over the exact bytes Shopify sent, so we
// must verify before any re-stringification.
app.removeContentTypeParser('application/json');
app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
  done(null, body);
});

app.get('/healthz', async () => ({ ok: true, service: 'api' }));

// ---------------------------------------------------------------------------
// Dashboard REST endpoints. Server-side (Next.js) reads them; everything else
// is read-only so no auth for the Phase 5 demo.
// ---------------------------------------------------------------------------

const EventStatusEnum = z.enum([
  'RECEIVED',
  'PROCESSING',
  'SUCCEEDED',
  'DEDUPED',
  'RETRYING',
  'DEAD_LETTERED',
]);

const eventsQuerySchema = z.object({
  q: z.string().min(1).optional(),
  status: EventStatusEnum.optional(),
  limit: z.coerce.number().int().positive().max(200).default(50),
  offset: z.coerce.number().int().nonnegative().default(0),
});

app.get('/events', async (req, reply) => {
  const parsed = eventsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return reply.code(400).send({ error: 'invalid query', issues: parsed.error.issues });
  }
  const { q, status, limit, offset } = parsed.data;

  const where: Prisma.IngestedEventWhereInput = {};
  if (q) where.externalId = { contains: q };
  if (status) where.status = status;

  const [events, total] = await Promise.all([
    prisma.ingestedEvent.findMany({
      where,
      orderBy: { receivedAt: 'desc' },
      take: limit,
      skip: offset,
      select: {
        id: true,
        source: true,
        externalId: true,
        topic: true,
        status: true,
        receivedAt: true,
        processedAt: true,
      },
    }),
    prisma.ingestedEvent.count({ where }),
  ]);

  return reply.send({ events, total, limit, offset });
});

app.get('/events/:id', async (req, reply) => {
  const { id } = req.params as { id: string };
  const event = await prisma.ingestedEvent.findUnique({
    where: { id },
    include: {
      syncRuns: { orderBy: { startedAt: 'asc' } },
      deadLetterItem: true,
    },
  });
  if (!event) return reply.code(404).send({ error: 'event not found' });
  return reply.send({ event });
});

const dlqQuerySchema = z.object({
  resolved: z.enum(['true', 'false', 'all']).default('false'),
  limit: z.coerce.number().int().positive().max(200).default(50),
  offset: z.coerce.number().int().nonnegative().default(0),
});

app.get('/dlq', async (req, reply) => {
  const parsed = dlqQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return reply.code(400).send({ error: 'invalid query', issues: parsed.error.issues });
  }
  const { resolved, limit, offset } = parsed.data;

  const where: Prisma.DeadLetterItemWhereInput = {};
  if (resolved === 'true') where.resolvedAt = { not: null };
  if (resolved === 'false') where.resolvedAt = null;

  const [items, total] = await Promise.all([
    prisma.deadLetterItem.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: offset,
      include: {
        event: {
          select: { id: true, source: true, externalId: true, topic: true, status: true },
        },
      },
    }),
    prisma.deadLetterItem.count({ where }),
  ]);

  return reply.send({ items, total, limit, offset });
});

/**
 * Manual DLQ replay. Looks up the DeadLetterItem by id, re-enqueues the
 * original eventId so the worker can have another go. The DLQ row stays
 * `unresolved` until the worker's dispatch logic marks it resolved on a
 * successful SyncRun. Returns 202 + the new jobId.
 *
 *   curl -X POST http://localhost:3010/dlq/<dlq-id>/replay
 */
app.post('/dlq/:id/replay', async (req, reply) => {
  const { id } = req.params as { id: string };
  const log = req.log.child({ route: 'dlq-replay', dlqId: id });

  const item = await prisma.deadLetterItem.findUnique({ where: { id } });
  if (!item) {
    return reply.code(404).send({ error: 'DLQ item not found' });
  }
  if (item.resolvedAt) {
    return reply.code(409).send({
      error: 'DLQ item already resolved',
      resolvedAt: item.resolvedAt,
    });
  }

  await prisma.ingestedEvent.update({
    where: { id: item.eventId },
    data: { status: 'RECEIVED', processedAt: null },
  });

  const jobId = await queue.enqueue({ eventId: item.eventId });
  log.info({ eventId: item.eventId, jobId }, 'DLQ replay enqueued');

  return reply.code(202).send({
    status: 'replay-enqueued',
    jobId,
    eventId: item.eventId,
    dlqId: item.id,
  });
});

app.post('/webhooks/shopify/orders', async (req, reply) => {
  const rawBody = req.body;
  if (typeof rawBody !== 'string' || rawBody.length === 0) {
    return reply.code(400).send({ error: 'empty body' });
  }

  const headers = normalizeHeaders(req.headers);
  const log = req.log.child({ route: 'shopify-orders' });

  const sig = shopify.verifySignature(rawBody, headers);
  if (!sig.ok) {
    log.warn({ reason: sig.error.message }, 'shopify hmac verification failed');
    return reply.code(401).send({ error: 'invalid signature' });
  }

  const parsed = shopify.parsePayload(rawBody);
  if (!parsed.ok) {
    log.warn({ reason: parsed.error.message }, 'shopify payload parsing failed');
    return reply.code(400).send({ error: 'invalid payload' });
  }

  const order = parsed.value;
  const topic = headers['x-shopify-topic'] ?? SHOPIFY_ORDERS_CREATE_TOPIC;
  const externalId = String(order.id);

  let eventId: string;
  try {
    const created = await prisma.ingestedEvent.create({
      data: {
        source: SHOPIFY_SOURCE,
        externalId,
        topic,
        rawPayload: JSON.parse(rawBody) as object,
        signatureVerified: true,
        status: 'RECEIVED',
      },
    });
    eventId = created.id;
  } catch (err) {
    if (err instanceof Error && /Unique constraint/i.test(err.message)) {
      // Shopify retries are common; the idempotency_key unique caught a dup.
      const existing = await prisma.ingestedEvent.findUnique({
        where: { idempotency_key: { source: SHOPIFY_SOURCE, externalId, topic } },
      });
      log.info({ eventId: existing?.id, externalId }, 'duplicate webhook — already ingested');
      return reply.code(200).send({ status: 'duplicate', eventId: existing?.id });
    }
    log.error({ err }, 'failed to persist ingested event');
    return reply.code(500).send({ error: 'internal error' });
  }

  const jobId = await queue.enqueue({ eventId });
  log.info({ eventId, jobId, externalId }, 'shopify webhook ingested + enqueued');

  return reply.code(200).send({ status: 'ingested', eventId });
});

const shutdown = async (signal: string): Promise<void> => {
  logger.info({ signal }, 'api shutting down');
  await app.close();
  await queue.close();
  await prisma.$disconnect();
  process.exit(0);
};

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

try {
  await app.listen({ port: env.API_PORT, host: '0.0.0.0' });
  logger.info({ port: env.API_PORT }, 'api listening');
} catch (err) {
  logger.error({ err }, 'api failed to start');
  process.exit(1);
}

function normalizeHeaders(
  headers: FastifyRequest['headers'],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (typeof v === 'string') out[k] = v;
    else if (Array.isArray(v) && typeof v[0] === 'string') out[k] = v[0];
  }
  return out;
}
