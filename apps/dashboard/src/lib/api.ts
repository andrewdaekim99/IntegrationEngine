// Server-side fetch helpers for talking to apps/api. Reads INTERNAL_API_URL
// at runtime — set to `http://api:3010` inside docker-compose, falls back to
// `http://localhost:3010` for `pnpm dev` from the host.

const API_BASE = process.env.INTERNAL_API_URL ?? 'http://localhost:3010';

export async function apiGet<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, { cache: 'no-store', ...init });
  if (!res.ok) {
    throw new Error(`GET ${path} failed: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

export async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '<no body>');
    throw new Error(`POST ${path} failed: ${res.status} — ${text}`);
  }
  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------
// API response types (kept in sync with apps/api by hand; small enough to
// not warrant a shared types package yet).
// ---------------------------------------------------------------------------

export type EventStatus =
  | 'RECEIVED'
  | 'PROCESSING'
  | 'SUCCEEDED'
  | 'DEDUPED'
  | 'RETRYING'
  | 'DEAD_LETTERED';

export type SyncRunOutcome =
  | 'PENDING'
  | 'SUCCEEDED'
  | 'RETRYABLE_FAILURE'
  | 'TERMINAL_FAILURE'
  | 'DEDUPED';

export interface IngestedEventSummary {
  id: string;
  source: string;
  externalId: string;
  topic: string;
  status: EventStatus;
  receivedAt: string;
  processedAt: string | null;
}

export interface SyncRun {
  id: string;
  eventId: string;
  destination: string;
  attempt: number;
  startedAt: string;
  finishedAt: string | null;
  outcome: SyncRunOutcome;
  errorMessage: string | null;
}

export interface DeadLetterItemFull {
  id: string;
  eventId: string;
  lastError: string;
  attempts: number;
  createdAt: string;
  resolvedAt: string | null;
}

export interface IngestedEventDetail extends IngestedEventSummary {
  rawPayload: unknown;
  signatureVerified: boolean;
  syncRuns: SyncRun[];
  deadLetterItem: DeadLetterItemFull | null;
}

export interface DeadLetterRow extends DeadLetterItemFull {
  event: {
    id: string;
    source: string;
    externalId: string;
    topic: string;
    status: EventStatus;
  };
}

export interface EventsListResponse {
  events: IngestedEventSummary[];
  total: number;
  limit: number;
  offset: number;
}

export interface DlqListResponse {
  items: DeadLetterRow[];
  total: number;
  limit: number;
  offset: number;
}
