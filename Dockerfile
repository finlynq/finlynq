# ── Stage 1: Install dependencies ────────────────────────────────────────────
FROM node:22-alpine AS deps
RUN apk add --no-cache libc6-compat python3 make g++
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ── Stage 2: Build the application ───────────────────────────────────────────
FROM node:22-alpine AS builder
RUN apk add --no-cache libc6-compat python3 make g++
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# Build the Next.js app (standalone output for minimal image)
# Set NEXT_BASE_PATH=/app for managed deployment behind Nginx
ARG NEXT_BASE_PATH=""
ENV NEXT_BASE_PATH=$NEXT_BASE_PATH
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ── Stage 3: Production image ─────────────────────────────────────────────────
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

# Copy PostgreSQL migration files
COPY --from=builder /app/drizzle-pg ./drizzle-pg

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
