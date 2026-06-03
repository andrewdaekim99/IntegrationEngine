# Architecture decisions

A running log of non-obvious choices, with the alternative considered and the reason.
New entries go at the top.

---

## 2026-06-03 — Phase 5 dashboard

### D37. Next.js App Router + server components for all data fetching

The dashboard never fetches from the browser. Server components call apps/api
directly over the docker network (`INTERNAL_API_URL=http://api:3010`), render
the result, and stream HTML. Browser receives ready-rendered pages. Trade-offs:
no CORS to configure, no API leakage to the client bundle, no fetch-on-mount
race; in exchange every interaction requires a server round trip. Fine for
an internal admin UI — the gain in security + simplicity beats client-side
state for a list/detail/replay workflow.

### D38. Replay uses a Next.js Server Action, not a route handler

`apps/dashboard/src/app/dlq/actions.ts` exports `replayDlqItem(dlqId)` marked
`'use server'`. The client `<ReplayButton>` calls it directly — no `/api/...`
proxy route, no fetch with a CSRF token. After the action returns ok, the
client triggers `router.refresh()` and the page re-renders with fresh data
(server-component re-fetch). `revalidatePath('/dlq')` invalidates the cache
even if the user navigates away. Cleanest stack for "POST a server action,
then re-render this page."

### D39. shadcn/ui (copied components) over a packaged UI library

Components live in `apps/dashboard/src/components/ui/` rather than a `node_modules`
dep. Costs: more code to read in PRs, manual updates when shadcn upstream
changes. Wins: zero version-lock-in risk, easy to fork a component's
behavior, no hidden dep tree, Tailwind class names are right there to edit.
For a portfolio dashboard with ~6 primitives (Button/Badge/Table/Card/Input/
Skeleton), that's a one-time cost worth paying.

### D40. Vitest `environmentMatchGlobs` for per-file jsdom

Most of the test suite is Node (Prisma, queue conformance, error hierarchy).
The dashboard component tests need jsdom + JSX. Rather than splitting into
two vitest configs (or worse, two test commands), one root config matches
`apps/dashboard/**/*.test.tsx?` → jsdom and everything else → node, with a
single `@` → `apps/dashboard/src` resolve alias. Plus `esbuild: { jsx: 'automatic' }`
so .tsx files don't need an explicit React import. Net: `pnpm test` runs all
62 tests in one pass, ~700ms.

### D41. `INTERNAL_API_URL` env var, server-only

Reads `process.env.INTERNAL_API_URL` directly (no zod / no `NEXT_PUBLIC_*`).
Docker-compose overrides to `http://api:3010` for the dashboard container; the
host `.env` keeps `http://localhost:3010` for `pnpm dev` from terminal. Never
exposed to the client bundle — server components run on the Node side, the
browser only sees the rendered HTML.

---

## 2026-06-03 — Phase 4 reliability core (the headline)

### D30. At-least-once delivery + consumer-side dedupe over exactly-once

BullMQ (and SQS in Phase 8) are at-least-once: a worker crash mid-process means
the job comes back. We pay that cost and *make processing idempotent at the
consumer* instead of paying the much higher cost (and limited correctness) of
exactly-once delivery. The dedupe check in `dispatch()` is one query —
`syncRun.findFirst { eventId, outcome: SUCCEEDED }`. If any prior SUCCEEDED row
exists, the new delivery writes a `DEDUPED` SyncRun, never touches the
destination, and acks. Covers: queue redelivery after crash, accidental
double-enqueue, and Shopify retrying webhook delivery faster than we ack.

### D31. Exponential backoff with jitter; 5 attempts; cap at 30s

`DEFAULT_RETRY_POLICY = { maxAttempts: 5, baseDelayMs: 1_000, maxDelayMs: 30_000, jitter: true }`.
Delays before each retry: 1s, 2s, 4s, 8s (jitter adds up to +25%). Total
worst-case wait ≈ 15s spread across 5 attempts. Jitter prevents thundering-herd
reconnects when the upstream recovers. The schedule's hardcoded for now; Phase 6
or Phase 9 could move it to `MappingConfig` if per-destination tuning matters.

### D32. Postgres `DeadLetterItem` is the source of truth; queue DLQ is unused

The dispatcher writes a row to `DeadLetterItem` and `ack`s the queue rather than
calling `queue.moveToDLQ`. Reasons: (a) the dashboard reads from Postgres
regardless, so two DLQ stores would drift; (b) replay needs Postgres state
anyway (which event, how many attempts, last error); (c) the queue's DLQ is
strictly there for the Phase 1 conformance contract. Keeps a single source of
truth and a single replay path (`POST /dlq/:id/replay`).

### D33. Replay re-enqueues, doesn't preemptively mark resolved

