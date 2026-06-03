import { describe, it, expect } from 'vitest';
import { ok, err, isOk, isErr, type Result } from '../result.js';

describe('Result', () => {
  it('ok carries a value', () => {
    const r: Result<number> = ok(42);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(42);
  });

  it('err carries an error', () => {
    const e = new Error('boom');
    const r: Result<number> = err(e);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe(e);
  });

  it('isOk and isErr narrow the type', () => {
    const r: Result<number> = ok(7);
    expect(isOk(r)).toBe(true);
    expect(isErr(r)).toBe(false);
  });
});
