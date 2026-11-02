# syntax=docker/dockerfile:1.7
# One build, four images:  docker build -f docker/Dockerfile --target <api|admin|web|migrate> -t canon-<target> .
ARG NODE_VERSION=24-bookworm-slim

FROM node:${NODE_VERSION} AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH NEXT_TELEMETRY_DISABLED=1
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate \
 && apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /repo

# ── Build everything once ─────────────────────────────────────────────────────
FROM base AS build
COPY . .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
RUN pnpm --filter @canon/db exec prisma generate
# Next inlines NEXT_PUBLIC_* at build time; everything else is read at runtime.
ARG NEXT_PUBLIC_CANON_COLLAB_URL=""
ENV NEXT_PUBLIC_CANON_COLLAB_URL=${NEXT_PUBLIC_CANON_COLLAB_URL}
RUN pnpm -r --filter "./packages/*" build \
 && pnpm --filter @canon/api build \
 && pnpm --filter @canon/admin exec next build \
 && pnpm --filter @canon/web exec next build

# ── Migrations: only @canon/db with its Prisma CLI; run as a one-off job before rollout ──
FROM build AS migrate-deploy
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm --filter @canon/db deploy /migrate \
 && rm -rf /migrate/node_modules/.pnpm/*musl*

FROM node:${NODE_VERSION} AS migrate
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
WORKDIR /migrate
COPY --from=migrate-deploy --chown=node:node /migrate ./
USER node
# DATABASE_URL must be the owner (migrator) role.
CMD ["node", "node_modules/prisma/build/index.js", "migrate", "deploy"]

# ── API: production dependencies only ─────────────────────────────────────────
# `pnpm deploy` copies the API with production dependencies only; workspace packages arrive as
# their published files (dist + prisma schema). The Prisma client generated in the build stage
# (same @prisma/client version, pinned by the lockfile) is copied next to the deployed package.
FROM build AS api-deploy
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm --filter @canon/api deploy --prod /out \
 && GEN="$(dirname "$(dirname "$(readlink -f /repo/packages/db/node_modules/@prisma/client)")")/.prisma" \
 && for d in /out/node_modules/.pnpm/@prisma+client@*/node_modules; do cp -r "$GEN" "$d/"; done \
 && rm -rf /out/src /out/test /out/coverage /out/vitest*.mts \
 # Build-time only (TypeScript) and the musl variants of native modules (this image is glibc).
 && rm -rf /out/node_modules/.pnpm/typescript@* /out/node_modules/.pnpm/*musl* \
 && node -e "require('/out/node_modules/@canon/db'); console.log('prisma client ok')"

FROM node:${NODE_VERSION} AS api
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates tini && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
WORKDIR /app
COPY --from=api-deploy --chown=node:node /out ./
USER node
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=3s --start-period=30s CMD node -e "fetch('http://127.0.0.1:'+(process.env.API_PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/main.js"]

# ── Admin and renderer: Next standalone servers ───────────────────────────────
FROM node:${NODE_VERSION} AS admin
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
COPY --from=build --chown=node:node /repo/apps/admin/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/admin/.next/static ./apps/admin/.next/static
USER node
EXPOSE 3000
CMD ["node", "apps/admin/server.js"]

FROM node:${NODE_VERSION} AS web
ENV NODE_ENV=production PORT=3001 HOSTNAME=0.0.0.0 NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
USER node
EXPOSE 3001
CMD ["node", "apps/web/server.js"]
