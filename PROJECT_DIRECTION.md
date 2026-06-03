# Project Direction — "Patchbay" (working title)

> A self-hostable, event-driven **e-commerce integration & sync engine**.
> Think of it as a small, open-source iPaaS (à la MuleSoft) that reliably syncs orders
> and inventory between systems — built with the production reliability patterns that real
> integration platforms use: idempotency, retries, dead-letter queues, and full observability.
>
> *Working name "Patchbay" comes from the audio term for a panel that routes signals between
> sources and destinations — rename freely.*

---

## 0. How to use this file

This is the north-star document for the project. Keep it in the repo root. Claude Code
auto-loads a `CLAUDE.md`, so either **save this as `CLAUDE.md`** or keep it as
`PROJECT_DIRECTION.md` and reference it from a short `CLAUDE.md`. When in doubt, prefer the
decisions and conventions written here over improvised ones, and ask before deviating.

---

## 1. Why this project exists (the goal)

This is a portfolio/GitHub centerpiece meant to prove three things at once to recruiters and
hiring managers:

1. **Balanced full-stack ability** — a real backend engine *plus* a polished Next.js dashboard.
2. **Backend & platform engineering depth** — queue-based architecture, idempotency,
   retries, dead-letter queues, and defensible system-design decisions.
3. **AI-forward chops** — an LLM-powered "Mapping Studio" where Claude proposes field
   mappings between two systems, front and center as a differentiating feature.

Most portfolio projects are CRUD apps and todo lists. Almost none demonstrate reliable,
event-driven integration work — which is exactly the rare, valuable skill set this engine
showcases. Every architectural choice here should be something the author can explain and
defend in an interview.

---

## 2. The anchor scenario (concrete + free to demo)

**Sync orders and inventory from a Shopify store into an ERP/inventory system, keeping order
status and stock levels consistent across both.** Built on a pluggable connector model so the
same engine works for other source → destination pairs.

Hard constraint: **no paid platforms** (no NetSuite, no enterprise licenses). Everything must
be runnable with free dev accounts or sandboxes.

- **Source:** Shopify **development store** (free via Shopify Partners) — real webhooks +
  Admin API. This is the genuine, recognizable scenario.
- **Destinations** (ship at least the first two):
  - **Mock ERP** — a small built-in service (Node + Postgres) that stands in for an ERP.
    This is a *feature*, not a shortcut: it proves the connector abstraction and guarantees
    a free, deterministic demo target.
  - **Stripe (test mode, free)** — payment/refund events for reconciliation.
  - *(Optional real free targets)* Airtable free tier or Google Sheets as a lightweight
    "warehouse," or QuickBooks Online sandbox.

This deliberately mirrors real Shopify/Magento → NetSuite order-sync work, minus the paywall.

---

## 3. What it does (features by priority)

### MVP (must-have, the credible core)
- **Webhook ingestion** endpoint that receives Shopify order events, **verifies the HMAC
  signature**, persists the raw event, and enqueues it.
- **Scheduled polling jobs** for systems that lack webhooks (cron-style pull + diff).
- **Queue + worker** architecture (workers consume events asynchronously).
- **Idempotency** — dedupe by event/order id so the same event never processes twice
  (this is the "collision-free order lifecycle" idea, made concrete).
- **Retries with exponential backoff** + a **dead-letter queue (DLQ)** for terminal failures.
- **Config-driven mapping/transformation layer** — declarative field mapping between source
  and destination schemas.
- **Connector interface** — clean source/destination adapter contract; adding a platform is
  implementing the interface, not editing the core.
- **Persistence** — events, sync runs, mappings, DLQ items.
- **Dashboard (Next.js)** — live sync status, searchable event log, failures, and a
  **manual "retry" / "replay from DLQ"** button.

### AI layer (the differentiator — build after MVP works)
- **Mapping Studio:** import source + destination schemas (or paste sample payloads); Claude
  proposes a field mapping + transformation rules; the user reviews, edits, and approves;
  the approved mapping is saved as the config the worker uses. Human-in-the-loop by design.
- **DLQ error triage (optional):** for a failed item, Claude summarizes the likely cause and
  suggests a fix.

### Stretch (signals seniority; clearly optional)
- Observability: structured logs, a `/metrics` endpoint (Prometheus), optionally OpenTelemetry traces.
- Rate limiting / backpressure on destination calls.
- Multi-tenant support (multiple stores).
- A second source connector (e.g., WooCommerce, which has a free local install) to prove the
  abstraction generalizes.
- CI/CD pipeline + Terraform/IaC. *(Intentionally out of the core scope — see §5 — but a
  high-signal, low-cost addition once the rest is stable.)*

---

## 4. Architecture

