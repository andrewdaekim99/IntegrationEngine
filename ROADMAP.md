# ROADMAP — integr8

A phased, dependency-aware build plan for the integration engine described in
[`PROJECT_DIRECTION.md`](./PROJECT_DIRECTION.md). Sequenced so that **foundations the
whole project depends on are built first**, the **headline reliability features** land
before any UI polish, and **every phase ends in a demoable, runnable state**.

---

## How to read this roadmap

- Each phase has a **goal**, a **deliverables checklist**, a **definition of done (DoD)**,
  and a **demo** — the one thing you should be able to show at the end of the phase.
- Phases that require things **only you can do** (sign up for an external service, paste
  a secret into `.env`, run an interactive CLI login, take a screenshot, click around a
  third-party UI) also include a **Manual steps (you)** checklist. Phases without that
  section can be completed entirely by Claude — no action needed from you beyond review.
- Phases 0 → 5 are the **core build** (the portfolio centerpiece). Phases 6 → 9 are
  **stretch** and intentionally optional per `PROJECT_DIRECTION.md` §3 and §6.
- Ordering principle: anything **expensive to change later** (monorepo layout, TS config,
  DB schema, queue/connector interfaces) ships in the earliest phase it is meaningfully
  testable. UI and AI features ship last — they depend on a reliable engine, not the
  other way around.
- Each phase is one PR (or one tight series of PRs) per the conventions in `CLAUDE.md`.

---

## Phase 0 — Repo foundation & local dev loop ✅ COMPLETE

**Goal:** A clean monorepo where `docker-compose up` boots an empty-but-wired stack and
`pnpm test` / `pnpm typecheck` / `pnpm lint` all pass on a no-op codebase. Nothing
functional yet — just the rails everything else will run on.

This phase is deliberately heavy because every shortcut here costs 10x later.

### Deliverables

- [x] `pnpm` workspace root with `apps/*` and `packages/*` per `CLAUDE.md` §Repo structure.
- [x] Root `tsconfig.base.json` with `strict: true`, `noImplicitAny`, `noUncheckedIndexedAccess`;
      per-package `tsconfig.json` extending the base.
- [x] ESLint + Prettier configured at the root and inherited by all workspaces.
- [x] Vitest configured at the root; one trivial passing test in `packages/core`.
- [x] `docker-compose.yml` with services: `postgres`, `redis`, plus `api`, `worker`,
      `dashboard`, `mock-erp` containers (api + mock-erp expose `/healthz`).
- [x] `.env.example` listing every var named in `CLAUDE.md` §Environment; zod-based
      `env.ts` loader in `packages/core` so all apps fail fast on missing config.
- [x] `packages/db` initialized with Prisma (empty schema, generated client, migration
      command wired into `pnpm db:migrate`).
- [x] pino logger factory in `packages/core` — used by every app.
- [x] All scripts in `CLAUDE.md` §Commands work (`pnpm install`, `dev`, `test`, `lint`,
      `format`, `typecheck`, `db:migrate`, `db:generate`).
- [x] `README.md` skeleton + first 8 entries in `DECISIONS.md` (project name, pnpm,
      TS strict, Fastify, Prisma, pino, shared Dockerfile, zod env loader).
- [x] `.gitignore` covering `.env`, `node_modules`, `dist`, Prisma client, build outputs.

### Manual steps (you)

- [x] Install **Node 20+** (you had Node 22 already).
- [x] Install **pnpm** globally (via corepack).
- [x] Install **Docker Desktop** and confirm `docker` + `docker compose` work.
- [x] **Decide the final project name** — chose **integr8** (overrides "Patchbay" working title).
- [x] Run `git init` in this directory.
- [x] Create the GitHub repo (`andrewdaekim99/IntegrationEngine`) and wire it as `origin`.
- [x] Copy `.env.example` to `.env` so docker-compose can boot.

### Definition of done

- Cold clone → `pnpm install` → `cp .env.example .env` → `docker-compose up` boots the
  full stack with no errors. ✅
- `pnpm test`, `pnpm typecheck`, `pnpm lint` all green. ✅

### Demo

- Terminal: `docker-compose up` shows all six services running.
- API healthcheck: `curl localhost:3010/healthz` → `{"ok":true,"service":"api"}`.
- Mock ERP healthcheck: `curl localhost:3002/healthz` → `{"ok":true,"service":"mock-erp"}`.
- Dashboard: <http://localhost:3003> renders the Phase 0 placeholder.

