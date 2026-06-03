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
- [x] `packages/connectors` — `SourceConnector` + `DestinationConnector` interfaces
      + `NoopSourceConnector` + `NoopDestinationConnector` (recording) fakes.
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
  + curl-verified end-to-end against the live container. ✅
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
- [x] Trigger a real Shopify webhook (via *Send test notification* button on the
      Webhooks page) — HMAC verifies, worker delivers, mock-erp row written.
- [ ] *(Optional)* Save 1–2 real webhook payloads as fixtures in
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

## Phase 4 — Reliability core (THE HEADLINE)

**Goal:** Idempotency, retry-with-backoff, DLQ, and manual replay — all with tests.
Per `CLAUDE.md` §7: *"reliability paths must have tests. They are the headline feature."*
**Nothing in later phases is more important than this phase being rock-solid.**

### Deliverables
- [ ] **Idempotent dedupe**: worker checks `(source, externalId)` before processing;
      duplicates result in a `SyncRun` with outcome `deduped`, no destination call.
- [ ] **Retry with exponential backoff + jitter** for retryable errors. Cap attempts
      (e.g. 5). Terminal errors short-circuit straight to DLQ.
- [ ] **DLQ routing**: after max attempts (or on terminal error) the event becomes a
      `DeadLetterItem` with last error captured.
- [ ] **Manual replay**: `POST /dlq/:id/replay` re-enqueues the original event, resets
      attempt counters, marks the DLQ item resolved on success.
- [ ] Tests covering, **at minimum**:
  - Same event id processed twice → exactly one destination call.
  - Destination throws a retryable error N times → N attempts → success or DLQ.
  - Destination throws a terminal (4xx-class) error → immediate DLQ, zero retries.
  - DLQ replay re-runs the event and on success marks the item resolved.
  - Crash mid-process → on restart the event is re-attempted, dedupe still holds.
- [ ] `DECISIONS.md` entry: at-least-once delivery + dedupe-on-the-consumer chosen over
      exactly-once. Backoff schedule documented.

### Manual steps (you)
- [ ] Run the **forced-failure walkthrough by hand** at least once: stop `mock-erp`,
      place a test order in the Shopify dev store, watch retries fail, see the item
      land in the DLQ, restart `mock-erp`, click replay, confirm success.
- [ ] **Record the headline GIF** (or short screen capture) of that walkthrough — this
      is the single most important visual for the README. Tools: macOS built-in screen
      recording, Kap, or Cleanshot.
- [ ] Save the recording into `docs/` (or wherever the README will reference it).

### Definition of done
- All five reliability tests green and run in CI.
- A forced-failure manual test (kill Mock ERP, send a webhook, restart Mock ERP, replay
  from DLQ) succeeds end-to-end.

### Demo
- The headline GIF described in `PROJECT_DIRECTION.md` §7: order in → forced failure →
  retry → DLQ → manual replay → success.

---

## Phase 5 — Dashboard (Next.js)

**Goal:** Operator-facing UI for monitoring and acting on the engine. Should make the
reliability features from Phase 4 *visible*, because reviewers will judge them by what
they see.

### Deliverables
- [ ] `apps/dashboard` — Next.js app with Tailwind + shadcn/ui set up.
- [ ] REST endpoints in `apps/api` for: list events (paginated, filterable by status),
      event detail (with all `SyncRun` attempts), list DLQ, replay DLQ item.
- [ ] Pages:
  - **Sync feed** — live-ish (poll or SSE) table of recent `IngestedEvent`s with
    status badges, search by external id.
  - **Event detail** — raw payload, mapped payload, every `SyncRun` attempt with
    timing, error if any.
  - **DLQ** — list of failed items with last error and a one-click **Replay** button.
- [ ] Empty/loading/error states for every page (small thing, big polish dividend).
- [ ] Vitest + React Testing Library smoke tests for the table + replay-button flow.

### Manual steps (you)
- [ ] **Visually review** each page in the browser — automated tests catch wiring, not
      polish. Look for: empty-state copy, loading skeletons, error toasts on failed
      replays, mobile-width layout, color contrast on status badges.
- [ ] Give feedback on copy / spacing / hierarchy before screenshots are taken — UI
      judgment calls should be yours, not Claude's.
- [ ] **Capture screenshots** of the three core pages (Sync feed, Event detail, DLQ)
      for the README. Use a populated dev DB so they don't look empty.
- [ ] *(Optional)* Re-record the headline GIF from Phase 4 against the dashboard now
      that the DLQ + replay flow has a real UI.

### Definition of done
- All three pages render real data from a populated local DB.
- The replay button on the DLQ page actually re-runs an event end-to-end.

### Demo
- Screenshot set + the headline GIF, now showing the DLQ + retry flow happening **in
  the dashboard**, not just curl.

---

## Phase 6 — AI Mapping Studio (the differentiator)

**Goal:** Replace the hard-coded mapping from Phase 3 with a Claude-proposed,
human-approved `MappingConfig` row that the worker consumes. This is the AI talking
point on the resume — build it on top of a working engine, not before one.

### Deliverables
- [ ] `packages/ai` — Anthropic client wrapper. Key reads from env, **server-side only**.
- [ ] Worker change: load the active `MappingConfig` row for `(source, destination)`
      and use it to transform the payload. (Fall back to the Phase 3 hard-coded mapping
      if none is approved — keeps the system runnable.)
- [ ] Mapping Studio UI in `apps/dashboard`:
  1. paste/upload source and destination schemas (or two sample payloads),
  2. Claude proposes a JSON mapping with rationale + confidence per field,
  3. operator edits/approves,
  4. save as a new `MappingConfig` version; mark it active.