`POST /dlq/:id/replay` resets the event status to `RECEIVED` and enqueues a
fresh job with attempt=1 — but leaves the `DeadLetterItem` row open. The worker
marks `resolvedAt` only after a successful `SyncRun`. If the replay fails again,
the row is updated (same id, new lastError, new attempts) rather than creating
a duplicate. Avoids the false-positive of "marked resolved but failed again."

### D34. Failure routing lives in `dispatch()`, not `processEvent()`

`processEvent()` updates `IngestedEvent.status` only on success. Failures
return a typed outcome (`RETRYABLE_FAILURE` / `TERMINAL_FAILURE` / `NOT_FOUND`)
and `dispatch()` decides: nack with backoff, write `DeadLetterItem`, etc.
Concentrates all reliability decisions in one place that tests can drive
directly without spinning up the queue or HTTP.

### D35. `ControllableDestinationConnector` enables the headline test suite

Test helper in `packages/connectors`: a destination whose deliver() outcomes
are scripted in advance via `.on(() => ok(...))` / `.on(() => err(...))`. The
6-test reliability suite (dedupe, retry-then-succeed, exhaust-to-DLQ, terminal,
replay-resolves-DLQ, crash-still-dedupes) drives it against the real dispatcher
and real Postgres without any network or sleeps. Same pattern any new
destination adapter can use for its own tests.

### D36. Tests clean up via `IngestedEvent` cascade delete, scoped by prefix

`DeadLetterItem` and `SyncRun` both `onDelete: Cascade` on `eventId`, so the
Phase 4 test `beforeEach` deletes only `IngestedEvent` rows whose `externalId`
starts with `phase4-`. The cascade tears down the dependent rows; rows from
the concurrently-running Phase 3 live-stack integration test (which uses a
`Date.now()`-style externalId) are untouched. Surgical cleanup beats global
`deleteMany()` for any DB-shared test suite.

---

## 2026-06-03 — Phase 3 happy-path end-to-end

### D24. Custom JSON content-type parser preserves the raw body

Shopify's HMAC is over the exact bytes Shopify sent. If Fastify parses
`req.body` to an object and we re-stringify for verification, the recomputed
HMAC drifts (key order, whitespace, number formatting). The API removes the
default JSON parser and registers one that passes the raw string through as
`req.body`. The route then calls the connector's `parsePayload` to re-parse.
Affects only POST/PUT routes; `/healthz` and future GETs are unaffected.

### D25. Enqueue only the eventId, not the full payload

`SyncJobPayload = { eventId: string }` — the worker loads the `IngestedEvent`
row to read the raw body. Keeps Redis small, makes the DB the source of truth
(if the queue is wiped, the DB still has every event), and means Phase 4's
replay-from-DLQ is "re-enqueue the same eventId" rather than "reconstruct the
payload from the DLQ record."

### D26. Idempotency key sent to Mock ERP = `event-{eventId}`

Deterministic from the eventId, not the queue's JobId, so a Phase 4 retry of
the same event uses the same key — Mock ERP's unique constraint dedupes it
naturally. If we'd used the JobId, every retry would create a fresh row.

### D27. Phase 3 ack-everything (failures recorded but not retried)

Per ROADMAP §Phase 3: "no reliability features yet." On every outcome the
worker calls `queue.ack(job.id)`. Failures are still observable — they appear
as `SyncRun` rows with `outcome = RETRYABLE_FAILURE` / `TERMINAL_FAILURE` and
the `IngestedEvent` is marked `DEAD_LETTERED`. Phase 4 replaces this with
`queue.nack(retryAfterMs: backoff)` and `queue.moveToDLQ(jobId, error)`.

### D28. Hard-coded Shopify → MockErp mapping lives in apps/worker

`mapShopifyOrderToMockErp` is in `apps/worker/src/mapping.ts`. Phase 6 will
replace the call site with a lookup of the active `MappingConfig` row, but
the type signature (`ShopifyOrder` → `MockErpOrderInput`) is the contract the
AI-proposed mapping must honor — so this function doubles as the schema the
Mapping Studio is allowed to produce.

### D29. Integration test runs against the live docker stack, skips when down

Vitest health-checks the API + Postgres at import time. If reachable, the
suite runs; otherwise `describe.skip`. Keeps `pnpm test` green on a cold
machine without docker-compose up, and gives a single command (`pnpm test`)
that's locally meaningful when the stack is up. Trade-off vs an in-process
test rig: more setup-y, but it exercises the real production path including
the Fastify wiring, the BullMQ adapter, and the real Mock ERP DB write.

---

## 2026-06-03 — Phase 2 concrete adapters

### D17. BullMQ bridge for explicit ack / nack / moveToDLQ

