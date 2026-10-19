# Guide Engine backend: the Studio API, the public agent API and the agent
# script. Built from the monorepo root:
#   docker build -f packages/backend/Dockerfile -t guide-engine-backend .
#
# Stage 1 builds core -> agent bundle -> backend with the full workspace;
# stage 2 keeps only the backend's production dependencies, its compiled
# output, the migrations and the agent bundle it serves.

FROM node:22-alpine AS build
WORKDIR /app
# Workspace manifests first, so dependency installation is cached across code changes.
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/agent/package.json packages/agent/
COPY packages/backend/package.json packages/backend/
COPY packages/angular-wrapper/package.json packages/angular-wrapper/
COPY packages/vue-wrapper/package.json packages/vue-wrapper/
COPY apps/studio/package.json apps/studio/
COPY apps/demo/package.json apps/demo/
RUN npm ci --no-audit --no-fund
COPY tsconfig.base.json ./
COPY packages/core packages/core
COPY packages/agent packages/agent
COPY packages/backend packages/backend
RUN npm run build --workspace=packages/core \
 && npm run build --workspace=packages/agent \
 && npm run build --workspace=packages/backend

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/agent/package.json packages/agent/
COPY packages/backend/package.json packages/backend/
COPY packages/angular-wrapper/package.json packages/angular-wrapper/
COPY packages/vue-wrapper/package.json packages/vue-wrapper/
COPY apps/studio/package.json apps/studio/
COPY apps/demo/package.json apps/demo/
RUN npm ci --omit=dev --no-audit --no-fund --workspace=packages/backend \
 && npm cache clean --force
COPY --from=build /app/packages/backend/dist packages/backend/dist
COPY --from=build /app/packages/backend/migrations packages/backend/migrations
COPY --from=build /app/packages/agent/dist packages/agent/dist
COPY packages/backend/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD wget -qO- http://127.0.0.1:3000/health >/dev/null || exit 1
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "packages/backend/dist/index.js"]
