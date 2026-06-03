/**
 * Dev helper. Reads the most-recent `shopify / orders/create` IngestedEvent
 * from Postgres and writes its raw payload to the connectors package as a
 * test fixture. Useful for snapshotting a real Shopify shape so future tests
 * don't need ngrok up.
 *
 *   pnpm dev:capture-fixture
 *   pnpm dev:capture-fixture -- --name big-order
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PrismaClient } from '@integr8/db';

const __dirname = dirname(fileURLToPath(import.meta.url));

const nameArg = (() => {
  const i = process.argv.indexOf('--name');
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : 'real-order';
})();

const outPath = join(
  __dirname,
  `../../../packages/connectors/src/shopify/__fixtures__/${nameArg}.json`,
);

const prisma = new PrismaClient();

const event = await prisma.ingestedEvent.findFirst({
  where: { source: 'shopify', topic: 'orders/create' },
  orderBy: { receivedAt: 'desc' },
});

if (!event) {
  console.error(
    'No shopify/orders/create events found in DB.\n' +
      'Fire a webhook first — either real (Shopify Send test notification) or\n' +
      'synthetic (pnpm dev:send-test-webhook).',
  );
  await prisma.$disconnect();
  process.exit(1);
}

const json = JSON.stringify(event.rawPayload, null, 2) + '\n';
writeFileSync(outPath, json);

console.log(`✓ Captured event ${event.id}`);
console.log(`  externalId: ${event.externalId}`);
console.log(`  receivedAt: ${event.receivedAt.toISOString()}`);
console.log(`  → ${outPath} (${json.length} bytes)`);

await prisma.$disconnect();
