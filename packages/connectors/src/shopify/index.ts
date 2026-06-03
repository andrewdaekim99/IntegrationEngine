import { ok, err, ValidationError, type Result } from '@integr8/core';
import type { SourceConnector } from '../types.js';
import { verifyShopifyHmac } from './hmac.js';
import { shopifyOrderSchema, type ShopifyOrder } from './schema.js';

const HMAC_HEADER = 'x-shopify-hmac-sha256';

export interface ShopifyConnectorOptions {
  webhookSecret: string;
}

/**
 * SourceConnector<ShopifyOrder> — verifies Shopify's HMAC-SHA256 signature
 * and parses the order webhook body into a typed payload. The two steps are
 * independent so the API endpoint can short-circuit on a bad signature before
 * spending CPU on a parse attempt.
 */
export class ShopifyOrderConnector implements SourceConnector<ShopifyOrder> {
  readonly name = 'shopify-order';

  constructor(private readonly opts: ShopifyConnectorOptions) {}

  verifySignature(
    rawBody: string,
    headers: Record<string, string>,
  ): Result<void, ValidationError> {
    // Headers are case-insensitive; normalize to lowercase key lookup.
    const signature = pickHeader(headers, HMAC_HEADER);
    if (!signature) {
      return err(new ValidationError(`missing ${HMAC_HEADER} header`));
    }
    if (!verifyShopifyHmac(rawBody, signature, this.opts.webhookSecret)) {
      return err(new ValidationError('HMAC verification failed'));
    }
    return ok(undefined);
  }

  parsePayload(rawBody: string): Result<ShopifyOrder, ValidationError> {
    let json: unknown;
    try {
      json = JSON.parse(rawBody);
    } catch (e) {
      return err(new ValidationError('invalid JSON body', e));
    }
    const parsed = shopifyOrderSchema.safeParse(json);
    if (!parsed.success) {
      return err(
        new ValidationError(`Shopify order schema mismatch: ${parsed.error.message}`),
      );
    }
    return ok(parsed.data);
  }
}

function pickHeader(headers: Record<string, string>, name: string): string | undefined {
  const direct = headers[name];
  if (direct !== undefined) return direct;
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

export { verifyShopifyHmac, signShopifyBody } from './hmac.js';
export { shopifyOrderSchema, type ShopifyOrder } from './schema.js';