BullMQ is auto-ack — handler returns = complete, handler throws = retry. Our
`Queue<T>` interface is explicit (the handler calls `queue.ack(id)` /
`queue.nack(id)` / `queue.moveToDLQ(id, err)` itself). The adapter bridges the
gap by stashing a per-job `decisions` resolver in a Map keyed by `JobId`, then
awaiting the resolver inside the BullMQ worker function. `ack`/`nack`/`moveToDLQ`
just look up the resolver and call it. Trade-off: holds one Promise per
in-flight job in memory — fine for our concurrency targets.

### D18. Separate `${queueName}-dlq` Bull queue, not failed-job retention

BullMQ's "failed" state is transient and tied to the original job, so listing
DLQ items would mean iterating failed jobs across the main queue. Routing
moveToDLQ writes to a dedicated `${queueName}-dlq` Bull queue makes
`listDeadLetters` a single `getJobs(['waiting'])` call and replay a clean
re-enqueue → remove pair.

### D19. BullMQ connection via URL config, not a Redis instance

ioredis 5.10.x (BullMQ-bundled) and 5.11.x (latest) have structurally
incompatible types — passing a `new Redis(url)` from one version to BullMQ from
the other fails typecheck. Passing `{ url, maxRetriesPerRequest: null }` lets
BullMQ construct its own connection internally; no direct ioredis dep in
`@integr8/queue`. The Redis-reachability probe in tests uses a raw `net.connect`
so it doesn't depend on ioredis at all.

### D20. Shopify HMAC verification with `crypto.timingSafeEqual`

Standard defense against timing attacks on the webhook secret. The compare is
on Buffers of equal length (the base64-encoded HMAC strings); length mismatch
short-circuits to `false` without calling `timingSafeEqual` (which would throw
on length mismatch). The signing helper (`signShopifyBody`) is exported for
test fixtures only.

### D21. `ShopifyOrder` zod schema is intentionally narrow

Real Shopify webhooks have ~100 fields. The schema declares only what the
engine reads when mapping to destinations (id, totals, line items, customer,
shipping). Zod is permissive about unknown keys by default and we don't call
`.strict()` — that way new Shopify fields don't break ingestion. Every field
the worker *reads*, however, must be declared here so a typo at the call site
is a type error, not a runtime undefined.

### D22. `MockErpOrder` in the same Postgres database

Architecturally the engine treats apps/mock-erp as a separate system (talks to
it over HTTP, same as a real ERP). Practically, sharing one Postgres avoids a
second Prisma schema, a second container, and a second migration story for a
demo project. The contract — "engine code never imports `MockErpOrder` from
`@integr8/db`" — is enforced by review, not by schema isolation. If we ever
need real isolation (multi-tenant demo, second source connector), splitting
the schema is a couple-day refactor, not a redesign.

### D23. Idempotency in mock-erp: findUnique → create → catch unique violation

The classic idempotent-insert pattern with a race-safe fallback. Two concurrent
requests with the same `Idempotency-Key` both pass `findUnique` (both see no
row), both attempt `create`, the database's `@unique` constraint lets exactly
one win, the loser catches `P2002 / "Unique constraint"` and reads back the
winner's row. Returned `status` field tells the caller `"created"` vs
`"duplicate"` for log clarity; the row body is identical either way.

---

## 2026-06-03 — Phase 1 domain model & core interfaces

### D9. Idempotency key = `(source, externalId, topic)` UNIQUE on `IngestedEvent`

The same Shopify webhook can fire multiple times for retries. Dedupe needs to be a
primary-key collision on insert, not a SELECT-then-decide race. The triple
`(source, externalId, topic)` is exactly that key — a `create` and an `update` for the
same order are different rows, but a re-delivered `create` collides cleanly. Worker
processing also stays idempotent on this same key.

### D10. `MappingConfig.isActive` enforced at the app layer, not via a partial unique index

Postgres supports `CREATE UNIQUE INDEX ... WHERE isActive` but Prisma's `@@unique` is
unconditional. Rather than reach for a raw-SQL migration, the worker query is
`WHERE source AND destination AND isActive=true ORDER BY version DESC LIMIT 1`, and
the approval flow flips the previous active row to `false` in the same transaction
as creating the new one. Trade-off: a malformed admin path could leave two actives;
the worker's `LIMIT 1` keeps things safe.

### D11. Tiny `Queue<T>` interface — explicit `ack` / `nack` / `moveToDLQ`

The interface only covers what every backend (BullMQ, SQS, in-memory) has a native
analogue for. Auto-ack-on-handler-return was tempting but couples retry semantics
into the queue layer; the worker (Phase 4) wants to decide retry-vs-DLQ based on
the error *type* (retryable vs terminal), which is engine concern, not transport.

### D12. Retryable vs Terminal error hierarchy

