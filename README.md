# integr8

Self-hostable, event-driven e-commerce integration & sync engine — a small open-source
iPaaS. Ingests Shopify order events, processes them through a queue with production
reliability patterns (idempotency, retries, dead-letter queue), and syncs them to
destination connectors. Includes a Next.js dashboard and an LLM-powered Mapping Studio.

> Vision and scope: [`PROJECT_DIRECTION.md`](./PROJECT_DIRECTION.md).
> Working agreement: [`CLAUDE.md`](./CLAUDE.md).
> Phased build plan: [`ROADMAP.md`](./ROADMAP.md).
> Architecture decisions log: [`DECISIONS.md`](./DECISIONS.md).

---

## Quick start

**Prerequisites**

- Node.js 20+
- pnpm 9+ (`corepack enable && corepack prepare pnpm@latest --activate`)
- Docker Desktop (or another OCI-compatible runtime with `docker compose`)

**First run**

```bash
pnpm install
cp .env.example .env
docker compose up
```

That boots Postgres, Redis, and stub services for `api`, `worker`, `mock-erp`, and
`dashboard`. Health checks:

- API:       <http://localhost:3010/healthz>
- Mock ERP:  <http://localhost:3002/healthz>
- Dashboard: <http://localhost:3003>

**Development**

```bash
pnpm dev          # run app dev servers (against Postgres/Redis in docker)
pnpm test         # Vitest, workspace-wide
pnpm typecheck    # tsc --noEmit across the workspace
pnpm lint         # eslint
pnpm format       # prettier --write
```

---

## Repo layout

```
integr8/
├─ apps/
│  ├─ api/          # Fastify ingestion API (webhooks + REST)
│  ├─ worker/       # queue consumer
│  ├─ dashboard/    # Next.js monitoring UI + Mapping Studio
│  └─ mock-erp/     # stand-in destination service
├─ packages/
│  ├─ core/         # env loader + logger; domain logic lands here in Phase 1
│  └─ db/           # Prisma schema + client
├─ Dockerfile       # shared image; APP_NAME build arg selects the app
├─ docker-compose.yml
└─ ...
```

Future packages (`queue`, `connectors`, `ai`) are created in their respective phases —
see [`ROADMAP.md`](./ROADMAP.md).

---

## Status

Phase 0 (scaffolding) complete. Phase 1 (domain model + interfaces) is next.