---

## Phase 1 — Domain model & core interfaces ✅ COMPLETE

**Goal:** Define the contracts the rest of the system will implement against. No business
logic yet — just types, schemas, and interfaces. **This is the phase that determines
whether the connector + queue abstractions actually pay off later.**

### Deliverables

- [x] Prisma schema for the persistence model:
  - `IngestedEvent` (id, source, externalId, topic, rawPayload jsonb, signatureVerified,
    receivedAt, processedAt nullable, status enum).
  - `SyncRun` (id, eventId fk, destination, attempt, startedAt, finishedAt, outcome enum,
    errorMessage).
  - `DeadLetterItem` (id, eventId fk unique, lastError, attempts, createdAt, resolvedAt nullable).
  - `MappingConfig` (id, sourceSystem, destinationSystem, version, fields jsonb, isActive,
    approvedBy, approvedAt, createdAt).
  - Indexes: `(source, externalId, topic)` UNIQUE = idempotency key; `status` for dispatch;
    `resolvedAt` for DLQ unresolved filter.
- [x] First migration applied (`20260603214346_init`); Prisma client regenerated.
- [x] `packages/core` domain types — branded ids (EventId, SyncRunId, …), `Result<T, E>`,
      typed error hierarchy (`IntegrationError` → `RetryableError` / `TerminalError`).
- [x] `packages/queue` — `Queue<T>` interface (`enqueue`, `consume`, `ack`, `nack`,
      `moveToDLQ`, `listDeadLetters`, `replayDeadLetter`, `close`) + `InMemoryQueue` impl.
- [x] `packages/connectors` — `SourceConnector` + `DestinationConnector` interfaces + `NoopSourceConnector` + `NoopDestinationConnector` (recording) fakes.
- [x] Vitest contract tests: `runQueueConformance`, `runSourceConformance`,
      `runDestinationConformance` exported from each package's `./conformance` subpath.
      24 tests passing total.

### Definition of done

- Migrations apply cleanly on a fresh DB. ✅
- Contract tests pass against the in-memory fakes (24/24). ✅
- No concrete provider (BullMQ, Shopify) imported anywhere in `packages/core`. ✅

### Demo

- `pnpm test` shows 6 test files / 24 tests passing — queue + connector conformance
  suites both green against their respective noop/in-memory fakes.

---

## Phase 2 — Concrete adapters (BullMQ + Mock ERP) ✅ COMPLETE

**Goal:** First real implementations of the interfaces from Phase 1, validated against
the same conformance suite. Still no end-to-end flow — we're proving the abstractions
work with one real provider each before wiring the engine together.

### Deliverables

- [x] `packages/queue/bullmq.ts` — BullMQ + Redis implementation of `Queue<T>`. Bridges
      BullMQ's auto-ack to explicit ack/nack/moveToDLQ via per-job decision promises.
      Separate `${queueName}-dlq` Bull queue for the DLQ. Passes the Phase 1 conformance
      suite (5/5).
- [x] `apps/mock-erp` — Fastify service with `POST /orders` (Idempotency-Key required) +
      `/healthz`. Backed by Prisma `MockErpOrder` model with `idempotencyKey @unique`.
      Race-safe via findUnique → create → catch-unique-violation pattern.
- [x] `packages/connectors/mock-erp` — `DestinationConnector` HTTP client. Maps fetch
      throw → `NetworkError` (retryable), 5xx → `UpstreamServerError` (retryable),
      4xx → `UpstreamClientError` (terminal). 8 tests including conformance + header pass-through.
- [x] `packages/connectors/shopify` — `SourceConnector` with HMAC-SHA256 verification
      (`crypto.timingSafeEqual`) + zod schema for the order webhook. Header lookup is
      case-insensitive. 8 tests across HMAC + parsing including tampered/wrong-secret/missing.
- [x] `docker-compose.yml` already mounts mock-erp; image rebuilt with the new endpoint.

### Definition of done

- BullMQ adapter passes the same conformance suite the in-memory fake did. ✅ (5/5)
- Mock ERP destination connector round-trips a synthetic payload via mocked fetch
  - curl-verified end-to-end against the live container. ✅
- Shopify HMAC verifier rejects a tampered fixture and accepts a known-good one. ✅

### Demo

