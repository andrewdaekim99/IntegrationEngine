import { describe, it, expect } from 'vitest';
import {
  backoffDelayMs,
  shouldRetry,
  DEFAULT_RETRY_POLICY,
  type RetryPolicy,
} from '../retry-policy.js';

const noJitter: RetryPolicy = {
  maxAttempts: 5,
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
  jitter: false,
};

describe('backoffDelayMs (no jitter)', () => {
  it('doubles on each attempt: 1000 → 2000 → 4000 → 8000 → 16000', () => {
    expect(backoffDelayMs(1, noJitter)).toBe(1_000);
    expect(backoffDelayMs(2, noJitter)).toBe(2_000);
    expect(backoffDelayMs(3, noJitter)).toBe(4_000);
    expect(backoffDelayMs(4, noJitter)).toBe(8_000);
    expect(backoffDelayMs(5, noJitter)).toBe(16_000);
  });

  it('caps at maxDelayMs', () => {
    const policy = { ...noJitter, maxDelayMs: 5_000 };
    expect(backoffDelayMs(3, policy)).toBe(4_000);
    expect(backoffDelayMs(4, policy)).toBe(5_000); // would be 8000, capped
    expect(backoffDelayMs(10, policy)).toBe(5_000);
  });

  it('throws on invalid attempt', () => {
    expect(() => backoffDelayMs(0, noJitter)).toThrow();
    expect(() => backoffDelayMs(-1, noJitter)).toThrow();
  });
});

describe('backoffDelayMs (with jitter)', () => {
  it('stays within [exponential, exponential * 1.25]', () => {
    for (let i = 0; i < 50; i++) {
      const d = backoffDelayMs(3, DEFAULT_RETRY_POLICY); // expo = 4000
      expect(d).toBeGreaterThanOrEqual(4_000);
      expect(d).toBeLessThanOrEqual(5_000);
    }
  });
});

describe('shouldRetry', () => {
  it('true while attempt < maxAttempts', () => {
    expect(shouldRetry(1, noJitter)).toBe(true);
    expect(shouldRetry(4, noJitter)).toBe(true);
  });

  it('false at the cap', () => {
    expect(shouldRetry(5, noJitter)).toBe(false);
    expect(shouldRetry(6, noJitter)).toBe(false);
  });
});
