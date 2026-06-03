import { randomUUID } from 'node:crypto';
import net from 'node:net';
import { describe, it } from 'vitest';
import { runQueueConformance } from '../conformance.js';
import { BullMQQueue } from '../bullmq.js';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

// TCP-probe the Redis host:port so the BullMQ conformance suite skips cleanly
// on developer machines without docker-compose up (no ioredis dep in tests).
async function isReachable(url: string): Promise<boolean> {
  const parsed = new URL(url);
  const port = Number(parsed.port || 6379);
  return new Promise((resolve) => {
    const sock = net.connect({ host: parsed.hostname, port }, () => {
      sock.end();
      resolve(true);
    });
    sock.on('error', () => resolve(false));
    setTimeout(() => {
      sock.destroy();
      resolve(false);
    }, 1000);
  });
}

const redisReachable = await isReachable(REDIS_URL);

interface Payload {
  message: string;
}

if (redisReachable) {
  runQueueConformance<Payload>({
    name: 'BullMQQueue',
    makeQueue: () =>
      new BullMQQueue<Payload>({
        queueName: `conformance-${randomUUID()}`,
        redisUrl: REDIS_URL,
      }),
    samplePayload: () => ({ message: 'hello' }),
  });
} else {
  describe.skip('Queue conformance — BullMQQueue (Redis not reachable)', () => {
    it('is skipped', () => {});
  });
}
