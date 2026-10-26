---
title: Project handbook
parent: WISE integration
nav_order: 3
---

# Guide Engine project handbook

**Date:** 2026-10-25

Every project built for Guide Engine and its WISE integration: where each one lives, the tools it
uses, the hosts it runs on, and where its Docker and configuration files are. The last section is a
very short DevOps guide; the full one is the [DevOps quick guide](../devops.md).

---

## 1. Projects

| Project | What it is | Where | Branch |
|---|---|---|---|
| **Guide Engine** (monorepo) | The product: API, agent, Studio, deploy stack, docs | GitHub [`mohanvegi4/guide`](https://github.com/mohanvegi4/guide) | `main` |
| ↳ `packages/backend` | Express + Postgres API: Studio API, public agent API, migrations, operator scripts | in the monorepo | |
| ↳ `packages/core` | The browser engine: guide selection, step rendering, help widget (npm `@guide-engine/core`) | in the monorepo | |
| ↳ `packages/agent` | The install-snippet script, served at `/agent/v1/<key>/guides.js` | in the monorepo | |
| ↳ `packages/angular-wrapper`, `packages/vue-wrapper` | Optional npm alternatives to the snippet (`@guide-engine/angular`, `/vue`) | in the monorepo | |
| ↳ `apps/studio` | The authoring Studio (Angular) | in the monorepo | |
| ↳ `apps/demo` | A plain page that installs the snippet, for local testing | in the monorepo | |
| ↳ `e2e` | Playwright smoke test | in the monorepo | |
| ↳ `deploy` | Single-host production stack | in the monorepo | |
| ↳ `docs` | This docs site's source | in the monorepo | |
| **WISE staff console** | Guide Engine installed: agent loader, permission tags, ~85 anchors | Bitbucket, project `APPS`, repository `application-ng-staff` | `poc/guide-engine` (pushed) |
| **WISE OPAC** | Guide Engine installed: agent loader, patron tags, ~90 anchors | Bitbucket, project `APPS`, repository `application-ng-patron` | `poc/guide-engine` (pushed) |
| Local WISE development stack (used, not ours) | The compose project (parliament) the two apps run in locally | outside these repositories | |

The Guide Engine code inside each WISE app is one service:
`projects/application-wise-console/src/app/services/guide-engine/` (console) and
`projects/opac/src/app/services/guide-engine/` (OPAC).

**Documents**, all on this site:

| Document | Page |
|---|---|
| Reference, Studio, architecture, DevOps, generic signed identity | [Home](../index.md) |
| Integration document and production TODO | [Integration and production TODO](integration.md) |
| Signed identity spec for the WISE API team | [Signed identity for the WISE API](signed-identity.md) |
| First deployment, for DevOps | [DevOps handoff](../handoff-devops.md) |
| This handbook | [Project handbook](handbook.md) |

---

## 2. Tools

**Guide Engine**

| Area | Tools |
|---|---|
| Runtime | Node 22, TypeScript 5 (strict), npm workspaces |
| API | Express 4, `pg`, zod, `jsonwebtoken` + `jwks-rsa`, pino, prom-client, nodemailer, sanitize-html, optional Sentry |
| Data | PostgreSQL 16 with forced row-level security |
| Sign-in | Keycloak 26.0 (OIDC, PKCE) |
| Studio | Angular 21 (zoneless, signals), `oidc-client-ts`, nginx 1.27 |
| Agent | esbuild (one minified IIFE bundle) |
| Tests | vitest + jsdom, supertest, Playwright |
| Production stack | Docker Compose, Caddy 2, Prometheus v3, Alertmanager 0.34.1 |
| CI/CD | GitHub Actions, GitHub Container Registry, GitHub Pages (Jekyll, Just the Docs), npm |

**WISE apps**

| Area | Tools |
|---|---|
| Framework | Angular 21.2, NgRx 21, TypeScript 5.9 |
| Tests | Karma + Jasmine (100 % coverage enforced on the OPAC), Cypress 13 |
| Quality | ESLint 10, Prettier, lint-staged on commit |
| CI/CD | Jenkins (`Jenkinsfile`), Bitbucket, the internal registry (Nexus) |
| Local stack | Docker Desktop with the local WISE development stack (a compose project) |

---

## 3. Hosts

**Local development**

| Port / URL | What |
|---|---|
| `http://localhost:3000` | Guide Engine backend (API and agent script) |
| `http://localhost:4300` | Guide Studio |
| `http://localhost:5174` | Guide Engine demo page |
| `localhost:5433` | Guide Engine Postgres (`guide_engine` and `guide_engine_test`) |
| `http://localhost:8081` | Keycloak, realm `guide-engine` (test users: [Studio login details](../../README.md#studio-login-details)) |
| Local WISE development stack, port 10000, path `/staff/console` | WISE staff console (through the stack's HTTPS proxy) |
| Local WISE development stack, port 10000, path `/wise-apps/opac/branch/1400/home` | WISE OPAC (through the stack's HTTPS proxy) |
| Local WISE development stack, port 10017 | The stack's proxy, plain HTTP |

**Remote**

| Host | What |
|---|---|
| The WISE QA environment (internal) | WISE console and OPAC for testing |
| `https://github.com/mohanvegi4/guide` | Guide Engine repository and CI |
| `ghcr.io/mohanvegi4/guide/backend`, `…/studio` | Guide Engine images (tags `latest` and the commit SHA) |
| `https://mohanvegi4.github.io/guide/` | This docs site |
| Bitbucket (internal), project `APPS` | WISE repositories |
| `https://help.wise.oclc.org` | WISE help sites the guides were written from |
| `STUDIO_HOST`, `API_HOST`, `AUTH_HOST` | Production Guide Engine hostnames: **not chosen yet** ([integration TODO](integration.md#a-guide-engine-service) item 1) |

**Dev Studio applications.** The two development applications ("WISE Staff console" and
"WISE OPAC (patron)") are listed in [Studio content and the guide catalogue](integration.md#13-studio-content-and-the-guide-catalogue).
Their public keys are in each WISE app's dev environment file.

---

## 4. Docker and configuration files

**Guide Engine** (paths from the repository root)

| File | Purpose |
|---|---|
| `docker-compose.yml` | Development: Postgres on 5433, Keycloak on 8081 (profile `sso`) |
| `docker/init.sql` | Development database roles and databases |
| `docker/keycloak/guide-engine-realm.json` | Development Keycloak realm, client and users |
| `packages/backend/Dockerfile`, `packages/backend/docker-entrypoint.sh` | Backend image; migrates on start |
| `apps/studio/Dockerfile`, `apps/studio/nginx.conf.template` | Studio image; nginx, `/api` proxy, security headers |
| `deploy/docker-compose.yml` | Production stack |
| `deploy/Caddyfile` | HTTPS, hostnames, Keycloak admin allowlist |
| `deploy/.env.example` | Every production setting (copy to `deploy/.env`) |
| `deploy/init.sh` | Production database roles |
| `deploy/render-realm.sh` | Production Keycloak realm from the dev one |
| `deploy/backup.sh`, `deploy/restore.sh` | Nightly dumps and restore |
| `deploy/monitoring/` | `prometheus.yml`, `alerts.yml`, `alerts.test.yml`, `alertmanager.yml` |
| `packages/backend/.env` (from `.env.example`) | Local backend settings |
| `apps/demo/.env.local` | Demo page key and API, written by `npm run seed` |
| `apps/studio/proxy.conf.json` | Dev server `/api` → `localhost:3000` |
| `.claude/launch.json` | Local launch definitions for backend, Studio and demo |
| `.github/workflows/ci.yml`, `docs.yml`, `release.yml` | CI, docs site, npm release |

**WISE staff console** (paths from the `application-ng-staff` repository root)

| File | Purpose |
|---|---|
| `docker/serve/Dockerfile`, `docker/serve/entrypoint.sh` | Dev serve container (local WISE development stack) |
| `docker/test/Dockerfile`, `docker/e2e/Dockerfile` | Unit and e2e test containers |
| `projects/application-wise-console/src/environments/environment.template.ts` | Dev values, incl. `guideEngine: { apiUrl, appKey }` |
| `…/environments/environment.ts` | Your local copy (git-ignored), needs the `guideEngine` field |
| `…/environments/environment.prod.ts`, `environment.cypress.ts` | `guideEngine: null` until production values exist |
| `Jenkinsfile` | Build pipeline |

**WISE OPAC** (paths from the `application-ng-patron` repository root)

| File | Purpose |
|---|---|
| `docker/serve/Dockerfile`, `docker/serve/entrypoint.sh`, `docker/serve/filelist/` | Dev serve container and embedded-mode file list |
| `docker/test/Dockerfile`, `docker/e2e/Dockerfile` | Unit and e2e test containers |
| `projects/opac/src/environments/environment.default.ts` | Dev values, incl. `guideEngine` |
| `…/environments/environment.dev.ts` | Your local file (git-ignored), spreads the default |
| `…/environments/environment.prod.ts`, `environment.cypress.ts` | `guideEngine: null` until production values exist |
| `projects/opac/proxy.dev.conf.json`, `proxy.docker.conf.json` | Dev server proxies |
| `Jenkinsfile` | Build pipeline |

**Local WISE development stack** (its `compose.yml`): the services `application-ng-staff-console`
and `application-ng-patron-opac` mount the two checkouts read-only; `development-docker-wise-proxy`
(the WISE dev proxy image, version 4.10.1, from the internal registry) publishes ports 10000 and
10017.

---

## 5. DevOps in short

The full guide, for the production stack, is the [DevOps quick guide](../devops.md); the first
deployment is the [DevOps handoff](../handoff-devops.md).

**Run everything locally**, from the Guide Engine repository root:

```bash
npm run db:up                                       # Postgres 5433
npm run idp:up                                      # Keycloak 8081
npm run migrate
npm run dev:backend                                 # 3000
npm run start --workspace=apps/studio -- --port 4300
```

If your shell sets `DOCKER_DEFAULT_PLATFORM` (for example to `linux/amd64` for the WISE images),
unset it for the Guide Engine containers, which run natively:
`env -u DOCKER_DEFAULT_PLATFORM npm run db:up` (and the same for `idp:up`). Start the WISE apps with
the local WISE development stack as usual.

**Stop it**

```bash
npm run db:down
docker compose --profile sso down
```

**Release and deploy**

| Step | How |
|---|---|
| Build images | Automatic on every push to `main` (GitHub Actions → GHCR) |
| Publish npm packages | `npm run version:set X.Y.Z`, commit, `git tag vX.Y.Z && git push origin main vX.Y.Z` (needs the `NPM_TOKEN` secret) |
| Deploy | On the server in `deploy/`: `docker compose run --rm backup now`, `docker compose pull backend studio`, `docker compose up -d --wait` |
| Roll back | Set `BACKEND_IMAGE` / `STUDIO_IMAGE` in `.env` to the previous SHA, `docker compose up -d --wait` |
| WISE apps | Through the usual Jenkins pipelines once the branches are merged; set production `guideEngine` values in `environment.prod.ts` first |

**Health checks**

```bash
curl -s http://localhost:3000/ready
curl -s http://localhost:3000/agent/v1/version
```
