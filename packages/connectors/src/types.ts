import type {
  IntegrationError,
  Result,
  ValidationError,
} from '@integr8/core';

/**
 * SourceConnector<TPayload> — adapts an external system's inbound surface
 * (webhook, poll, push) into a verified, parsed payload the engine can route.
 *
 * The two methods are kept separate so the API endpoint can short-circuit on
 * a bad signature before even attempting to parse the body — failed signature
 * verification means "untrusted input", not "malformed input".
 */
export interface SourceConnector<TPayload> {
  readonly name: string;

  /** Validate the HMAC (or equivalent) on a raw request body + headers. */
  verifySignature(
    rawBody: string,
    headers: Record<string, string>,
  ): Result<void, ValidationError>;

  /** Parse the raw body into a strongly-typed payload. */
  parsePayload(rawBody: string): Result<TPayload, ValidationError>;
}

/**
 * DestinationConnector<TInput> — adapts an external system's outbound surface
 * (HTTP POST, SDK call, DB insert). The engine calls `deliver` with an
 * idempotency key derived from the source event id so retries from the
 * worker never produce duplicate side effects downstream.
 */
export interface DestinationConnector<TInput> {
  readonly name: string;

  deliver(
    input: TInput,
    idempotencyKey: string,
  ): Promise<Result<void, IntegrationError>>;

  /** Cheap probe — used by the dashboard / readiness checks. */
  healthcheck(): Promise<Result<void, IntegrationError>>;
}
