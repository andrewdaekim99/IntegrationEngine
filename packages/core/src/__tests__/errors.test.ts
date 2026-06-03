import { describe, it, expect } from 'vitest';
import {
  IntegrationError,
  RetryableError,
  TerminalError,
  NetworkError,
  ValidationError,
  isIntegrationError,
} from '../errors.js';

describe('error hierarchy', () => {
  it('NetworkError is retryable', () => {
    const e = new NetworkError('timeout');
    expect(e.retryable).toBe(true);
    expect(e).toBeInstanceOf(RetryableError);
    expect(e).toBeInstanceOf(IntegrationError);
  });

  it('ValidationError is terminal', () => {
    const e = new ValidationError('bad payload');
    expect(e.retryable).toBe(false);
    expect(e).toBeInstanceOf(TerminalError);
    expect(e).toBeInstanceOf(IntegrationError);
  });

  it('preserves the original cause', () => {
    const cause = new Error('underlying');
    const e = new NetworkError('wrapped', cause);
    expect(e.cause).toBe(cause);
  });

  it('isIntegrationError type guard discriminates', () => {
    expect(isIntegrationError(new NetworkError('x'))).toBe(true);
    expect(isIntegrationError(new Error('plain'))).toBe(false);
    expect(isIntegrationError('string')).toBe(false);
  });

  it('name reflects the subclass', () => {
    expect(new NetworkError('x').name).toBe('NetworkError');
    expect(new ValidationError('x').name).toBe('ValidationError');
  });
});
