# syntax=docker/dockerfile:1
# Build context is the repo root (see compose.vm.yml).

# Full source + dependencies. Used for the worker, migrations and the admin scripts (they run on bun).
FROM node:22-bookworm-slim AS tools
COPY --from=oven/bun:1.4.2 /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /repo
COPY package.json bun.lock ./
COPY packages/core/package.json packages/core/
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
RUN bun install --frozen-lockfile
COPY . .
# The hub keeps its SQLite file on a volume mounted here (docker/compose.hub.yml), writable by `node` (uid 1000).
RUN mkdir -p /data && chown 1000:1000 /data

FROM tools AS build
RUN cd apps/web && node node_modules/next/dist/bin/next build

# The web app: Next.js standalone output, no source or dev dependencies.
FROM node:22-bookworm-slim AS app
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
COPY --from=build /repo/apps/web/.next/standalone ./
COPY --from=build /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /repo/apps/web/public ./apps/web/public
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]

FROM tools AS worker
ENV NODE_ENV=production APP_MODE=worker
CMD ["bun", "apps/worker/src/main.ts"]