Two abstract classes, `RetryableError` and `TerminalError`, with concrete subclasses
(`NetworkError`, `ValidationError`, etc.). The single boolean `.retryable` flag is the
only thing the reliability machinery reads — adding new error categories doesn't
require touching the retry/DLQ code. Throwing `instanceof RetryableError` from
the worker handler means "nack + backoff"; `TerminalError` means "DLQ immediately".

### D13. Branded ID types via intersection brand

`type EventId = string & { readonly __brand: 'EventId' }` is zero-cost at runtime
and stops the compiler from letting you pass an `EventId` where a `SyncRunId` is
expected. With four different ID types flying around the worker (event, run, DLQ,
mapping), this catches a real class of bug. The constructor function (e.g.
`EventId(s)`) keeps the cast local and grep-able.

### D14. `Result<T, E>` for expected failures, `throw` for programmer errors

The worker pipeline (verify → parse → map → deliver) is a chain where any step
can fail in expected ways. Returning `Result<T, E>` from each step keeps the
control flow visible without try/catch noise, and the typed `E` carries the
retryable/terminal distinction up to the dispatcher. Genuine bugs (assertion
failures, "this should never happen") still throw — they shouldn't be caught.

### D15. Conformance suite as an exported test function

`runQueueConformance({ makeQueue, samplePayload })` lives in
`packages/queue/src/conformance.ts` and is imported by the in-memory adapter's
tests today, and will be imported by the BullMQ adapter (Phase 2) and the SQS
adapter (Phase 8) tomorrow. Same green bar for every driver, no copy/paste of
test files between adapters. Same pattern for `runSourceConformance` and
`runDestinationConformance` in `packages/connectors`.

### D16. Postgres on host port 5433, not 5432

The Docker postgres container still listens on 5432 internally, but the host
port mapping is 5433 because the user already runs Postgres.app on 5432. The
container-to-container DATABASE_URL (`postgres:5432`) is unaffected; only the
host-side `DATABASE_URL` in `.env` (used by `pnpm db:migrate` from terminal)
uses 5433. Avoids stepping on the developer's other projects.

---

## 2026-06-03 — Phase 0 scaffolding

### D1. Project named "integr8"

The working title in `PROJECT_DIRECTION.md` was "Patchbay". We changed it before any
code was written so package names, container names, and docs settle on one identity
from day one. `PROJECT_DIRECTION.md` is left as-is (the vision doc); everything else
says "integr8".

### D2. pnpm workspaces over npm/Yarn/Nx/Turborepo

We need a monorepo for `apps/*` + `packages/*` (see CLAUDE.md §Repo structure).
`pnpm` gives us workspaces natively, deduplicates `node_modules` across packages, and
keeps installs fast on cold clones. We considered `Turborepo` and `Nx` for task
orchestration but the project is small enough that `pnpm -r run <script>` covers what
we need — adding Turbo now would be premature.

### D3. TypeScript `strict` + `noUncheckedIndexedAccess`, NodeNext for Node apps

`strict` is non-negotiable per CLAUDE.md. `noUncheckedIndexedAccess` catches a class
of bugs (`arr[i]` is `T | undefined`) that matter in retry/queue code. We use
`module: NodeNext` for Node apps so ESM resolution matches production semantics; the
Next.js dashboard overrides to `Bundler` because Next requires it.

### D4. Fastify over Express

Fastify's schema-based validation, native pino integration, and async-first design fit
this codebase (which validates everything with zod and logs with pino) more cleanly
than Express middleware. Express would also work; Fastify gets us slightly better
ergonomics for the same complexity budget.

### D5. Prisma over Drizzle

Prisma's schema-first model and `prisma migrate dev` are a clear win for a portfolio
project that needs reviewers to grok the data model fast (the `schema.prisma` file is
self-documenting). Drizzle's runtime perf edge doesn't matter at this scale. The cost
is the generated client and the runtime — both acceptable for a hobbyist iPaaS.

### D6. pino with `pino-pretty` in dev, JSON in production

Structured logging is required (CLAUDE.md §Coding conventions). Pretty output in
dev keeps logs readable while developing; JSON in production is what CloudWatch /
log aggregators expect. The mode flips automatically based on `NODE_ENV`.

### D7. Single shared `Dockerfile` parameterized by `APP_NAME`

Each app (`api`, `worker`, `mock-erp`, `dashboard`) has nearly identical build steps
(install workspace deps, change into its directory, run its dev script). One
parameterized Dockerfile avoids four near-duplicate files. Trade-off: when one app
needs a substantially different build (e.g. the dashboard's eventual `next build`),
we'll either branch on `APP_NAME` or split that one out — revisit in Phase 8.

### D8. zod env validation in `packages/core`, fail-fast at startup

Every app calls `loadEnv()` as its first statement. Missing or malformed env vars
print the offending keys to stderr and exit non-zero, so misconfiguration surfaces
immediately rather than as a confusing runtime error two minutes later.
