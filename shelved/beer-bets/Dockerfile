# Build stage -----------------------------------------------------------------
FROM node:22-slim AS build

WORKDIR /app

# Copy manifests first so the dependency layer is cached across source changes.
COPY package.json package-lock.json ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/netcode/package.json packages/netcode/
COPY packages/sim/package.json packages/sim/
COPY packages/games/table-games/package.json packages/games/table-games/
COPY apps/server/package.json apps/server/

# The client is served straight from node_modules/three, so production needs the
# dev dependency tree present at build time. PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD
# stops the client smoke-test dependency pulling ~150MB of browser we never run
# inside the image.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm ci

COPY . .
RUN npm run build

# Runtime stage ---------------------------------------------------------------
FROM node:22-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

# Run unprivileged. The node image already ships a `node` user.
COPY --from=build --chown=node:node /app /app
USER node

EXPOSE 8080
ENV PORT=8080 HOST=0.0.0.0

# `serve` runs the already-built output; `start` would rebuild on every boot.
CMD ["node", "apps/server/dist/index.js"]
