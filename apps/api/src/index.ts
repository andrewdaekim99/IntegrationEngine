import Fastify, { type FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  loadEnv,
  createLogger,
  mappingSpecSchema,
  SYNC_QUEUE_NAME,
  SHOPIFY_SOURCE,
  SHOPIFY_ORDERS_CREATE_TOPIC,
  type SyncJobPayload,
} from '@integr8/core';
import { PrismaClient, type Prisma } from '@integr8/db';
import { BullMQQueue } from '@integr8/queue';
import { ShopifyOrderConnector } from '@integr8/connectors';
import { MappingProposer } from '@integr8/ai';

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

// Lazy: only built when ANTHROPIC_API_KEY is set so the API starts cleanly
// without an Anthropic account configured (the propose endpoint returns 503).
const mappingProposer = env.ANTHROPIC_API_KEY
  ? new MappingProposer({ apiKey: env.ANTHROPIC_API_KEY, model: env.ANTHROPIC_MODEL })
  : null;

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

// ---------------------------------------------------------------------------
// Mapping Studio endpoints (Phase 6). The proposal endpoint calls Claude;
// everything else is plain CRUD against MappingConfig.
// ---------------------------------------------------------------------------

const proposalRequestSchema = z.object({
  sourceSystem: z.string().min(1),
  destinationSystem: z.string().min(1),
  sourceSample: z.unknown(),
  destinationSample: z.unknown(),
});

app.post('/mappings/proposals', async (req, reply) => {
  if (!mappingProposer) {
    return reply.code(503).send({
      error:
        'ANTHROPIC_API_KEY is not set on the API. Add it to .env and recreate the api container.',
    });
  }
  const parsed = proposalRequestSchema.safeParse(parseJsonBody(req.body));
  if (!parsed.success) {
    return reply.code(400).send({ error: 'invalid body', issues: parsed.error.issues });
  }
  const log = req.log.child({ route: 'mapping-proposal' });
  try {
    const proposal = await mappingProposer.propose({
      sourceSystem: parsed.data.sourceSystem,
      destinationSystem: parsed.data.destinationSystem,
      sourceSample: parsed.data.sourceSample,
      destinationSample: parsed.data.destinationSample,
    });
    log.info(
      {
        sourceSystem: parsed.data.sourceSystem,
        destinationSystem: parsed.data.destinationSystem,
        fieldCount: proposal.fields.length,
      },
      'mapping proposal generated',
    );
    return reply.code(200).send({ proposal });
  } catch (err) {
    log.error({ err }, 'mapping proposal failed');
    return reply.code(502).send({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

const saveMappingSchema = z.object({
  sourceSystem: z.string().min(1),
  destinationSystem: z.string().min(1),
  fields: mappingSpecSchema,
  approvedBy: z.string().optional(),
  activate: z.boolean().default(true),
});

app.post('/mappings', async (req, reply) => {
  const parsed = saveMappingSchema.safeParse(parseJsonBody(req.body));
  if (!parsed.success) {
    return reply.code(400).send({ error: 'invalid body', issues: parsed.error.issues });
  }
  const { sourceSystem, destinationSystem, fields, approvedBy, activate } = parsed.data;
  const log = req.log.child({ route: 'mapping-save' });

  const created = await prisma.$transaction(async (tx) => {
    const last = await tx.mappingConfig.findFirst({
      where: { sourceSystem, destinationSystem },
      orderBy: { version: 'desc' },
      select: { version: true },
    });
    const nextVersion = (last?.version ?? 0) + 1;

    if (activate) {
      await tx.mappingConfig.updateMany({
        where: { sourceSystem, destinationSystem, isActive: true },
        data: { isActive: false },
      });
    }

    return tx.mappingConfig.create({
      data: {
        sourceSystem,
        destinationSystem,
        version: nextVersion,
        fields: fields as Prisma.InputJsonValue,
        isActive: activate,
        approvedBy: approvedBy ?? null,
        approvedAt: activate ? new Date() : null,
      },
    });
  });

  log.info(
    { id: created.id, version: created.version, sourceSystem, destinationSystem, activate },
    'mapping saved',
  );
  return reply.code(201).send({ mapping: created });
});

app.post('/mappings/:id/activate', async (req, reply) => {
  const { id } = req.params as { id: string };
  const target = await prisma.mappingConfig.findUnique({ where: { id } });
  if (!target) return reply.code(404).send({ error: 'mapping not found' });

  await prisma.$transaction(async (tx) => {
    await tx.mappingConfig.updateMany({
      where: {
        sourceSystem: target.sourceSystem,
        destinationSystem: target.destinationSystem,
        isActive: true,
      },
      data: { isActive: false },
    });
    await tx.mappingConfig.update({
      where: { id },
      data: { isActive: true, approvedAt: target.approvedAt ?? new Date() },
    });
  });

  return reply.code(200).send({ status: 'activated', id });
});

const mappingsListQuerySchema = z.object({
  sourceSystem: z.string().optional(),
  destinationSystem: z.string().optional(),
  limit: z.coerce.number().int().positive().max(200).default(50),
  offset: z.coerce.number().int().nonnegative().default(0),
});

app.get('/mappings', async (req, reply) => {
  const parsed = mappingsListQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return reply.code(400).send({ error: 'invalid query', issues: parsed.error.issues });
  }
  const { sourceSystem, destinationSystem, limit, offset } = parsed.data;

  const where: Prisma.MappingConfigWhereInput = {};
  if (sourceSystem) where.sourceSystem = sourceSystem;
  if (destinationSystem) where.destinationSystem = destinationSystem;

  const [mappings, total] = await Promise.all([
    prisma.mappingConfig.findMany({
      where,
      orderBy: [{ sourceSystem: 'asc' }, { destinationSystem: 'asc' }, { version: 'desc' }],
      take: limit,
      skip: offset,
    }),
    prisma.mappingConfig.count({ where }),
  ]);

  return reply.send({ mappings, total, limit, offset });
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

/**
 * Re-parses the body for routes that need structured JSON. The custom JSON
 * content-type parser hands every POST handler the raw string (for HMAC
 * verification on the Shopify webhook), so non-webhook routes apply this on
 * the way in.
 */
function parseJsonBody(body: unknown): unknown {
  if (typeof body !== 'string') return body;
  if (body.length === 0) return null;
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
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
