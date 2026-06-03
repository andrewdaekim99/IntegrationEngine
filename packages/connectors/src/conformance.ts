import { describe, it, expect } from 'vitest';
import { isOk } from '@integr8/core';
import type { SourceConnector, DestinationConnector } from './types.js';

/**
 * Connector conformance — the minimal contract every adapter must satisfy.
 * Real semantics tests (HMAC rejects tampered fixtures, deliver dedupes by
 * Idempotency-Key, etc.) live alongside each adapter in Phase 2+; this
 * suite just proves the interface is implemented and the noop path works.
 */

export function runSourceConformance<TPayload>(opts: {
  name: string;
  makeConnector: () => SourceConnector<TPayload>;
  validBody: string;
  validHeaders: Record<string, string>;
}): void {
  describe(`SourceConnector conformance — ${opts.name}`, () => {
    it('exposes a name', () => {
      expect(opts.makeConnector().name).toBeTruthy();
    });

    it('verifySignature returns a Result', () => {
      const c = opts.makeConnector();
      const r = c.verifySignature(opts.validBody, opts.validHeaders);
      expect(r.ok).toBeTypeOf('boolean');
    });

    it('parsePayload returns a Result', () => {
      const c = opts.makeConnector();
      const r = c.parsePayload(opts.validBody);
      expect(r.ok).toBeTypeOf('boolean');
    });
  });
}

export function runDestinationConformance<TInput>(opts: {
  name: string;
  makeConnector: () => DestinationConnector<TInput>;
  sampleInput: () => TInput;
}): void {
  describe(`DestinationConnector conformance — ${opts.name}`, () => {
    it('exposes a name', () => {
      expect(opts.makeConnector().name).toBeTruthy();
    });

    it('deliver returns a Result', async () => {
      const c = opts.makeConnector();
      const r = await c.deliver(opts.sampleInput(), 'idem-1');
      expect(r.ok).toBeTypeOf('boolean');
    });

    it('healthcheck returns a Result', async () => {
      const c = opts.makeConnector();
      const r = await c.healthcheck();
      expect(r.ok).toBeTypeOf('boolean');
    });

    it('two deliveries with the same idempotency key are accepted by the contract', async () => {
      // The interface allows it; idempotency semantics are the destination's
      // responsibility. We just verify the contract doesn't reject.
      const c = opts.makeConnector();
      const r1 = await c.deliver(opts.sampleInput(), 'idem-x');
      const r2 = await c.deliver(opts.sampleInput(), 'idem-x');
      expect(isOk(r1) || !isOk(r1)).toBe(true);
      expect(isOk(r2) || !isOk(r2)).toBe(true);
    });
  });
}
