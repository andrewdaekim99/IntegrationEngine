import { ok, type Result, type IntegrationError, type ValidationError } from '@integr8/core';
import type { SourceConnector, DestinationConnector } from './types.js';

/**
 * NoopSourceConnector — passes signature verification, returns the raw body
 * as-is (cast to TPayload). Useful as a placeholder in tests that exercise
 * the engine plumbing without caring about parsing.
 */
export class NoopSourceConnector<TPayload = unknown> implements SourceConnector<TPayload> {
  readonly name = 'noop-source';

  verifySignature(): Result<void, ValidationError> {
    return ok(undefined);
  }

  parsePayload(rawBody: string): Result<TPayload, ValidationError> {
    return ok(rawBody as TPayload);
  }
}

/**
 * NoopDestinationConnector — always succeeds on deliver + healthcheck.
 * Records (input, idempotencyKey) pairs so tests can assert on what was sent.
 */
export class NoopDestinationConnector<TInput = unknown> implements DestinationConnector<TInput> {
  readonly name = 'noop-destination';
  readonly deliveries: Array<{ input: TInput; idempotencyKey: string }> = [];

  async deliver(
    input: TInput,
    idempotencyKey: string,
  ): Promise<Result<void, IntegrationError>> {
    this.deliveries.push({ input, idempotencyKey });
    return ok(undefined);
  }

  async healthcheck(): Promise<Result<void, IntegrationError>> {
    return ok(undefined);
  }
}
