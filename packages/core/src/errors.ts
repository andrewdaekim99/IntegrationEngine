// Error hierarchy. The single most important distinction in this codebase is
// retryable vs terminal — the worker's reliability machinery reads `retryable`
// to decide whether to re-enqueue with backoff or send straight to DLQ.
//
//   IntegrationError (abstract)
//     ├── RetryableError       — transient; try again with backoff
//     │     ├── NetworkError
//     │     └── UpstreamServerError      (5xx)
//     └── TerminalError        — permanent; straight to DLQ
//           ├── ValidationError           (bad payload, schema mismatch)
//           ├── UpstreamClientError       (4xx)
//           └── ConfigurationError        (missing mapping, bad credentials)

export abstract class IntegrationError extends Error {
  abstract readonly retryable: boolean;

  constructor(
    message: string,
    public override readonly cause?: unknown,
  ) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = this.constructor.name;
    if (typeof Error.captureStackTrace === 'function') {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

export class RetryableError extends IntegrationError {
  readonly retryable = true as const;
}

export class TerminalError extends IntegrationError {
  readonly retryable = false as const;
}

// Concrete retryable failures
export class NetworkError extends RetryableError {}
export class UpstreamServerError extends RetryableError {}

// Concrete terminal failures
export class ValidationError extends TerminalError {}
export class UpstreamClientError extends TerminalError {}
export class ConfigurationError extends TerminalError {}

export const isIntegrationError = (e: unknown): e is IntegrationError =>
  e instanceof IntegrationError;
