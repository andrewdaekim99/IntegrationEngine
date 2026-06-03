/**
 * Local dev helper. Signs the bundled Shopify order fixture with
 * SHOPIFY_WEBHOOK_SECRET (from .env) and POSTs it to the API as if it were
 * a real Shopify webhook. Pass `--new` to bump the order id so it doesn't
 * collide with the idempotency dedupe.
 *
 *   pnpm dev:send-test-webhook
 *   pnpm dev:send-test-webhook -- --new
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { signShopifyBody } from '@integr8/connectors';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(
  __dirname,
  '../../../packages/connectors/src/shopify/__fixtures__/order-create.json',
);

const body = readFileSync(fixturePath, 'utf8');
const secret = process.env.SHOPIFY_WEBHOOK_SECRET ?? 'replace-me';
const apiUrl = process.env.API_URL ?? `http://localhost:${process.env.API_PORT ?? '3010'}`;

const bumpId = process.argv.includes('--new');
const finalBody = bumpId ? body.replace(/"id":\s*\d+/, `"id": ${Date.now()}`) : body;
const signature = signShopifyBody(finalBody, secret);

console.log(`POST ${apiUrl}/webhooks/shopify/orders`);
console.log(`  secret used: ${secret === 'replace-me' ? '(placeholder)' : '(from env)'}`);
console.log(`  body length: ${finalBody.length}`);
console.log(`  X-Shopify-Hmac-Sha256: ${signature.slice(0, 12)}…`);

const res = await fetch(`${apiUrl}/webhooks/shopify/orders`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Shopify-Hmac-Sha256': signature,
    'X-Shopify-Topic': 'orders/create',
  },
  body: finalBody,
});

console.log(`\nHTTP ${res.status}`);
console.log(await res.text());

if (!res.ok) process.exit(1);