- `pnpm test` → 45 tests across 9 files, all green.
- Live: `curl -X POST http://localhost:3002/orders -H 'Idempotency-Key: k1' -d '{}'`
  returns 201 on first call, 200 + same row on the second.

---

## Phase 3 — Happy-path end-to-end ✅ COMPLETE

**Goal:** A real Shopify order webhook lands in the API and a row appears in Mock ERP.
No reliability features yet (no retry, no DLQ) — just prove the pipe is connected.

### Deliverables

- [x] `apps/api` — Fastify server with `POST /webhooks/shopify/orders`:
  1. verify HMAC (custom JSON parser keeps raw body),
  2. persist raw `IngestedEvent` (status = `RECEIVED`); composite-unique key handles dedupe,
  3. enqueue a job referencing the event id (`SyncJobPayload = { eventId }`),
  4. returns 200 + eventId only after persistence + enqueue succeed.
- [x] `apps/worker` — standalone Node process that consumes the queue:
  1. load the event from DB,
  2. hard-coded mapping (Shopify order → Mock ERP order shape) in `mapping.ts`,
  3. call the Mock ERP destination connector with `event-{eventId}` idempotency key,
  4. write a `SyncRun` row with the outcome,
  5. update event status to `SUCCEEDED` / `DEAD_LETTERED`.
- [x] Structured pino logs at every step, tagged with `eventId`, `jobId`, `runId`,
      `attempt`. Same `eventId` traces cleanly across api + worker logs.
- [x] Integration test in `apps/api/src/__tests__/integration-e2e.test.ts` against the
      live docker stack: signs + posts a webhook, polls Postgres for SUCCEEDED, asserts
      the `IngestedEvent → SyncRun → MockErpOrder` chain. Skips when stack is down.
- [x] `pnpm dev:send-test-webhook` script signs the bundled fixture and posts to local API.

### Manual steps (you)

- [x] Create a **Shopify Partners account** (free) at partners.shopify.com.
- [x] Create a **development store** under that Partners account (free, no card).
- [x] Add a sample product and a test customer to the dev store so orders can be placed.
- [x] Install **ngrok** + sign up + add auth token.
- [x] Start ngrok pointing at the local API: `ngrok http 3010`.
- [x] In the dev store admin, register a webhook for the **`orders/create`** topic
      pointing at `<ngrok-https-url>/webhooks/shopify/orders` (JSON format).
      **Note:** free-tier ngrok URLs end in `.ngrok-free.dev` (not `.app`).
- [x] Copy the **webhook signing secret** Shopify shows you into `.env` as
      `SHOPIFY_WEBHOOK_SECRET`; then `docker compose up -d --force-recreate api`
      to actually reload the env (`restart` does NOT re-read env_file).
- [x] Trigger a real Shopify webhook (via _Send test notification_ button on the
      Webhooks page) — HMAC verifies, worker delivers, mock-erp row written.
- [ ] _(Optional)_ Save 1–2 real webhook payloads as fixtures in
      `packages/connectors/src/shopify/__fixtures__/` so future tests don't need the tunnel.

### Definition of done

- End-to-end test green. ✅ (46/46 tests passing including the integration test)
- Logs from a real local run clearly show the event id flowing through API → queue → worker → ERP. ✅
  - Same `eventId` appears in `api-1` "shopify webhook ingested + enqueued" and
    `worker-1` "delivery succeeded" / "event completed".

### Demo

- Terminal: `docker compose logs -f api worker`, then `pnpm dev:send-test-webhook` —
  webhook in → worker logs `outcome: SUCCEEDED` → row appears in `mock_erp_order` table.

---

## Phase 4 — Reliability core (THE HEADLINE) ✅ COMPLETE

**Goal:** Idempotency, retry-with-backoff, DLQ, and manual replay — all with tests.
Per `CLAUDE.md` §7: _"reliability paths must have tests. They are the headline feature."_
**Nothing in later phases is more important than this phase being rock-solid.**

### Deliverables

- [x] **Consumer-side dedupe** in `dispatch()`: if any prior SUCCEEDED `SyncRun` exists
      for the eventId, a new delivery writes a `DEDUPED` SyncRun and acks — no
      destination call. Catches at-least-once redelivery, accidental double-enqueue,
      and Shopify retrying webhook delivery faster than we ack.
- [x] **Retry with exponential backoff + jitter** via `apps/worker/src/retry-policy.ts`.
      Default: 5 attempts, baseDelayMs=1000, maxDelayMs=30_000, +0..25% jitter.
