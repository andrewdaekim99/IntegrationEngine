# Architecture decisions

A running log of non-obvious choices, with the alternative considered and the reason.
New entries go at the top.

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