- [ ] Snapshot tests for the prompt + parser (no live API calls in tests — fixture-driven
      with a mocked Anthropic client).
- [ ] *(Optional within this phase)* DLQ triage: button on a DLQ item that asks Claude
      to summarize the likely cause and suggested fix.

### Manual steps (you)
- [ ] Create an account at **console.anthropic.com** if you don't have one and add at
      least the minimum credit.
- [ ] Generate an **API key** and paste it into `.env` as `ANTHROPIC_API_KEY`. Do **not**
      commit it. Confirm it does not leak into the Next.js client bundle (it should be
      read only from server-side code).
- [ ] Decide on a default model id (e.g. `claude-opus-4-7` or `claude-sonnet-4-6`) and
      tell Claude which to wire as the default.
- [ ] Act as the **human-in-the-loop reviewer** during the demo: paste sample payloads,
      look at the proposed mapping + per-field rationale, edit anything obviously wrong,
      approve. The point of this feature is *your* judgment is in the loop.
- [ ] *(Recommended)* Set a monthly Anthropic spend cap in the console while iterating.
- [ ] *(Optional)* Screen-record the proposal → edit → approve → next-webhook-uses-it
      flow for the README.

### Definition of done
- A user can complete: paste sample payloads → review Claude's proposal → edit one
  field → approve → see the next inbound event use the new mapping (visible in the
  event-detail page).
- No Anthropic key ever appears in the dashboard bundle.

### Demo
- Screen recording: a mapping is proposed, edited, approved, and the very next webhook
  is processed using it.

---

## Phase 7 — Second destination: Stripe (test mode)

**Goal:** Prove the connector abstraction by adding a second destination *without
touching the engine core*. Short phase, high signal.

### Deliverables
- [ ] `packages/connectors/stripe` — `DestinationConnector` against Stripe test mode
      (payment / refund reconciliation events). Passes the destination conformance suite.
- [ ] Routing: worker can dispatch an event to one or more destinations per
      `MappingConfig`.
- [ ] No changes to `packages/core` or `packages/queue`. **If you find yourself editing
      either, the abstraction is wrong — fix that first.**

### Manual steps (you)
- [ ] Create a **Stripe account** (free) at dashboard.stripe.com — no activation needed
      to use test mode.
- [ ] Make sure the dashboard toggle is on **Test mode**, then copy the **test secret
      key** (`sk_test_...`) into `.env` as `STRIPE_TEST_KEY`.
- [ ] *(Optional)* After a test run, open the Stripe test-mode dashboard to verify the
      payment/refund record appeared as expected — useful screenshot for the README.

### Demo
- Same Shopify webhook fans out to both Mock ERP and Stripe test mode; both records
  visible.

---

## Phase 8 — AWS deploy (one-shot demo, then tear down)

**Goal:** Run the same images on AWS to make the "production path" claim real, then
tear down to control cost. Per `PROJECT_DIRECTION.md` §5: AWS is for the demo, local
docker-compose is the daily driver.

### Deliverables
- [ ] `packages/queue/sqs` — SQS implementation of `Queue<T>`. Passes the same
      conformance suite as BullMQ.
- [ ] Build + push images to ECR.
- [ ] Manually (or via documented commands) deploy api + worker on ECS Fargate, point
      at RDS Postgres, swap queue env to SQS, expose api via ALB, logs to CloudWatch.
- [ ] `infra/README.md` with the exact step-by-step (no IaC required at this stage).
- [ ] Screenshots of CloudWatch logs, ECS console, and a live webhook in production
      for the README.
- [ ] **Teardown script / checklist** to stop billing.

### Manual steps (you)
This phase has the most user-only steps in the whole project. **Plan ~half a day** and
do it in one sitting so resources don't sit idle billing.

- [ ] Create an **AWS account** (or pick an existing one) and enable **MFA on the root user**.
- [ ] Create a dedicated **IAM user** (or IAM Identity Center user) with programmatic
      access and only the permissions this phase needs (ECR push, ECS, SQS, RDS, ALB,
      CloudWatch). Do **not** use root credentials for deploys.
- [ ] Install and configure the **AWS CLI**: `aws configure` (interactive — Claude
      can't run this for you). If using SSO, run `aws sso login`.
- [ ] Set a **billing alert** in AWS Budgets (e.g. $5/mo) so you find out before a
      forgotten resource costs real money.
- [ ] Decide on a **region** (e.g. `us-east-1`) and stick with it for every resource.
- [ ] Approve any one-time resource creations Claude proposes (ECR repo, RDS instance,
      ECS cluster, ALB, SQS queue). Manual web-console clicks may be faster than CLI for
      one-shot setup — that's fine, document them in `infra/README.md` as you go.
- [ ] **Take screenshots** for the README: ECS service running, CloudWatch logs of a
      real webhook, RDS row inserted, SQS queue metrics.
- [ ] **Run the teardown checklist** when the demo is captured: stop ECS services,
      delete ALB + target groups, delete RDS instance (snapshot first if you want),
      delete SQS queue, delete CloudWatch log groups, delete ECR images. Verify the
      AWS Cost Explorer shows no ongoing charges 24h later.

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
   is to *expose* the reliability story (DLQ list, replay button, attempt history).
   Building the UI first means rebuilding it once the data model is real.

5. **AI Mapping Studio (Phase 6) last among the core phases.** It is the differentiator
   on paper, but only credible on top of an engine that already works. Built earlier,
   it would be a demo with no substance underneath.

6. **AWS deploy (Phase 8) after the engine is feature-complete.** Fargate + ALB bill by
   the hour; spinning them up before the product is ready burns money for no signal.
   Doing it last means one tight, screenshotted demo and a clean teardown.