- [x] **DLQ routing**: terminal failures or exhausted retries write/update a
      `DeadLetterItem` row + set `IngestedEvent.status = DEAD_LETTERED`. Postgres is
      the source of truth; the queue's DLQ is unused operationally (see DECISIONS D32).
- [x] **Manual replay** via `POST /dlq/:id/replay` in `apps/api`. Resets event status
      to RECEIVED, re-enqueues with attempt=1, returns 202 + jobId. Worker marks
      `resolvedAt` on the resulting SUCCEEDED SyncRun.
- [x] Tests (6 scenarios in `apps/worker/src/__tests__/dispatch.test.ts`):
  - Same event id processed twice → exactly one destination call.
  - Destination throws retryable N times → N attempts → success on the Nth.
  - Destination throws retryable max times → DLQ with attempts=5.
  - Destination throws terminal (4xx) → immediate DLQ, zero retries.
  - DLQ replay re-runs the event; resolvedAt set on success.
  - Crash-then-redeliver still dedupes via prior SUCCEEDED SyncRun.
- [x] `DECISIONS.md` D30–D36 cover at-least-once + dedupe, the backoff schedule,
      Postgres-as-source-of-truth, and the test-isolation choice.

### Manual steps (you)

- [x] Run the **forced-failure walkthrough by hand** at least once. ✅ Driven via
      `docker compose stop mock-erp` → `pnpm dev:send-test-webhook -- --new` →
      5 retries with backoff → `DeadLetterItem` written → `docker compose start mock-erp`
      → `curl -X POST localhost:3010/dlq/<id>/replay` → DLQ resolved + event SUCCEEDED.
- [ ] **Record the headline GIF** of that walkthrough — single most important visual
      for the README. Tools: macOS built-in screen recording, Kap, or Cleanshot. _(Can
      be deferred until Phase 5 when the dashboard exists — re-recording then will
      show the DLQ list + replay button visually instead of curl.)_
- [ ] Save the recording into `docs/`.

### Definition of done

- All reliability tests green: 6 dispatcher scenarios + 6 retry-policy unit tests. ✅
  Total suite: 58 tests across 12 files, all passing.
- A forced-failure manual run (kill Mock ERP, send a webhook, see 5 retries +
  DLQ, restart Mock ERP, curl `/dlq/:id/replay`) succeeds end-to-end. ✅
  Verified against the running stack with event `32c887e2-…` going through
  RETRYING (×5) → DEAD_LETTERED → SUCCEEDED + DLQ resolved.

### Demo

- Default policy demo schedule (delays before retry 2..5): 1s, 2s, 4s, 8s — total
  ~15s to exhaust retries.
- Final state for the verified run: 5 SyncRun(RETRYABLE_FAILURE) + 1 SyncRun(SUCCEEDED),
  DeadLetterItem.resolvedAt set, IngestedEvent.status = SUCCEEDED, MockErpOrder
  written with idempotencyKey `event-<eventId>`.

---

## Phase 5 — Dashboard (Next.js) ✅ CODE COMPLETE, awaiting visual review

**Goal:** Operator-facing UI for monitoring and acting on the engine. Should make the
reliability features from Phase 4 _visible_, because reviewers will judge them by what
they see.

### Deliverables

- [x] `apps/dashboard` — Next.js 15 App Router + Tailwind + shadcn/ui (Button, Badge,
      Table, Card, Input, Skeleton in `src/components/ui/`).
- [x] REST endpoints in `apps/api`:
  - `GET /events` (paginated, optional `q`, `status` filter).
  - `GET /events/:id` (event + all SyncRuns + DeadLetterItem).
  - `GET /dlq` (paginated, `resolved=true|false|all`).
  - `POST /dlq/:id/replay` (already from Phase 4).
- [x] Pages (all server-component data fetch; no client-side API calls from the browser):
  - **/events** — sync feed table; search by external id; status badges per row;
    chevron link to detail; empty/error states.
  - **/events/[id]** — metadata grid, attempts table with duration + error, DLQ
    info if any, raw payload viewer.
  - **/dlq** — unresolved vs resolved sections, Replay button (Server Action +
    `router.refresh()`) on unresolved rows.
