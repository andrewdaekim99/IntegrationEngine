import { describe, it, expect } from 'vitest';
import {
  isOk,
  NetworkError,
  UpstreamClientError,
  UpstreamServerError,
} from '@integr8/core';
import { runDestinationConformance } from '../../conformance.js';
import {
  StripeDestinationConnector,
  type StripePaymentIntentInput,
} from '../index.js';

const sampleInput = (): StripePaymentIntentInput => ({
  amount: 2950,
  currency: 'usd',
  description: 'Shopify order test',
  metadata: { source_order_id: '5912345678901', source_system: 'shopify' },
});

// 2xx mock for the conformance suite.
const okFetch: typeof fetch = async () =>
  new Response(JSON.stringify({ id: 'pi_test_123', status: 'requires_payment_method' }), {
    status: 200,
  });

runDestinationConformance({
  name: 'StripeDestinationConnector',
  makeConnector: () =>
    new StripeDestinationConnector({
      apiKey: 'sk_test_x',
      baseUrl: 'http://stripe.invalid',
      fetchFn: okFetch,
    }),
  sampleInput,
});

describe('StripeDestinationConnector — error classification', () => {
  it('429 maps to UpstreamServerError (retryable rate limit)', async () => {
    const conn = new StripeDestinationConnector({
      apiKey: 'sk_test_x',
      baseUrl: 'http://stripe.invalid',
      fetchFn: async () => new Response('{"error":{"message":"too many"}}', { status: 429 }),
    });
    const r = await conn.deliver(sampleInput(), 'idem-1');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBeInstanceOf(UpstreamServerError);
      expect(r.error.retryable).toBe(true);
      expect(r.error.message).toMatch(/429/);
    }
  });

  it('5xx maps to UpstreamServerError (retryable)', async () => {
    const conn = new StripeDestinationConnector({
      apiKey: 'sk_test_x',
      baseUrl: 'http://stripe.invalid',
      fetchFn: async () => new Response('upstream down', { status: 503 }),
    });
    const r = await conn.deliver(sampleInput(), 'idem-1');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBeInstanceOf(UpstreamServerError);
  });

  it('4xx maps to UpstreamClientError (terminal)', async () => {
    const conn = new StripeDestinationConnector({
      apiKey: 'sk_test_x',
      baseUrl: 'http://stripe.invalid',
      fetchFn: async () =>
        new Response('{"error":{"message":"Invalid currency"}}', { status: 400 }),
    });
    const r = await conn.deliver(sampleInput(), 'idem-1');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBeInstanceOf(UpstreamClientError);
      expect(r.error.retryable).toBe(false);
    }
  });

  it('fetch throwing maps to NetworkError (retryable)', async () => {
    const conn = new StripeDestinationConnector({
      apiKey: 'sk_test_x',
      baseUrl: 'http://stripe.invalid',
      fetchFn: async () => {
        throw new TypeError('fetch failed');
      },
    });
    const r = await conn.deliver(sampleInput(), 'idem-1');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBeInstanceOf(NetworkError);
  });
});

describe('StripeDestinationConnector — request shape', () => {
  it('form-encodes amount, currency, description, and flattened metadata', async () => {
    let capturedBody: string | null = null;
    let capturedHeaders: Headers | null = null;
    const conn = new StripeDestinationConnector({
      apiKey: 'sk_test_my_key',
      baseUrl: 'http://stripe.invalid',
      fetchFn: async (_url, init) => {
        capturedBody = init?.body as string;
        capturedHeaders = new Headers(init?.headers as Record<string, string> | undefined);
        return new Response(JSON.stringify({ id: 'pi_x' }), { status: 200 });
      },
    });

    const r = await conn.deliver(sampleInput(), 'idem-abc');
    expect(isOk(r)).toBe(true);

    expect(capturedBody).not.toBeNull();
    const params = new URLSearchParams(capturedBody!);
    expect(params.get('amount')).toBe('2950');
    expect(params.get('currency')).toBe('usd');
    expect(params.get('description')).toBe('Shopify order test');
    expect(params.get('metadata[source_order_id]')).toBe('5912345678901');
    expect(params.get('metadata[source_system]')).toBe('shopify');

    expect(capturedHeaders).not.toBeNull();
    expect(capturedHeaders!.get('Authorization')).toBe('Bearer sk_test_my_key');
    expect(capturedHeaders!.get('Content-Type')).toBe(
      'application/x-www-form-urlencoded',
    );
    expect(capturedHeaders!.get('Idempotency-Key')).toBe('idem-abc');
  });
});
