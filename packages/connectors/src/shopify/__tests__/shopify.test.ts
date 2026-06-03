import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { isOk, ValidationError } from '@integr8/core';
import { ShopifyOrderConnector, signShopifyBody } from '../index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = readFileSync(join(__dirname, '..', '__fixtures__', 'order-create.json'), 'utf8');
const SECRET = 'test-secret';
const VALID_SIG = signShopifyBody(fixture, SECRET);

describe('ShopifyOrderConnector — HMAC verification', () => {
  const connector = new ShopifyOrderConnector({ webhookSecret: SECRET });

  it('accepts a known-good body + signature', () => {
    const r = connector.verifySignature(fixture, { 'X-Shopify-Hmac-Sha256': VALID_SIG });
    expect(isOk(r)).toBe(true);
  });

  it('accepts the lowercase header variant', () => {
    const r = connector.verifySignature(fixture, { 'x-shopify-hmac-sha256': VALID_SIG });
    expect(isOk(r)).toBe(true);
  });

  it('rejects a tampered body', () => {
    const tampered = fixture.replace('29.50', '0.01');
    const r = connector.verifySignature(tampered, { 'X-Shopify-Hmac-Sha256': VALID_SIG });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBeInstanceOf(ValidationError);
  });

  it('rejects the wrong secret', () => {
    const wrongSig = signShopifyBody(fixture, 'wrong-secret');
    const r = connector.verifySignature(fixture, { 'X-Shopify-Hmac-Sha256': wrongSig });
    expect(r.ok).toBe(false);
  });

  it('rejects a missing header', () => {
    const r = connector.verifySignature(fixture, {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toContain('missing');
  });
});

describe('ShopifyOrderConnector — payload parsing', () => {
  const connector = new ShopifyOrderConnector({ webhookSecret: SECRET });

  it('parses a valid Shopify order', () => {
    const r = connector.parsePayload(fixture);
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.value.id).toBe(5912345678901);
      expect(r.value.line_items).toHaveLength(2);
      expect(r.value.line_items[0]?.sku).toBe('TEE-001');
    }
  });

  it('rejects malformed JSON', () => {
    const r = connector.parsePayload('{not json');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toContain('invalid JSON');
  });

  it('rejects a body missing required fields', () => {
    const r = connector.parsePayload(JSON.stringify({ id: 1 }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toContain('schema mismatch');
  });
});