- [x] Empty / loading / error states for every page.
- [x] Vitest + React Testing Library (jsdom env) smoke tests:
      `EventStatusBadge` / `SyncRunOutcomeBadge` rendering + `ReplayButton` click
      fires the action + surfaces errors. 4 dashboard tests across 2 files.

### Manual steps (you)

- [ ] **Visually review** each page in the browser:
  - <http://localhost:3003/events>
  - <http://localhost:3003/events/[any-id]>
  - <http://localhost:3003/dlq> — has one unresolved item ready for **Replay**.
    Look for: spacing, status badge contrast, empty-state copy, mobile-width layout.
- [ ] **Click Replay** on the DLQ row — watch the page refresh and the row move to
      the "Resolved" section after the worker finishes.
- [ ] Give feedback on copy / spacing / hierarchy before screenshots are taken — UI
      judgment calls should be yours, not Claude's.
- [ ] **Capture screenshots** of the three core pages for the README.
- [ ] _(Optional)_ Record the headline GIF against the dashboard now that the DLQ +
      replay flow has a real UI.

### Definition of done

- All three pages render real data from a populated local DB. ✅
- The replay button on the DLQ page actually re-runs an event end-to-end. ✅
  (`POST /dlq/:id/replay` returns 202, worker picks up, marks resolved on success.)
- 62 tests across 14 files passing.

### Demo

- Open <http://localhost:3003/dlq> — one unresolved item from a forced mock-erp
  failure. Click **Replay** — row moves to resolved section after the worker
  succeeds. Click the external id on either side → /events/[id] shows the full
  attempt history with the 5 retries + the SUCCEEDED replay.

---

## Phase 6 — AI Mapping Studio (the differentiator) ✅ COMPLETE

**Goal:** Replace the hard-coded mapping from Phase 3 with a Claude-proposed,
human-approved `MappingConfig` row that the worker consumes. This is the AI talking
point on the resume — build it on top of a working engine, not before one.

### Deliverables

- [x] `packages/ai` — Anthropic SDK wrapper (`MappingProposer`). Key read from
      `ANTHROPIC_API_KEY` env var server-side only; `cache_control: ephemeral` on
      the system prompt; default model `claude-opus-4-7` (overridable via `ANTHROPIC_MODEL`).
- [x] `packages/core/src/mapping-spec.ts` — JSON `MappingSpec` format
      (`from`/`template`/`constant`/`fallbackFrom` + `arrays`), zod schema with
      refinements, pure `applyMapping` function. 16 unit tests.
- [x] Worker change in `resolveMockErpInput`: look up active `MappingConfig`,
      apply via `applyMapping`; fall back to `mapShopifyOrderToMockErp` if no
      config or if stored spec fails validation (safety net against a bad AI write).
- [x] Mapping Studio UI in `apps/dashboard`:
  1. Paste source + destination samples (pre-filled with Shopify + MockErp defaults).
  2. **Propose with Claude** → loading state → editable per-field card view +
     editable JSON spec, rationale + confidence badges per field.
  3. **Save & activate** → transactional create + deactivate-prior in one tx.
  4. `/mappings` lists every version with per-row Activate buttons.
- [x] Snapshot tests for the prompt + parser (6 fixtures, mocked SDK client) +
      round-trip test: proposal → applyMapping on real Shopify order produces
      the expected MockErp shape.
- [ ] _(Deferred — optional within this phase)_ DLQ triage with Claude. Skipped
      for now; can layer onto the existing `/dlq/:id` page later.

### Manual steps (you)

- [x] Anthropic account + credit at **console.anthropic.com**.
- [x] **API key** generated and pasted into `.env` as `ANTHROPIC_API_KEY`. Verified
      server-side only — the dashboard reaches Claude through the API, never directly.
- [x] Default model id: `claude-opus-4-7` (overridable via `ANTHROPIC_MODEL`).
- [x] Acted as the human-in-the-loop: triggered a propose, reviewed Claude's
      output, saved + activated, watched the next webhook be processed with
      `mappingConfigId: 2cae1f07-…` in the worker logs.
- [ ] _(Recommended)_ Set a monthly Anthropic spend cap in the console.
- [ ] _(Optional)_ Screen-record the propose → edit → approve → next-webhook-uses-it
      flow for the README.

### Definition of done

- A user can complete propose → review → edit → approve → see the next inbound
  event use the new mapping. ✅
  - Verified end-to-end: real Anthropic API call returned a 5-field + 1-array
    mapping; saved as v1; next `dev:send-test-webhook` ran with the new mapping
    (`worker-1 INFO applying AI-approved mapping mappingConfigId=2cae1f07-…`).
