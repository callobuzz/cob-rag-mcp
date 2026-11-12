# syntax=docker/dockerfile:1
# =============================================================================
# cob-rag-mcp: the MCP server in streamable HTTP mode.
#
#   docker build -t cob-rag-mcp .
#   docker run --rm -p 127.0.0.1:3333:3333 -e COB_RAG_URL=http://host.docker.internal:8000 cob-rag-mcp
#
# Every request must carry its caller's own engine key (Authorization: Bearer <key> or
# X-API-Key). No key is baked in, and none is needed to start.
# =============================================================================

# -----------------------------------------------------------------------------
# Stage 1: build
# -----------------------------------------------------------------------------
FROM node:22-alpine AS builder

RUN corepack enable
WORKDIR /build

# Manifests first so the dependency layer is cached independently of the source.
COPY package.json pnpm-lock.yaml .npmrc ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json tsup.config.ts ./
COPY src ./src
RUN pnpm build

# -----------------------------------------------------------------------------
# Stage 2: runtime (compiled output and production dependencies only)
# -----------------------------------------------------------------------------
FROM node:22-alpine AS runtime

RUN corepack enable && addgroup -S mcp && adduser -S -G mcp mcp
ENV NODE_ENV=production
WORKDIR /app

COPY package.json pnpm-lock.yaml .npmrc ./
RUN pnpm install --prod --frozen-lockfile --ignore-scripts && pnpm store prune
COPY --from=builder /build/dist ./dist

USER mcp

# In a container the server has to bind all interfaces to be reachable; publish the port on
# 127.0.0.1 (as above) unless you put TLS in front of it.
EXPOSE 3333
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3333/health || exit 1

ENTRYPOINT ["node", "dist/cli/index.js"]
CMD ["start", "--transport", "http", "--host", "0.0.0.0", "--port", "3333"]
