---
title: DevOps handoff
parent: DevOps quick guide
nav_order: 1
---

# Guide Engine — DevOps handoff

**Date:** 2026-10-26 · **From:** Guide Engine integration (WISE) · **For:** DevOps

Guide Engine puts in-app guides (tooltips, tours, a help center) into the WISE staff console and the
OPAC. The proof of concept is done and approved for production, and this is the first time it is
deployed. This page lists what DevOps needs to run it: what to deploy, the servers, the decisions we
need from you, the settings, the go-live steps and how to check it works.

Background reading, all optional:

- [DevOps quick guide](devops.md): everyday commands for the `deploy/` stack
- [Go-live checklist](../README.md#go-live-checklist) in the reference
- [How Guide Engine is built](architecture.md)
- [WISE integration](wise/index.md): the [integration and production TODO](wise/integration.md),
  the [signed identity spec for the WISE API](wise/signed-identity.md) and the
  [project handbook](wise/handbook.md) (projects, hosts, configuration files)

---

## 1. What runs

One Guide Engine service per environment, shared by the console and the OPAC.

| Component | Image | Notes |
|---|---|---|
| Backend (API + agent script) | `ghcr.io/mohanvegi4/guide/backend:<sha>` | Node 22, port 3000, stateless. Runs database migrations on start (locked, safe with several replicas). Liveness `/health`, readiness `/ready`. |
| Studio (authoring website) | `ghcr.io/mohanvegi4/guide/studio:<sha>` | nginx, port 80. Proxies `/api/*` to the backend. |
| Keycloak (Studio sign-in) | `quay.io/keycloak/keycloak:26.0` | Production mode, port 8080 (health on 9000), its own database. Only Studio authors sign in here; WISE staff and patrons never do. |
| PostgreSQL | `postgres:16` | Two databases, `guide_engine` and `keycloak`, each with its own role. |
| Caddy (optional) | `caddy:2-alpine` | TLS and routing in our compose stack. Replace with your load balancer or ingress if you prefer. |
| Prometheus + Alertmanager (optional) | `prom/prometheus:v3`, `prom/alertmanager:v0.34.1` | Or point your existing monitoring at the backend's `/metrics`. |

A ready-made single-host stack is in this repository under `deploy/` (compose file, Caddyfile,
backup and restore scripts, alert rules). Use it as is, or as the reference for your platform.

**Who calls what**

| Caller | Calls | Must be reachable from |
|---|---|---|
| Browsers of WISE staff and **patrons** | `API_HOST` (agent script and agent API) | The internet, wherever the OPAC is used |
| Studio authors | `STUDIO_HOST`, `AUTH_HOST` | Your staff network or VPN is enough |
| Backend | Keycloak (token signing keys), Postgres, optional SMTP and Sentry | Internal |
| Keycloak admins | `AUTH_HOST/admin` | Only the networks in `ADMIN_ALLOW_CIDRS` |

---

## 2. Servers

These are **starting sizes** for the first deployment. No load test has been done yet: they come
from each component's own needs and from how the backend works (stateless, a few small Postgres
queries per page view). Load test on staging and resize before production traffic grows.

**Production**

| Server | Runs | vCPU | Memory | Disk | Reachable from | How many |
|---|---|---|---|---|---|---|
| Load balancer / ingress | TLS for the three hostnames, routing (Caddy in our stack, or your existing load balancer) | shared | shared | — | Internet: 443, and 80 for redirects | Your existing one, or Caddy on the app servers |
| App server | Backend and Studio containers | 2 | 4 GB | 30 GB | Load balancer only | 2: one works, two allow deploys without downtime |
| Keycloak server | Keycloak 26 | 2 | 2 GB | 20 GB | Load balancer only | 1 (can share the app servers to start) |
| Database server | PostgreSQL 16 with both databases | 2 | 8 GB | 100 GB SSD | App and Keycloak servers only | 1; managed Postgres with point-in-time recovery preferred |
| Backup storage | Nightly dumps of both databases, kept 14 days | — | — | 20 GB to start | Database or backup host only | 1 bucket or share, off the database server |
| Monitoring | Prometheus and Alertmanager | 1 | 2 GB | 20 GB | Internal only | Your existing stack, or 1 |

**Staging**

| Server | Runs | vCPU | Memory | Disk |
|---|---|---|---|---|
| One VM | The whole `deploy/` stack: Caddy, backend, Studio, Keycloak, Postgres, backups | 4 | 8 GB | 80 GB |

Production can also start on a single VM running the `deploy/` stack (4 vCPU, 16 GB, 150 GB SSD),
with no redundancy: one machine down means no guides and no Studio until it is back. WISE pages keep
working either way, because the agent fails silent.

