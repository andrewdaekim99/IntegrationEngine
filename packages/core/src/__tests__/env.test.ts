import { describe, it, expect } from 'vitest';
import { z } from 'zod';

describe('packages/core sanity', () => {
  it('vitest + zod are wired up', () => {
    const schema = z.object({ foo: z.string() });
    expect(schema.parse({ foo: 'bar' })).toEqual({ foo: 'bar' });
  });
});
