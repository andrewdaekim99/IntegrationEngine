import { describe, it, expect } from 'vitest';
import {
  isOk,
  NetworkError,
  UpstreamClientError,
  UpstreamServerError,
} from '@integr8/core';
import { runDestinationConformance } from '../../conformance.js';
import {
  MockErpDestinationConnector,
  type MockErpOrderInput,
} from '../index.js';

const sampleInput = (): MockErpOrderInput => ({
  externalRef: 'shopify-5912345678901',
  customer: { email: 'buyer@example.com', name: 'Test Buyer' },
  items: [{ sku: 'TEE-001', quantity: 1, price: '29.50' }],
  totalAmount: '29.50',
  currency: 'USD',
});

// 2xx mock for the conformance suite.
const okFetch: typeof fetch = async () =>
  new Response(JSON.stringify({ ok: true }), { status: 201 });

runDestinationConformance({
  name: 'MockErpDestinationConnector',
  makeConnector: () =>
    new MockErpDestinationConnector({
      baseUrl: 'http://mock-erp.invalid',
      fetchFn: okFetch,
    }),
  sampleInput,
});

describe('MockErpDestinationConnector — error classification', () => {
  it('5xx maps to UpstreamServerError (retryable)', async () => {
    const conn = new MockErpDestinationConnector({
      baseUrl: 'http://mock-erp.invalid',
      fetchFn: async () => new Response('boom', { status: 503 }),
    });
    const r = await conn.deliver(sampleInput(), 'idem-1');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBeInstanceOf(UpstreamServerError);
      expect(r.error.retryable).toBe(true);
    }
  });

  it('4xx maps to UpstreamClientError (terminal)', async () => {
    const conn = new MockErpDestinationConnector({
      baseUrl: 'http://mock-erp.invalid',
      fetchFn: async () => new Response('bad payload', { status: 422 }),
    });
    const r = await conn.deliver(sampleInput(), 'idem-1');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBeInstanceOf(UpstreamClientError);
      expect(r.error.retryable).toBe(false);
    }
  });

  it('fetch throwing maps to NetworkError (retryable)', async () => {
    const conn = new MockErpDestinationConnector({
      baseUrl: 'http://mock-erp.invalid',
      fetchFn: async () => {
        throw new TypeError('fetch failed');
      },
    });
    const r = await conn.deliver(sampleInput(), 'idem-1');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBeInstanceOf(NetworkError);
      expect(r.error.retryable).toBe(true);
    }
  });

  it('passes the Idempotency-Key header through', async () => {
    let captured: Headers | null = null;
    const conn = new MockErpDestinationConnector({
      baseUrl: 'http://mock-erp.invalid',
      fetchFn: async (_url, init) => {
        captured = new Headers(init?.headers as Record<string, string> | undefined);
        return new Response('', { status: 201 });
      },
    });
    const r = await conn.deliver(sampleInput(), 'idem-xyz');
    expect(isOk(r)).toBe(true);
    expect(captured).not.toBeNull();
    expect(captured!.get('Idempotency-Key')).toBe('idem-xyz');
    expect(captured!.get('Content-Type')).toBe('application/json');
  });
});