**What drives the database disk.** The `guide_event` table: one row per guide shown, step viewed,
completed or dismissed, kept for `EVENT_RETENTION_DAYS` (400 by default). As a rough estimate, allow
1 KB per event with its indexes; 100,000 events a day kept 400 days is about 40 GB. Everything else
(guides, users, Keycloak) stays under a few hundred MB.

**Ports between servers**

| From | To | Port |
|---|---|---|
| Load balancer | Backend | 3000 |
| Load balancer | Studio | 80 |
| Load balancer | Keycloak | 8080 |
| Backend | PostgreSQL | 5432 |
| Keycloak | PostgreSQL | 5432 |
| Backend | Keycloak (token signing keys) | 8080 |
| Studio (nginx) | Backend | 3000 |
| Prometheus | Backend `/metrics` | 3000 |
| Health checks | Backend `/ready`, Keycloak `/health/ready` | 3000, 9000 |

**DNS:** three names per environment (Studio, API, auth), so six records for staging and production.

---

## 3. Decisions we need from DevOps

| # | Decision | Options | Our suggestion |
|---|---|---|---|
| 1 | Where it runs | Our `deploy/` compose stack on VMs, or your platform (Kubernetes, ECS…) | Your standard platform; `deploy/` shows every piece it needs |
| 2 | Environments | Staging and production at least | Staging first, same setup as production |
| 3 | Hostnames per environment | Three names: Studio, API, auth | e.g. `guides-studio.…`, `guides-api.…`, `guides-auth.…` under an OCLC domain |
| 4 | TLS | Caddy with Let's Encrypt, or your certificates and ingress | Your ingress and certificates |
| 5 | PostgreSQL | Container with nightly dumps, or managed Postgres | Managed, with point-in-time recovery |
| 6 | Image registry | Pull from GHCR, or mirror into your internal registry | Mirror into your internal registry (Nexus); the GHCR images sit under a personal GitHub account today |
| 7 | Source location | GitHub `mohanvegi4/guide` today | Move to an OCLC organization or Bitbucket before go-live, with CI rebuilt there |
| 8 | Secrets | Where the settings in section 4 live | Your secret store; never only on a host |
| 9 | Monitoring and paging | Bundled Prometheus/Alertmanager, or your stack | Your stack, importing the rules in `deploy/monitoring/alerts.yml` |
| 10 | Logs | JSON lines on stdout | Ship to your log platform |
| 11 | Email | SMTP relay for Studio invitations | Optional; without it, invitations are links to copy |
| 12 | Error tracking | Sentry DSN | Optional |
| 13 | CDN for the agent script | None, or a CDN in front of `API_HOST/agent/v1/*` | Not needed at first |
| 14 | Sizing | Section 2 | Confirm after a staging load test |

---

## 4. Settings

Every setting is listed with its comment in `deploy/.env.example`. For your platform, these are the
values to provide per environment.

**Required**

| Setting | Value |
|---|---|
| `STUDIO_HOST`, `API_HOST`, `AUTH_HOST` | The three hostnames (decision 3) |
| `DATABASE_URL` | `postgres://guide_engine:…@…/guide_engine`. The role **must not** be a superuser or have `BYPASSRLS`: the backend refuses to start otherwise, because row-level security keeps customers apart |
| Keycloak database | Its own database and role (`KC_DB_URL`, `KC_DB_USERNAME`, `KC_DB_PASSWORD`) |
| `KEYCLOAK_ADMIN_USER`, `KEYCLOAK_ADMIN_PASSWORD` | Bootstrap admin for the Keycloak console |
| `ADMIN_ALLOW_CIDRS` | Office or VPN ranges allowed to open the Keycloak admin console. Empty means nobody |
| `PREVIEW_TOKEN_SECRET` | `openssl rand -hex 32` |
| `SECRETS_KEY` | `openssl rand -hex 32`. Encrypts apps' signing secrets. **Back it up with the database**: losing it means every app must generate a new signing secret |
| `NODE_ENV=production`, `TRUST_PROXY=true`, `RATE_LIMIT_STORE=postgres` | Fixed values; `deploy/docker-compose.yml` sets them |
| `PUBLIC_API_URL` | `https://API_HOST` |
| `OIDC_ISSUER`, `OIDC_AUDIENCE`, `OIDC_JWKS_URI`, `OIDC_STUDIO_CLIENT_ID` | Keycloak realm `guide-engine`, audience `guide-engine-api`, client `guide-studio` (see `deploy/docker-compose.yml`) |
| Studio image: `BACKEND_URL`, `OIDC_ORIGIN` | Where nginx proxies `/api`, and `https://AUTH_HOST` (needed for the security policy, or sign-in fails) |

**Optional**

