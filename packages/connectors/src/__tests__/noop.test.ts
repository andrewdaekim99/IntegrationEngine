import { describe, it, expect } from 'vitest';
import {
  runSourceConformance,
  runDestinationConformance,
} from '../conformance.js';
import { NoopSourceConnector, NoopDestinationConnector } from '../noop.js';

runSourceConformance({
  name: 'NoopSourceConnector',
  makeConnector: () => new NoopSourceConnector<string>(),
  validBody: '{"order":1}',
  validHeaders: {},
});

runDestinationConformance({
  name: 'NoopDestinationConnector',
  makeConnector: () => new NoopDestinationConnector<{ orderId: number }>(),
  sampleInput: () => ({ orderId: 1 }),
});

describe('NoopDestinationConnector recording', () => {
  it('captures every delivery with its idempotency key', async () => {
    const dest = new NoopDestinationConnector<{ orderId: number }>();
    await dest.deliver({ orderId: 1 }, 'idem-1');
    await dest.deliver({ orderId: 2 }, 'idem-2');
    expect(dest.deliveries).toEqual([
      { input: { orderId: 1 }, idempotencyKey: 'idem-1' },
      { input: { orderId: 2 }, idempotencyKey: 'idem-2' },
    ]);
  });
});
