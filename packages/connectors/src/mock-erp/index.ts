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
 * Input shape the engine hands to the Mock ERP. Stays deliberately small —
 * the Mock ERP doesn't care about Shopify field names, it just stores the
 * payload. Real connectors (Stripe, etc.) define their own input types.
 */
export interface MockErpOrderInput {
  externalRef?: string;
  customer: {
    email: string | null;
    name?: string | null;
  };
  items: Array<{
    sku: string | null;
    quantity: number;
    price: string;
  }>;
  totalAmount: string;
  currency: string;
}

export interface MockErpConnectorOptions {
  baseUrl: string;
  /** Override for tests. Defaults to the global fetch. */
  fetchFn?: typeof fetch;
}

/**
 * DestinationConnector<MockErpOrderInput> — HTTP client for apps/mock-erp.
 *
 * Error classification (the worker's reliability layer reads this):
 *   - network failure / fetch throw  → NetworkError       (retryable)
 *   - 5xx                            → UpstreamServerError (retryable)
 *   - 4xx                            → UpstreamClientError (terminal)
 */
export class MockErpDestinationConnector implements DestinationConnector<MockErpOrderInput> {
  readonly name = 'mock-erp';
  private readonly fetch: typeof fetch;

  constructor(private readonly opts: MockErpConnectorOptions) {
    this.fetch = opts.fetchFn ?? globalThis.fetch;
  }

  async deliver(
    input: MockErpOrderInput,
    idempotencyKey: string,
  ): Promise<Result<void, IntegrationError>> {
    const url = `${this.opts.baseUrl}/orders`;
    let res: Response;
    try {
      res = await this.fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify(input),
      });
    } catch (e) {
      return err(new NetworkError(`mock-erp unreachable at ${url}`, e));
    }

    if (res.status >= 500) {
      const body = await safeText(res);
      return err(new UpstreamServerError(`mock-erp ${res.status}: ${body}`));
    }
    if (res.status >= 400) {
      const body = await safeText(res);
      return err(new UpstreamClientError(`mock-erp ${res.status}: ${body}`));
    }
    return ok(undefined);
  }

  async healthcheck(): Promise<Result<void, IntegrationError>> {
    const url = `${this.opts.baseUrl}/healthz`;
    let res: Response;
    try {
      res = await this.fetch(url);
    } catch (e) {
      return err(new NetworkError(`mock-erp unreachable at ${url}`, e));
    }
    if (!res.ok) {
      return err(new UpstreamServerError(`mock-erp healthz ${res.status}`));
    }
    return ok(undefined);
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '<no body>';
  }
}
