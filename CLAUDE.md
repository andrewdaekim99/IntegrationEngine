# CLAUDE.md

Operational guide for working in this repo. For the **vision, scope, and roadmap**, read
[`PROJECT_DIRECTION.md`](./PROJECT_DIRECTION.md) — that is the source of truth for *what* and
*why*. This file covers *how to work here*.

---

## Project in one paragraph

**Patchbay** is a self-hostable, event-driven e-commerce integration & sync engine — a small
open-source iPaaS. It ingests Shopify order events (real webhooks from a free dev store),
processes them through a queue + worker with production reliability patterns (idempotency,
retries, dead-letter queue), and syncs them to destination connectors (a built-in Mock ERP,
Stripe test mode, optionally others). A Next.js dashboard monitors sync health, and an
LLM-powered "Mapping Studio" uses Claude to propose field mappings between systems. Goal: a
portfolio centerpiece proving full-stack ability, backend/platform depth, and AI integration.

---

## Golden rules (do not violate without asking)

1. **Everything runs locally with `docker-compose up` and zero paid dependencies.** No service
   may require a paid account to develop or demo.
2. **The queue lives behind a `Queue` interface.** Local = BullMQ + Redis, prod = AWS SQS. Core
   logic never imports a concrete queue.
3. **Connectors live behind `SourceConnector` / `DestinationConnector` interfaces.** Adding a
   platform = implementing an interface, never editing the engine core.
4. **Persist the raw inbound event before doing anything else**, then process. Never lose data.
5. **Processing is idempotent.** The same event id must never produce duplicate side effects.
6. **Verify all inbound webhook signatures (HMAC).** Never trust an unverified payload.
7. **Reliability paths (dedupe, retry, DLQ) must have tests.** They are the headline feature.
8. **Ask before** adding a major dependency, changing the stack in §Tech, or running a
   destructive/irreversible DB migration.

---

## Tech stack (fixed unless we agree otherwise)

- **Language:** TypeScript (Node 20+), `strict` mode, no implicit `any`.
- **API:** Fastify. **Worker:** standalone Node process consuming the queue.
- **Queue:** BullMQ + Redis (local) → AWS SQS (prod), both behind one interface.
- **DB:** PostgreSQL via Prisma (local Docker → AWS RDS).
- **Dashboard:** Next.js + React + Tailwind + shadcn/ui.
- **AI:** Anthropic API (Claude) for the Mapping Studio and DLQ triage.
- **Validation:** zod for all external input (webhooks, API bodies, env).
- **Logging:** pino structured logs (no bare `console.log` in app code).
- **Tests:** Vitest.
- **Package manager:** pnpm workspaces (monorepo).
- **Containers:** Docker + `docker-compose` for local; ECR/ECS-Fargate for AWS.

---

## Repo structure (target)

```
patchbay/
├─ CLAUDE.md                 # this file
├─ PROJECT_DIRECTION.md      # vision / scope / roadmap
├─ DECISIONS.md              # running log of design decisions + tradeoffs
├─ docker-compose.yml        # api, worker, dashboard, redis, postgres, mock-erp
├─ .env.example              # documents every required env var
├─ package.json              # pnpm workspace root
├─ apps/
│  ├─ api/                   # Fastify ingestion API (webhooks + REST for dashboard)
│  ├─ worker/                # queue consumer: dedupe → map → transform → deliver
│  ├─ dashboard/             # Next.js monitoring UI + Mapping Studio
│  └─ mock-erp/              # stand-in destination service (proves the abstraction)
├─ packages/
│  ├─ core/                  # domain logic: events, sync runs, mapping engine, retry policy
│  ├─ queue/                 # Queue interface + BullMQ and SQS implementations
│  ├─ connectors/            # Source/Destination interfaces + adapters (shopify, stripe, mock-erp)
│  ├─ db/                    # Prisma schema + generated client + migrations
│  └─ ai/                    # Anthropic client + Mapping Studio prompts
└─ infra/                    # AWS deploy notes (+ optional IaC later)
```

Keep cross-cutting domain logic in `packages/core`; apps should be thin.

---

## Commands (establish these in Phase 0, then keep them working)

```bash
pnpm install              # install all workspaces
docker-compose up         # full local stack (api, worker, dashboard, redis, pg, mock-erp)
pnpm dev                  # run app dev servers against the docker services
pnpm test                 # run all tests (Vitest)
pnpm test --filter core   # test a single package/app
pnpm lint                 # eslint
pnpm format               # prettier
pnpm typecheck            # tsc --noEmit across the workspace
pnpm db:migrate           # apply Prisma migrations
pnpm db:generate          # regenerate Prisma client
```

If you add or change a command, update this section in the same PR.

---

## Environment & secrets

- All config comes from env vars, validated with zod at startup (fail fast on missing vars).
- **Never commit secrets.** `.env` is gitignored; `.env.example` lists every variable with a
  placeholder and a one-line comment.
- Expected vars: `DATABASE_URL`, `REDIS_URL`, `SHOPIFY_WEBHOOK_SECRET`, `ANTHROPIC_API_KEY`,
  `STRIPE_TEST_KEY`, plus AWS vars (`AWS_REGION`, `SQS_QUEUE_URL`, …) for the prod path.
- The Anthropic API key stays server-side only — never ship it to the dashboard/client.

---

## Coding conventions

- TypeScript `strict`; prefer explicit types at module boundaries. Avoid `any`; use `unknown`
  + a zod parse instead.
- Validate every external input (webhook payloads, API requests, env) with zod before use.
- Errors: throw typed errors; let the worker's retry/DLQ machinery decide outcomes. Distinguish
  **retryable** (network/5xx) from **terminal** (validation/4xx) failures.
- No `console.log` in app code — use the pino logger with structured fields (event id, run id).
- Keep functions small and pure where possible; side effects (DB, network) live at the edges.
- Name things by domain concept: `SyncRun`, `IngestedEvent`, `DeadLetterItem`, `MappingConfig`.

---

## Testing expectations

- The reliability core is non-negotiable to test: **idempotent dedupe**, **retry with backoff**,
  **DLQ routing**, and **manual replay**. Cover happy path *and* failure path.
- Connectors are tested against the interface with fakes; no live external calls in tests.
- Aim for meaningful coverage on `packages/core`, `packages/queue`, `packages/connectors`.

---

## Git & workflow

- Small, reviewable commits aligned to the phases in `PROJECT_DIRECTION.md` (§6).
- Conventional commit messages (`feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`).
- One PR per phase (or per coherent slice). Each PR should leave the project in a runnable,
  demoable state.
- Log notable design decisions in `DECISIONS.md` as you make them (what, why, alternatives).

## Definition of done (per slice)

- Runs via `docker-compose up` with no manual setup beyond `.env`.
- Tests for any reliability logic touched.
- `pnpm lint`, `pnpm typecheck`, and `pnpm test` all pass.
- README/`.env.example`/this file updated if behavior or commands changed.

---

## Out of scope for the core build

Terraform/IaC, CI/CD pipelines, and multi-tenancy are **stretch goals** (see
`PROJECT_DIRECTION.md` §3 and §6). Do not pull them into the core unless explicitly asked.
Local `docker-compose` is the daily driver; AWS is spun up for demos/screenshots then torn down
to control cost.
