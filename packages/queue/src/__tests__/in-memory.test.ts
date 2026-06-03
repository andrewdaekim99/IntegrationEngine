import { runQueueConformance } from '../conformance.js';
import { InMemoryQueue } from '../in-memory.js';

interface Payload {
  message: string;
}

runQueueConformance<Payload>({
  name: 'InMemoryQueue',
  makeQueue: () => new InMemoryQueue<Payload>(),
  samplePayload: () => ({ message: 'hello' }),
});
