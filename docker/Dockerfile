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

# ── Migrations / seed (has the Prisma CLI): run as a one-off job before rollout ──
FROM build AS migrate
ENV NODE_ENV=production
CMD ["pnpm", "--filter", "@canon/db", "exec", "prisma", "migrate", "deploy"]

# ── API: production dependencies only ─────────────────────────────────────────
FROM build AS api-prune
RUN --mount=type=cache,id=pnpm,target=/pnpm/store CI=true pnpm install --prod --frozen-lockfile --offline --filter "@canon/api..." \
 && pnpm --filter @canon/db exec prisma generate || true

FROM node:${NODE_VERSION} AS api
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates tini && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
WORKDIR /repo
COPY --from=api-prune --chown=node:node /repo/node_modules ./node_modules
COPY --from=api-prune --chown=node:node /repo/packages ./packages
COPY --from=api-prune --chown=node:node /repo/apps/api/package.json ./apps/api/package.json
COPY --from=api-prune --chown=node:node /repo/apps/api/node_modules ./apps/api/node_modules
COPY --from=api-prune --chown=node:node /repo/apps/api/dist ./apps/api/dist
USER node
WORKDIR /repo/apps/api
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