- No Anthropic key in the dashboard bundle. ✅ — all Anthropic calls go through
  `apps/api`; dashboard uses a Server Action that hits `POST /mappings/proposals`.
- All tests green (90 across 17 files including the 6 new mapping-proposer tests + 16 MappingSpec tests).

### Demo

- Open <http://localhost:3003/mappings/new>. Paste samples (or use the defaults).
  Click **Propose with Claude** → ~5-10s later see the proposal with per-field
  cards. Edit the JSON if you want. Click **Save & activate**. Then fire a
  webhook (`pnpm dev:send-test-webhook --new` or place a real Shopify order) —
  the worker logs `applying AI-approved mapping` and the SyncRun succeeds.

---

## Phase 7 — Second destination: Stripe (test mode) ✅ COMPLETE

**Goal:** Prove the connector abstraction by adding a second destination _without
touching the engine core_. Short phase, high signal.

### Deliverables

- [x] `packages/connectors/src/stripe` — `StripeDestinationConnector` against
      Stripe test mode (PaymentIntent creation, form-encoded body,
      `Idempotency-Key` header). Maps 429 → retryable, 5xx → retryable,
      4xx → terminal, fetch-throw → network. Passes the destination
      conformance suite. 9 tests including request-shape assertions.
- [x] Multi-destination fan-out inside `processEvent`: the worker holds a
      `DestinationSpec[]` registry; each event is delivered to every
      destination with per-destination dedupe. One SyncRun per
      (event × destination × attempt). Aggregate outcome drives retry/DLQ
      (whole event DLQs if any destination terminally fails; replay re-runs
      all, dedupe skips ones that already succeeded).
- [x] **No changes to `packages/core` or `packages/queue`.** ✅ `git status`
      after the phase shows no diff in either — Phase 1's `DestinationConnector`
      interface absorbed Stripe cleanly.

### Manual steps (you)

- [x] **Stripe account** at dashboard.stripe.com, Test mode toggled on.
- [x] **Test secret key** (`sk_test_…`) in `.env` as `STRIPE_TEST_KEY`. Worker
      conditionally adds Stripe to the destinations array only when this is set.
- [ ] _(Optional)_ Open the Stripe test-mode dashboard → Payments to verify the
      PaymentIntents created by the demo runs (search by metadata `source_order_id`).
      Good screenshot fodder for the README.

### Definition of done

- Stripe adapter passes the destination conformance suite. ✅ (9 tests)
- One Shopify webhook fans out to both Mock ERP and Stripe test mode. ✅
  - Verified: event `7efb54c6-…` produced two SyncRun rows (`mock-erp
SUCCEEDED, stripe SUCCEEDED`); `IngestedEvent.status = SUCCEEDED`; MockErpOrder
    row written with the engine's idempotency key; a Stripe PaymentIntent created
    in test mode with `metadata[source_order_id]=…`.

### Demo

- `pnpm dev:send-test-webhook --new` → both mock-erp and stripe SyncRuns appear
  in `/events/[id]` on the dashboard. Stripe dashboard (test mode) shows the
  matching PaymentIntent.

---

## Phase 8 — AWS deploy (one-shot demo, then tear down) 🚧 IN PROGRESS — code-only artifacts shipped, deploy paused

**Goal:** Run the same images on AWS to make the "production path" claim real, then
tear down to control cost. Per `PROJECT_DIRECTION.md` §5: AWS is for the demo, local
docker-compose is the daily driver.

> **Resume point (next session):** All pre-flight setup and decisions are done. The
> code-only deliverables (SQS adapter, queue-driver switch, `Dockerfile.prod`,
> `infra/README.md`) are merged. Pick back up at **§Manual steps → During the deploy**
> below — the next CLI command is `aws ecr create-repository`. The user has saved an
> RDS master password; Claude reads remaining secrets from local `.env` at deploy time.

### Deliverables

- [x] `packages/queue/src/sqs.ts` — `SqsQueue<T>` adapter. ~280 LOC; same explicit-
      ack bridge as BullMQ; passes the Phase 1 conformance suite when AWS is
      reachable (skips on dev machines without credentials).
