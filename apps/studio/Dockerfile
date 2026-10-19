# Guide Studio: the Angular build served by nginx, which also proxies /api/*
# to the backend (so the Studio needs no CORS and no build-time config).
# Built from the monorepo root:
#   docker build -f apps/studio/Dockerfile -t guide-engine-studio .
# Run with BACKEND_URL=http://backend:3000 (where nginx reaches the backend).

FROM node:22-alpine AS build
WORKDIR /app
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
COPY apps/studio apps/studio
RUN npm run build --workspace=apps/studio

FROM nginx:1.27-alpine
# nginx's entrypoint renders templates/*.template with envsubst at start.
COPY apps/studio/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/apps/studio/dist/studio/browser /usr/share/nginx/html
ENV BACKEND_URL=http://backend:3000
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1/healthz >/dev/null || exit 1
