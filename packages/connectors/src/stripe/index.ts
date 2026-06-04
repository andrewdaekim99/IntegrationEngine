import {
  ok,
  err,
  NetworkError,
  UpstreamClientError,
  UpstreamServerError,
  type IntegrationError,
  type Result,
} from '@integr8/core';
import type { DestinationConnector } from '../types.js';

/**
 * Input shape the engine hands to the Stripe destination. The connector turns
 * this into a `POST /v1/payment_intents` against Stripe's test mode.
 *
 *   amount   : smallest currency unit (cents for USD; never decimals).
 *   currency : ISO 4217 lowercase (`usd`, not `USD`).
 *   metadata : passed through verbatim; useful for source_order_id traceability.
 */
export interface StripePaymentIntentInput {
  amount: number;
  currency: string;
  description?: string;
  metadata?: Record<string, string>;
}

export interface StripeConnectorOptions {
  /** Stripe secret key. Use a `sk_test_…` key — never a live key here. */
  apiKey: string;
  /** Override the base URL (defaults to https://api.stripe.com). For tests. */
  baseUrl?: string;
  /** Override fetch for tests. */
  fetchFn?: typeof fetch;
}

/**
 * DestinationConnector<StripePaymentIntentInput> — talks to Stripe's REST API.
 *
 * Error classification (the dispatcher's reliability layer reads this):
 *   - fetch throw          → NetworkError       (retryable)
 *   - 429 Too Many Requests → UpstreamServerError (retryable — Stripe rate limit)
 *   - 5xx                  → UpstreamServerError (retryable)
 *   - 4xx                  → UpstreamClientError (terminal — bad request / auth)
 *
 * Idempotency: pass `idempotencyKey` as Stripe's `Idempotency-Key` header.
 * Stripe dedupes repeated POSTs with the same key for 24h.
 */
export class StripeDestinationConnector implements DestinationConnector<StripePaymentIntentInput> {
  readonly name = 'stripe';
  private readonly fetch: typeof fetch;
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(opts: StripeConnectorOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl ?? 'https://api.stripe.com';
    this.fetch = opts.fetchFn ?? globalThis.fetch;
  }

  async deliver(
    input: StripePaymentIntentInput,
    idempotencyKey: string,
  ): Promise<Result<void, IntegrationError>> {
    const url = `${this.baseUrl}/v1/payment_intents`;
    const body = encodeForm(input);

    let res: Response;
    try {
      res = await this.fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Idempotency-Key': idempotencyKey,
        },
        body,
      });
    } catch (e) {
      return err(new NetworkError(`stripe unreachable at ${url}`, e));
    }

    if (res.status === 429) {
      const detail = await safeText(res);
      return err(new UpstreamServerError(`stripe 429 rate limit: ${detail}`));
    }
    if (res.status >= 500) {
      const detail = await safeText(res);
      return err(new UpstreamServerError(`stripe ${res.status}: ${detail}`));
    }
    if (res.status >= 400) {
      const detail = await safeText(res);
      return err(new UpstreamClientError(`stripe ${res.status}: ${detail}`));
    }
    return ok(undefined);
  }

  async healthcheck(): Promise<Result<void, IntegrationError>> {
    const url = `${this.baseUrl}/v1/balance`;
    let res: Response;
    try {
      res = await this.fetch(url, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });
    } catch (e) {
      return err(new NetworkError(`stripe unreachable at ${url}`, e));
    }
    if (!res.ok) {
      return err(new UpstreamServerError(`stripe healthcheck ${res.status}`));
    }
    return ok(undefined);
  }
}

function encodeForm(input: StripePaymentIntentInput): string {
  const params = new URLSearchParams();
  params.append('amount', input.amount.toString());
  params.append('currency', input.currency);
  if (input.description) params.append('description', input.description);
  if (input.metadata) {
    for (const [k, v] of Object.entries(input.metadata)) {
      params.append(`metadata[${k}]`, v);
    }
  }
  return params.toString();
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '<no body>';
  }
}