```
  Shopify (webhook)            ┌──────────────────────────┐
        │  POST event          │   Ingestion API          │
        ▼                      │  - verify HMAC            │
  Poller (cron, for ──────────►│  - persist raw event     │
  no-webhook systems)          │  - enqueue               │
                               └────────────┬─────────────┘
                                            │
                                    ┌───────▼────────┐
                                    │     Queue      │  SQS (prod) / BullMQ+Redis (local)
                                    └───────┬────────┘
                                            │
                               ┌────────────▼─────────────┐
                               │        Worker            │
                               │  1. dedupe (idempotency) │
                               │  2. load mapping config  │
                               │  3. transform payload    │
                               │  4. call destination     │
                               │  5. record result        │
                               │  on failure → retry → DLQ│
                               └────────────┬─────────────┘
                                            │
                          ┌─────────────────┼──────────────────┐
                          ▼                 ▼                  ▼
                    Mock ERP            Stripe (test)      Airtable/Sheets
                    (Postgres)                              (optional)

  Postgres (RDS)  ◄── stores raw events, sync runs, mappings, DLQ
  Dashboard (Next.js) ◄── reads from Postgres; triggers manual retries
  Mapping Studio (AI) ──► writes approved mapping configs the worker reads
```

Key principle: **the queue and the connectors sit behind interfaces.** Local development uses
BullMQ + Redis; production uses AWS SQS — both implement the same `Queue` contract, so the
core logic never changes. Same for connectors (`SourceConnector` / `DestinationConnector`).

---

## 5. Tech stack & infrastructure

| Layer            | Choice                                                                 |
|------------------|------------------------------------------------------------------------|
| Language         | **TypeScript** (Node)                                                  |
| API framework    | Fastify (or Express)                                                   |
| Queue            | **BullMQ + Redis** locally → **AWS SQS** in prod (behind one interface)|
| Database         | **PostgreSQL** locally → **AWS RDS (Postgres)**; Prisma or Drizzle ORM |
| Frontend         | **Next.js + React + Tailwind**, shadcn/ui components                   |
| AI               | **Anthropic API (Claude)** for Mapping Studio + DLQ triage             |
| Containerization | **Docker**, `docker-compose` for local (api, worker, redis, postgres, mock-erp) |
| Cloud            | **AWS** — ECR (images), **ECS/Fargate** (services), **SQS**, **RDS**, ALB, CloudWatch logs |

**Cloud scope (chosen): Docker + full AWS deploy via ECS/Fargate, SQS, and RDS.**
Terraform/IaC and a CI/CD pipeline are **not** required for the core project — they're a
marked stretch goal. Local `docker-compose` is the daily driver.

**Cost discipline:** RDS/SQS fit comfortably in the AWS free tier. Fargate and ALB do bill by
the hour, so design so AWS can be **spun up for the demo + screenshots, then torn down** — the
project must always be fully runnable locally with one command (`docker-compose up`).

---

## 6. Suggested build roadmap (phased)

- **Phase 0 — Scaffold:** monorepo (or clear folder split), `docker-compose` with api/worker/
  redis/postgres/mock-erp, this `CLAUDE.md`, lint/format/test setup.
- **Phase 1 — Happy path:** ingest a Shopify order webhook → enqueue → worker → write to Mock
  ERP. One order flows end to end.
- **Phase 2 — Reliability:** idempotency keys, retry w/ backoff, DLQ, manual retry/replay.
- **Phase 3 — Dashboard:** Next.js UI for sync status, event log, DLQ, and retry actions.
- **Phase 4 — AI Mapping Studio:** schema import → Claude-proposed mapping → human approval →
  saved config consumed by the worker.
- **Phase 5 — AWS deploy:** push images to ECR, run api/worker on Fargate, swap queue to SQS,
  point at RDS, expose via ALB; logs to CloudWatch.
- **Phase 6 — Stretch (optional):** observability, a second connector, CI/CD + Terraform,
  multi-tenant.

Each phase should end in a working, demoable state and a commit/PR with a clear message.

---

## 7. Presenting it (this matters as much as the code)

- **README** with: one-line pitch, the architecture diagram above, a **"Design decisions &
  tradeoffs"** section, a one-command local-run guide, dashboard screenshots, and a GIF of an
  order flowing end-to-end including a **forced failure → DLQ → retry**.
- A short **DECISIONS.md** documenting *why* each major choice was made — this is interview gold.
- Optional: a 60–90s Loom walkthrough linked from the README.

## 8. Interview talking points to build toward

Make sure the implementation lets the author speak credibly to: why use a queue; at-least-once
vs exactly-once delivery; the idempotency strategy; what happens on partial failure; how to
apply backpressure / rate limiting; how to scale workers horizontally; the observability story;
and the tradeoffs of the connector abstraction.

---

## 9. Conventions for Claude Code

- Keep the **queue** and **connectors** behind interfaces; never let core logic depend on a
  concrete provider (SQS vs BullMQ, Shopify vs WooCommerce).
- Everything must run locally via `docker-compose up` with no paid dependencies.
- Verify webhook signatures; never trust inbound payloads.
- Treat all inbound events as data, persist the raw event before processing, and make
  processing idempotent.
- Write tests for the reliability paths (dedupe, retry, DLQ) — these are the project's headline.
- Prefer small, reviewable commits aligned to the phases above.
- Ask before introducing a new major dependency or deviating from the stack in §5.