- [x] `packages/queue/src/factory.ts` — `makeQueue(env)` picks `BullMQQueue` or
      `SqsQueue` based on `env.QUEUE_DRIVER`. `apps/api` and `apps/worker` both
      use it; queue swap is one env var, not a code change.
- [x] `Dockerfile.prod` — production image with `NODE_ENV=production`, non-watch
      tsx, SIGTERM-clean for Fargate. Parameterized by `APP_NAME` build arg.
- [x] `infra/README.md` — full ~400-line AWS deploy runbook: architecture
      diagram, ECR/SQS/RDS/CloudWatch/IAM/ECS/ALB step-by-step CLI, JSON
      templates for IAM trust + SQS policy + ECS task definitions, smoke-test
      commands, screenshot checklist, full teardown with 24h cost verification.
- [ ] Build + push images to ECR. (Code ready; gated on `aws` access during
      the next session.)
- [ ] Provision RDS Postgres + SQS main/DLQ + CloudWatch log groups + IAM roles
      + ECS cluster + task definitions + services + ALB. (Runbook ready.)
- [ ] Update Shopify webhook URL to the ALB DNS; fire a live order; capture
      logs flowing through CloudWatch end-to-end.
- [ ] Screenshots of CloudWatch logs, ECS console, RDS rows, SQS metrics,
      Stripe test-mode PaymentIntent for the README.
- [ ] **Teardown** via the runbook checklist; verify Cost Explorer 24h later.

### Manual steps (you)

This phase has the most user-only steps in the whole project. **Plan ~half a day** and
do it in one sitting so resources don't sit idle billing. Per `PROJECT_DIRECTION.md`
§5 this is _intentionally_ a one-shot demo + screenshots, then teardown — the MVP
runs locally via `docker compose`. Phase 8 produces three durable artifacts: the
`packages/queue/sqs` adapter (code), `infra/README.md` (runbook), and the README
screenshots.

#### Pre-flight setup (do before Claude starts any `aws` work)

Everything below gates Claude from running CLI commands against AWS. Roughly
30–60 minutes of clicking around the console + terminal setup, one-time.

- [x] **AWS account.** Done.
- [x] **MFA on the root user.** Done.
- [x] **Dedicated IAM user with programmatic access.** Done. (Access key CSV
      saved locally; `AdministratorAccess` for the demo, will be deleted at
      teardown.)
- [x] **AWS CLI v2 installed locally.** Done.
- [x] **`aws configure`** in your terminal. Done.
- [x] **Verify**: `aws sts get-caller-identity` — confirmed working.
- [x] **$5 monthly AWS Budget alert with email.** Done.

#### Decisions to make upfront

- [x] **Region**: `us-east-1`.
- [x] **Where the secrets live**: **plain task-definition env vars** (option 1).
      `infra/task-def-*.json` is gitignored so the filled-in files with live
      secrets never enter the repo. Templates stay documented in
      `infra/README.md` appendix.
- [x] **What stays local vs goes to AWS**: only `apps/api` and `apps/worker`
      deploy. `apps/mock-erp` stays local (the worker's mock-erp destination
      will be dropped from the destinations array for the cloud build), and
      `apps/dashboard` stays local pointing at the AWS API URL.
- [x] **RDS master password**: user has saved one locally. Claude will read
      from `.env` (or be told it) at the RDS provisioning step.

#### During the deploy (Claude drives, you approve)

- [ ] Approve any one-time resource creations Claude proposes (ECR repo, RDS
      instance, ECS cluster, ALB, SQS queue). Manual web-console clicks may be
      faster than CLI for one-shot setup — that's fine, document them in
      `infra/README.md` as you go.

#### Demo + screenshots

- [ ] **Take screenshots** for the README: - ECS service running (1+ task in RUNNING state) - CloudWatch logs of a real webhook flowing through - RDS row inserted (Postgres Query Editor in the RDS console, or psql via
      a bastion) - SQS queue metrics (ApproximateNumberOfMessagesReceived spiking when the
      webhook fires) - Stripe test-mode dashboard showing the PaymentIntent the Fargate worker created

#### Teardown (when the demo is captured)