| Setting | Effect |
|---|---|
| `METRICS_TOKEN` | Bearer token for `/metrics`; without it the endpoint answers 404 |
| `ALERT_WEBHOOK_URL` | Where the bundled Alertmanager posts |
| `SMTP_URL`, `MAIL_FROM` | Invitation emails |
| `SENTRY_DSN` | Server errors to Sentry |
| `BACKEND_REPLICAS` | More backend instances; nothing else changes |
| `EVENT_RETENTION_DAYS` | Default 400; must match what the privacy notice says |
| `BACKUP_AT`, `BACKUP_KEEP_DAYS`, `BACKUP_COPY_CMD` | Only with the bundled backup service |

---

## 5. Go-live steps (per environment)

1. **Servers and DNS.** Provision the servers in section 2 and the three DNS names.
2. **Images.** Deploy images built from the release commit we give you (section 8). Mirror them into
   your registry if you chose that.
3. **Databases.** Create the two databases and roles (`deploy/init.sh` shows the exact SQL).
4. **Keycloak realm.** Run `deploy/render-realm.sh` with the environment's settings: it produces the
   production realm (no test users, brute-force protection on, redirect URIs set to the Studio
   host). Keycloak imports it on first start only.
5. **Start** PostgreSQL, Keycloak, backend, Studio and the ingress. The backend migrates the
   database on its first start.
6. **First user.** In the Keycloak admin console, realm `guide-engine`: add a user, tick *Email
   verified*, set a password. Also create a permanent admin in the `master` realm and turn on its
   brute-force detection.
7. **First platform admin.** After that user has signed in to the Studio once:
   `UPDATE studio_user SET platform_admin = TRUE WHERE email = '…';`
8. **Backups.** Nightly dumps of both databases (or managed backups), copied off the database
   server. Rehearse one restore (`deploy/restore.sh`) on staging.
9. **Monitoring.** Scrape `/metrics` with `METRICS_TOKEN`, load the alert rules, send alerts to your
   on-call channel.
10. **Hand back to us** the three URLs and a Studio login. We then create the WISE applications in
    the Studio and give the frontend team the production keys (section 7).

---

## 6. How to check it works

```bash
curl -s https://API_HOST/health                 # {"ok":true}
curl -s https://API_HOST/ready                  # {"ok":true} when the database is reachable
curl -s https://API_HOST/agent/v1/version       # {"version":"…","hash":"…"} = the deployed agent
```

| Check | Expected |
|---|---|
| Studio at `https://STUDIO_HOST` | "Sign in with SSO" goes to Keycloak and back |
| `https://AUTH_HOST/admin` from outside `ADMIN_ALLOW_CIDRS` | 403 |
| `/metrics` without the token | 401 (404 when no token is configured) |
| Response headers on the Studio | HSTS, `X-Frame-Options: DENY`, a Content-Security-Policy |
| Smoke test (`e2e/` in this repository) | Signs in, creates an organization and a guide, sees it on a test page, deletes the organization. Needs a Keycloak test user. |
| Restore rehearsal | `/ready` answers after `restore.sh` on staging |
| Alert test | Stopping the backend pages on-call within about 2 minutes (`BackendDown`) |

---

## 7. What other teams do (not DevOps, but go-live depends on it)

| Who | What |
|---|---|
| Guide Engine integration | Create the production "WISE Staff console" and "WISE OPAC" applications in the Studio, with the real site origins in their websites list, and re-create the guides with their permission tags (the [guide catalogue](wise/integration.md#13-studio-content-and-the-guide-catalogue)). |
| WISE frontend | Merge the two `poc/guide-engine` branches through the normal review. Put the production API host and app keys in each app's `environment.prod.ts` (today `null`, so guides are off). |
| WISE API team | Build the two signed-identity endpoints ([Signed identity for the WISE API](wise/signed-identity.md), on top of the generic [Signed identity](integration/signed-identity.md) contract). They need each app's signing secret from the Studio, stored in the WISE backend configuration per environment: a secret for DevOps to manage. |
| Product, legal | Privacy notice wording for patrons and the event retention period. |

---

## 8. Status and known limits

- **Release to deploy.** The images published so far do not include the latest fixes. We will
  give you the commit and image tag to deploy.
- **Graceful shutdown.** The backend does not drain requests on `SIGTERM`. Take an instance out of
  the load balancer (readiness) before stopping it during a rolling deploy.
- **Rate limiting** is counted in PostgreSQL: one small write per agent request.
- **Retention** runs inside the backend once a day; the events table is not partitioned.
- **Agent script** is cached by browsers for 5 minutes. A rollback is redeploying the previous
  image; customers never change their snippet.
- **Key rotation** in the Studio breaks the installed snippets until they are updated. Only do it
  on purpose.
- **Not done yet:** a load test (section 2), and an `npm` release of the optional packages (not
  needed for this deployment).
