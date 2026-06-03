import { describe, it, expect } from 'vitest';
import { EventId, SyncRunId } from '../ids.js';

describe('branded ids', () => {
  it('wrap strings at runtime without modification', () => {
    const id = EventId('abc-123');
    expect(id).toBe('abc-123');
  });

  it('are distinct types at compile time', () => {
    const event = EventId('e1');
    const run = SyncRunId('s1');
    // Runtime: just strings. Compile-time: not assignable to each other.
    expect(typeof event).toBe('string');
    expect(typeof run).toBe('string');
  });
});
