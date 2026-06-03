/**
 * Retry policy for the sync queue.
 *
 * Exponential backoff with optional jitter, capped at maxDelayMs. The schedule
 * for default {base: 1000, max: 30000, maxAttempts: 5}:
 *
 *   attempt 1 fails → wait ~1s  → attempt 2 runs
 *   attempt 2 fails → wait ~2s  → attempt 3 runs
 *   attempt 3 fails → wait ~4s  → attempt 4 runs
 *   attempt 4 fails → wait ~8s  → attempt 5 runs
 *   attempt 5 fails → DLQ (no more retries)
 *
 * Jitter spreads concurrent retries to avoid thundering-herd reconnects on
 * upstream recovery. We use additive jitter up to +25% of the computed delay.
 */

export interface RetryPolicy {
  /** Total attempts allowed (1 = no retry). */
  maxAttempts: number;
  /** Delay before the *first* retry, in milliseconds. */
  baseDelayMs: number;
  /** Upper bound on any single backoff window. */
  maxDelayMs: number;
  /** When true, add 0..25% random jitter on top of the exponential value. */
  jitter: boolean;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 5,
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
  jitter: true,
};

/**
 * Compute the delay before retrying attempt `attempt+1`.
 * `attempt` is 1-indexed (the just-failed attempt).
 */
export function backoffDelayMs(attempt: number, policy: RetryPolicy): number {
  if (attempt < 1) throw new Error(`backoffDelayMs: attempt must be >= 1, got ${attempt}`);
  const expo = Math.min(
    policy.baseDelayMs * 2 ** (attempt - 1),
    policy.maxDelayMs,
  );
  if (!policy.jitter) return expo;
  return Math.round(expo + Math.random() * (expo * 0.25));
}

/** True when this attempt should be retried (under the cap). */
export function shouldRetry(attempt: number, policy: RetryPolicy): boolean {
  return attempt < policy.maxAttempts;
}
