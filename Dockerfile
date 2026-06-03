# Shared Dockerfile for api, worker, mock-erp, and dashboard.
# Pass APP_NAME as a build arg to select which workspace package this image runs.

FROM node:20-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app

ARG APP_NAME
ENV APP_NAME=${APP_NAME}

# Workspace manifest + lockfile + shared TS config (lockfile is optional on the very first build).
COPY pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY pnpm-lock.yaml* ./

# Source — copy packages before apps so deeper layers cache better.
COPY packages ./packages
COPY apps ./apps

# Install all workspace dependencies. packages/db's postinstall runs `prisma generate`.
RUN pnpm install

WORKDIR /app/apps/${APP_NAME}
CMD ["pnpm", "dev"]
