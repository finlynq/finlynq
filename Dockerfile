# ── Stage 1: Install dependencies ────────────────────────────────────────────
# TODO(security): pin node:22-alpine to a digest (e.g. node:22-alpine@sha256:...)
# so a tag rebase can't silently swap the base image we publish from.
FROM node:22-alpine AS deps
RUN apk add --no-cache libc6-compat python3 make g++
WORKDIR /app

COPY package.json package-lock.json ./
# --ignore-scripts: the `postinstall` hook runs scripts/generate-mcp-tool-catalog.mjs
# which needs files we haven't COPY'd yet. The builder stage regenerates the
# catalog via the `prebuild` script before `npm run build` once the source is in.
RUN npm ci --omit=dev --ignore-scripts

# ── Stage 2: Build the application ───────────────────────────────────────────
# TODO(security): pin node:22-alpine to a digest — see deps stage.
FROM node:22-alpine AS builder
RUN apk add --no-cache libc6-compat python3 make g++
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

# `.dockerignore` (added in the Docker hardening pass) keeps `.env*`, `.git`,
# `node_modules`, `.next`, tests, agent state, etc. out of the image. If you
# ever publish a slimmer Dockerfile, audit `.dockerignore` first — `COPY . .`
# is otherwise the load-bearing place secrets sneak into a published layer.
COPY . .

# Build the Next.js app (standalone output for minimal image)
# Set NEXT_BASE_PATH=/app for managed deployment behind Nginx
ARG NEXT_BASE_PATH=""
ENV NEXT_BASE_PATH=$NEXT_BASE_PATH
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ── Stage 3: Production image ─────────────────────────────────────────────────
# TODO(security): pin node:22-alpine to a digest — see deps stage.
FROM node:22-alpine AS runner
RUN apk add --no-cache curl netcat-openbsd
WORKDIR /app

ARG NEXT_BASE_PATH=""
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV NEXT_BASE_PATH=$NEXT_BASE_PATH

# Create non-root user
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

# Copy standalone build output
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

# Copy the schema baseline + migration chain and the runner that applies them.
# `drizzle-pg/` is deliberately NOT copied any more: it only ever created 21 of
# the ~68 tables the app needs, which is why the published image could never
# reach a registerable instance (GH #312). It survives in the repo for local
# `npm run db:generate` workflows and is no longer a deployment path.
COPY --from=builder /app/scripts/baseline ./scripts/baseline
COPY --from=builder /app/scripts/migrations ./scripts/migrations
COPY --from=builder /app/scripts/run-migrations.mjs ./scripts/run-migrations.mjs

# Copy and prepare the entrypoint script
COPY scripts/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

USER nextjs

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD curl -f http://localhost:3000${NEXT_BASE_PATH:-}/api/healthz || exit 1

ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "server.js"]
