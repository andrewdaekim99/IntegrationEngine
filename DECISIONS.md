# Architecture decisions

A running log of non-obvious choices, with the alternative considered and the reason.
New entries go at the top.

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