- [ ] Stop ECS services (`aws ecs update-service --desired-count 0`)
- [ ] Delete ALB + target groups (Console → EC2 → Load Balancers)
- [ ] Delete RDS instance (snapshot first if you want; "Delete final snapshot"
      to skip if you don't)
- [ ] Delete SQS main + DLQ queues
- [ ] Delete CloudWatch log groups (saves nothing significant, but tidy)
- [ ] Delete ECR images (Console → ECR → Repositories → select → Delete)
- [ ] Delete the IAM user + access keys
- [ ] **Verify Cost Explorer shows no ongoing charges 24h later**.
- [ ] (Optional) Close the AWS account if you created a fresh one just for this.

### Definition of done

- One Shopify webhook delivered to the AWS-hosted endpoint flows end-to-end and lands
  in RDS — screenshotted.
- Resources torn down; final AWS bill estimated.

---

## Phase 9 — Stretch (clearly optional)

Pick from these only after Phases 0–8 are stable and presentable. Each one is a
seniority signal but **not** required for the portfolio centerpiece.

- **Observability:** `/metrics` Prometheus endpoint, optional OpenTelemetry tracing,
  request-id propagation end-to-end.
- **Rate limiting / backpressure:** token-bucket on outbound destination calls;
  worker concurrency caps per destination.
- **Multi-tenancy:** tenant id on every row, scoped queries, per-tenant secrets.
- **Second source connector:** WooCommerce (free, local install) to prove the source
  abstraction generalizes.
- **CI/CD + IaC:** GitHub Actions running lint/typecheck/test/build on every PR;
  Terraform for the AWS resources from Phase 8.
- **Polling source:** the cron-based pull-and-diff path shown in the architecture
  diagram, for systems without webhooks.

### Manual steps (you — vary by pick)

- **Observability:** spin up Prometheus + Grafana locally (or use Grafana Cloud's free
  tier) and confirm `/metrics` is being scraped.
- **Multi-tenancy:** decide the tenant identity model (subdomain? header? auth claim?)
  before any code is written — that choice ripples through every table.
- **Second source (WooCommerce):** install WordPress + WooCommerce locally
  (e.g. via `wp-env`) and configure a webhook the same way Phase 3 did for Shopify.
- **CI/CD + IaC:** push the repo to GitHub if not already, enable GitHub Actions, and
  (for Terraform) confirm AWS credentials are wired into the Actions runner via OIDC
  rather than long-lived secrets.

---

## Cross-cutting concerns (every phase)

These don't appear as their own phase but must be honored throughout:

- **Tests for reliability paths are non-negotiable** (`CLAUDE.md` §Testing).
- **Conventional commits**, one PR per phase or coherent slice.
- **Update `DECISIONS.md`** in the same PR as the decision — not after.
- **Update `README.md`**, `.env.example`, and `CLAUDE.md` whenever behavior or
  commands change.
- **No paid dependencies** — every phase must remain runnable with `docker-compose up`
  and free dev accounts (`CLAUDE.md` §Golden rules #1).
- **Ask before** adding a major dependency, changing the stack in `CLAUDE.md` §Tech,
  or running a destructive migration (`CLAUDE.md` §Golden rules #8).

---

## Sequencing rationale (why this order)

A few choices worth defending in an interview:

1. **Interfaces before implementations (Phase 1 before Phase 2).** Designing the
   `Queue` and connector contracts against an in-memory fake first means the BullMQ,
   SQS, Shopify, and Stripe adapters all face the same conformance suite. The day you
   swap BullMQ for SQS is uneventful — that's the whole point of the abstraction.

2. **Schema in Phase 1, not later.** Changing a Prisma schema after the worker, API,
   and dashboard all read from it is painful. Locking the core tables (`IngestedEvent`,
   `SyncRun`, `DeadLetterItem`, `MappingConfig`) early forces the domain model to be
   right before code piles on top.

3. **Happy path (Phase 3) before reliability (Phase 4).** A working pipe is the
   substrate reliability features attach to. Building dedupe/retry/DLQ against a
   half-wired pipeline produces tests that pass for the wrong reasons.

4. **Reliability (Phase 4) before the dashboard (Phase 5).** The dashboard's main job
   is to _expose_ the reliability story (DLQ list, replay button, attempt history).
   Building the UI first means rebuilding it once the data model is real.

5. **AI Mapping Studio (Phase 6) last among the core phases.** It is the differentiator
   on paper, but only credible on top of an engine that already works. Built earlier,
   it would be a demo with no substance underneath.

6. **AWS deploy (Phase 8) after the engine is feature-complete.** Fargate + ALB bill by
   the hour; spinning them up before the product is ready burns money for no signal.
   Doing it last means one tight, screenshotted demo and a clean teardown.
