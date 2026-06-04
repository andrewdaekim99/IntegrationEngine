/**
 * Phase 3 end-to-end integration test.
 *
 * Drives the LIVE docker-compose stack: signs a Shopify webhook fixture,
 * POSTs it to the running API, polls Postgres until the worker finishes,
 * and asserts the IngestedEvent → SyncRun → MockErpOrder chain.
 *
 * Skips cleanly if the stack isn't up so `pnpm test` stays green on a
 * cold machine. To run it intentionally: `docker compose up -d` first.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signShopifyBody } from '@integr8/connectors';
import { PrismaClient } from '@integr8/db';

const API_URL = process.env.API_URL ?? 'http://localhost:3010';
const SECRET = process.env.SHOPIFY_WEBHOOK_SECRET ?? 'replace-me';
const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://integr8:integr8@localhost:5433/integr8?schema=public';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(
  __dirname,
  '../../../../packages/connectors/src/shopify/__fixtures__/order-create.json',
);

async function checkApi(): Promise<boolean> {
  try {
    const r = await fetch(`${API_URL}/healthz`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

async function checkDb(): Promise<boolean> {
  const probe = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
  try {
    await probe.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  } finally {
    await probe.$disconnect();
  }
}

const stackUp = (await checkApi()) && (await checkDb());
const suite = stackUp ? describe : describe.skip;

suite('Phase 3 — Shopify webhook → Mock ERP happy path', () => {
  let prisma: PrismaClient;

  beforeAll(() => {
    prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('webhook → IngestedEvent → SyncRun(SUCCEEDED) → MockErpOrder row', async () => {
    const fixture = readFileSync(fixturePath, 'utf8');
    // Bump the order id so this run doesn't collide with prior runs' dedupe.
    const externalId = Date.now();
    const body = fixture.replace(/"id":\s*\d+/, `"id": ${externalId}`);
    const signature = signShopifyBody(body, SECRET);

    const res = await fetch(`${API_URL}/webhooks/shopify/orders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Hmac-Sha256': signature,
        'X-Shopify-Topic': 'orders/create',
      },
      body,
    });
    expect(res.status).toBe(200);
    const result = (await res.json()) as { status: string; eventId: string };
    expect(result.status).toBe('ingested');
    const eventId = result.eventId;

    // Wait for the worker to finish.
    await waitFor(async () => {
      const event = await prisma.ingestedEvent.findUnique({ where: { id: eventId } });
      return event?.status === 'SUCCEEDED';
    });

    // SyncRun row reflects success. Phase 7+ may write multiple SyncRuns
    // (mock-erp + stripe when STRIPE_TEST_KEY is set), so scope to mock-erp.
    const syncRun = await prisma.syncRun.findFirst({
      where: { eventId, destination: 'mock-erp' },
      orderBy: { startedAt: 'desc' },
    });
    expect(syncRun).toBeTruthy();
    expect(syncRun?.outcome).toBe('SUCCEEDED');
    expect(syncRun?.destination).toBe('mock-erp');
    expect(syncRun?.attempt).toBe(1);

    // Mock ERP got exactly one row, idempotency key = `event-${eventId}`
    const erpOrder = await prisma.mockErpOrder.findUnique({
      where: { idempotencyKey: `event-${eventId}` },
    });
    expect(erpOrder).toBeTruthy();
    expect((erpOrder?.payload as { externalRef: string }).externalRef).toBe(
      `shopify-${externalId}`,
    );
  }, 15_000);
});

async function waitFor(
  predicate: () => Promise<boolean>,
  { timeoutMs = 10_000, intervalMs = 100 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor: predicate did not become true within ${timeoutMs}ms`);
}
