import { ok, type IntegrationError, type Result } from '@integr8/core';
import type { DestinationConnector } from './types.js';

type DeliverResult = Result<void, IntegrationError>;
type DeliverHandler = () => DeliverResult | Promise<DeliverResult>;

/**
 * Test helper: a DestinationConnector whose deliver() outcomes are scripted in
 * advance. Each `on(handler)` call queues one response for the next deliver().
 * If the queue is empty, default behavior is `ok(undefined)`.
 *
 * Records every delivery for assertions.
 *
 *   const dest = new ControllableDestinationConnector<MockErpOrderInput>()
 *     .on(() => err(new UpstreamServerError('500 once')))
 *     .on(() => err(new UpstreamServerError('500 twice')))
 *     .on(() => ok(undefined));
 */
export class ControllableDestinationConnector<TInput = unknown>
  implements DestinationConnector<TInput>
{
  readonly name = 'controllable';
  readonly deliveries: Array<{ input: TInput; idempotencyKey: string }> = [];
  private readonly scripted: DeliverHandler[] = [];

  on(handler: DeliverHandler): this {
    this.scripted.push(handler);
    return this;
  }

  async deliver(input: TInput, idempotencyKey: string): Promise<DeliverResult> {
    this.deliveries.push({ input, idempotencyKey });
    const next = this.scripted.shift();
    return next ? next() : ok(undefined);
  }

  async healthcheck(): Promise<DeliverResult> {
    return ok(undefined);
  }
}
