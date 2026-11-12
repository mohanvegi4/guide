---
title: Deploying and operating
nav_order: 5
has_children: true
---

# Deploying and operating

How to run Guide Engine: with the `deploy/` stack on one server, or on your own platform. For a
first deployment at OCLC, start with the [DevOps handoff](handoff-devops.md): the servers to
provision, the decisions we need and the go-live steps. Why the stack is shaped this way is in
[How Guide Engine is built](architecture.md#14-deployment-and-operations).

## What runs

| Container | Image | Job |
|---|---|---|
| `caddy` | `caddy:2-alpine` | HTTPS for the three hostnames (certificates are automatic) |
| `studio` | `ghcr.io/mohanvegi4/guide/studio` | The Studio website (nginx), forwards `/api` to the backend |
| `backend` | `ghcr.io/mohanvegi4/guide/backend` | The API and the agent script; runs database migrations when it starts |
| `keycloak` | `quay.io/keycloak/keycloak:26.0` | Studio sign-in |
| `postgres` | `postgres:16` | Two databases: `guide_engine` and `keycloak`, each with its own user |
| `backup` | `postgres:16` | Dumps both databases every night into `deploy/backups/` |
| `prometheus`, `alertmanager` | `prom/prometheus:v3`, `prom/alertmanager:v0.34.1` | Optional (`--profile monitoring`): metrics and alerts |

Only Caddy is reachable from outside, on ports 80 and 443. It serves three hostnames you choose:

| Hostname | Goes to |
|---|---|
| `STUDIO_HOST` | the Studio |
| `API_HOST` | the backend; customer websites load the agent from here |
| `AUTH_HOST` | Keycloak; its `/admin` console only from `ADMIN_ALLOW_CIDRS` |

**Files you touch**, all in `deploy/` on the server:

| File | What it is |
|---|---|
| `.env` | Every setting and secret. Start from `.env.example`. Never commit it. |
| `docker-compose.yml` | The stack. You normally don't edit it. |
| `Caddyfile` | Hostnames, HTTPS, the Keycloak admin allowlist. |
| `keycloak-import/guide-engine-realm.json` | Written once by `render-realm.sh`; Keycloak reads it on first start only. |
| `backups/` | Nightly database dumps. Copy them off the server. |
| `monitoring/` | Prometheus scrape config, alert rules, Alertmanager receiver. |

**Images and CI.** `.github/workflows/ci.yml` runs on every push and pull request: it builds
every package, migrates a throwaway Postgres, runs the unit tests and the browser smoke test
(job `e2e`), and builds both images. On `main` it pushes them to GitHub Container Registry as
`ghcr.io/mohanvegi4/guide/backend` and `/studio`, tagged with the commit SHA and `latest`.
`apps/backend/Dockerfile` is the API plus the agent script (it runs pending migrations at start
unless `RUN_MIGRATIONS=false`); `apps/studio/Dockerfile` is the Angular build behind nginx, which
also proxies `/api/*` to `BACKEND_URL`.

---

## First install on one host

1. Point three DNS names at the server: the Studio, the API and Keycloak (for example `studio.`,
   `api.` and `auth.example.com`).
2. Install Docker with the compose plugin, and `jq`. Get the `deploy/` folder onto the server
   (clone the repository, or copy the folder).
3. Fill in the settings:
   ```bash
   cd deploy
   cp .env.example .env
   openssl rand -hex 32   # run twice: PREVIEW_TOKEN_SECRET and SECRETS_KEY
   ```
   Set the three hostnames, `ACME_EMAIL`, the three database passwords
   (`POSTGRES_SUPERUSER_PASSWORD`, `APP_DB_PASSWORD`, `KEYCLOAK_DB_PASSWORD`), the Keycloak admin
   user and password, and `ADMIN_ALLOW_CIDRS`: the office, VPN or bastion ranges that may open
   the Keycloak admin console, space-separated (empty means nobody). Keep `.env` in your secret
   store, not only on the host: losing `SECRETS_KEY` invalidates every app's signing secret.
4. Prepare the Keycloak realm, then start everything:
   ```bash
   ./render-realm.sh
   docker compose up -d --wait
   ```
   `render-realm.sh` writes `keycloak-import/guide-engine-realm.json` from the development realm,
   made safe for a real deployment: **no users** (the development realm's `vegim` / `editor` /
   `root` are stripped), brute-force detection on (5 failures lock a user for 1 min, growing to
   15 min), and the Studio client's redirect URIs and web origins set to exactly
   `https://STUDIO_HOST`. It keeps 15-minute access tokens and 8 h idle / 10 h maximum sessions.
   Keycloak imports the file on its first start only; later changes are made in the admin console.

   On the first `up`, Postgres creates the two roles and databases (`init.sh`), Keycloak imports
   the realm, the backend creates the schema, Caddy fetches certificates, and the `backup`
   service starts its nightly dumps. Start with an empty `guide_engine` database: one created by
   an image older than the squashed schema can't be upgraded, so drop and recreate it.
5. **Create the first user.** Nobody can sign in yet: the realm has no users and
   self-registration is off. Open `https://AUTH_HOST/admin` with the Keycloak admin user from
   `.env`. Caddy answers 403 there unless your address is in `ADMIN_ALLOW_CIDRS` (your current
   address as a `/32` is fine for a one-off); after changing it, `docker compose up -d caddy`
   applies it in a few seconds. There is no back door: an SSH tunnel reaches Caddy from the
   host's own address, not yours, and Keycloak serves the console on `AUTH_HOST` only.
   In the **guide-engine** realm, **Users → Add user**: username and email, tick **Email
   verified**, then set a password on the **Credentials** tab. While you're in the console,
   create a permanent admin in the **master** realm (Keycloak 26 treats the bootstrap admin as
   temporary) and turn on that realm's **Realm settings → Security defenses → Brute force
   detection**, which ships off. For more people, repeat, or connect your company's identity
   provider under **Identity providers**.
6. That person signs in to the Studio. **Welcome** creates their organization and its first
   application; they invite colleagues from **Members**.
7. **Make them a platform admin**, once, after they have signed in:
   ```bash
   docker compose exec postgres psql -U postgres -d guide_engine \
     -c "UPDATE studio_user SET platform_admin = TRUE WHERE email = 'them@example.com';"
   ```
   From then on platform admins are managed on the Studio's **Administration** page
   ([Guide Engine administration](security.md#guide-engine-administration)).

## Go-live checklist

Once the first install works, before real customers depend on it:

1. **Invitation emails.** `SMTP_URL` and `MAIL_FROM` in `.env` (compose derives `STUDIO_URL`
   from `STUDIO_HOST`), or accept that invitations are links the inviter copies.
2. **Error tracking, metrics and alerts.** `SENTRY_DSN` (optional), `METRICS_TOKEN` and
   `ALERT_WEBHOOK_URL`, then the monitoring profile. Without the webhook, no one is paged
   ([Observability](#observability)).
3. **Backups.** Set `BACKUP_COPY_CMD` or a host cron job for an off-host copy, check
   `BACKUP_KEEP_DAYS` against your privacy policy, and rehearse a restore once on a scratch host
   ([Backups and restore](#backups-and-restore)).
4. **Event retention.** `EVENT_RETENTION_DAYS` (default 400 in production; `0` is off). Write the
   number into the privacy policy and the DPA.
5. **The agent script.** `https://API_HOST/embed-agent/v1/<key>/guides.js` is a permanent contract. A
   CDN in front of `/embed-agent/v1/*` is optional; purge it on a rollback
   ([caching and rollbacks](#the-agent-script-caching-and-rollbacks)).
6. **Security headers** need nothing inside the compose stack. A Studio image run elsewhere needs
   `OIDC_ORIGIN`, and a replacement for Caddy or nginx must set the headers itself
   ([Security headers](#security-headers)).
7. **Smoke test the deployed stack** (`e2e/`, Playwright, Chromium). It signs in as a Keycloak
   user of the `guide-engine` realm and **creates and deletes an organization**
   `E2E <timestamp>`, which platform admins see on the Administration page while it exists:
   `STUDIO_URL=https://STUDIO_HOST API_URL=https://API_HOST KEYCLOAK_USER=… KEYCLOAK_PASSWORD=… npm run e2e`.
   `SITE_ORIGIN` defaults to `http://e2e.localhost`, a page the test serves itself.
8. **Legal templates** in `docs/legal/`: replace `{{COMPANY}}`, `{{CONTACT_EMAIL}}`,
   `{{JURISDICTION}}` and every `[date]` / `[…]` placeholder (the retention and backup numbers
   above go in there), and have counsel review them before publishing.
9. **Per customer app** in the Studio: the **Websites** of each environment are the real site
   origins (scheme + host + port; nothing loads elsewhere). For production customers, generate
   the **signing secret** and switch on **Require signed identity**
   ([Require signed identity](install.md#3-recommended-require-signed-identity)).

---

## Everyday tasks

**Is it healthy? Which build is live?**
```bash
docker compose ps
curl -s https://API_HOST/ready            # {"ok":true} when the backend reaches the database
curl -s https://API_HOST/embed-agent/v1/version # {"version":"…","hash":"…"}: the agent customers get
```
The version must match the banner of the image you shipped
(`head -1 packages/embed-agent/dist/guide-engine.js` in the container). It answers 503 when the bundle
is missing, so it also works as an uptime probe.

**Read the logs.** One JSON line per request; add `| npx pino-pretty` to read them comfortably.
```bash
docker compose logs -f --tail=100 backend
```

**Deploy a new version.** Take a backup first, then pull and restart. The backend migrates the
database by itself.
```bash
docker compose run --rm backup now
docker compose pull backend studio
docker compose up -d --wait
```
To pin an exact build, set `BACKEND_IMAGE` and `STUDIO_IMAGE` in `.env` to
`ghcr.io/mohanvegi4/guide/backend:<sha>` and `…/studio:<sha>`.

**Roll back.** Set the two image variables to the previous SHA and `docker compose up -d --wait`.
Nothing in the database changes; customers' browsers pick up the older agent within five minutes.

**More capacity.** Set `BACKEND_REPLICAS=2` (or more) and `docker compose up -d --wait`. The rate
limiter is shared through Postgres; the app-key cache is per process with a 10 s TTL, which is the
longest a rotated key can linger.

**Let someone into the Keycloak admin console.** Add their network to `ADMIN_ALLOW_CIDRS`, then
`docker compose up -d caddy`.

**Turn guides off.** For one app: its **Guides on/off** switch in the Studio. For everyone: the
switch at the top of the **Administration** page, or as a database operator:
```sql
UPDATE system_config SET value = 'false', updated_at = now() WHERE key = 'guide_engine_enabled';
```

**Customers and their data**

- **A customer needs help:** an owner opens **Members → Guide Engine support access**, then a
  platform admin uses **Open (read-only)** on the Administration page. Every page they open is
  logged for the customer.
- **Abuse or non-payment:** **Suspend** the organization on the Administration page; its apps
  serve nothing until it's lifted.
- **Deletion requests** (GDPR, end of contract): an owner does it from **Members → Danger zone**
  (export first, then delete). When no owner can, a platform admin uses **Delete** on the
  Administration page, logged at `warn`. Studio user accounts are never deleted.
- **One end user's data:** a manager uses **Danger zone → Forget a visitor** in the app's
  settings. To reset only one guide for one visitor, as a database operator:
  ```sql
  DELETE FROM user_guide_state WHERE app_id = '<app>' AND visitor_id = '<visitor>' AND guide_id = '<guide>';
  ```
- **A key leaked somewhere unexpected:** **Rotate public key** in the app's settings, then update
  the snippet. Old snippets stop working.
- **The agent misbehaves on a customer's site:** the app's settings list **Recent agent errors**
  (message, page URL, agent version, time; a 10 % sample, at most 5 per page load and 1000 per app
  per hour). Platform admins see the 24-hour count per app.

**Backend scripts** (in `apps/backend`, after `npm run build`; development only unless noted):

| Command | Purpose |
|---|---|
| `npm run migrate` | Apply pending migrations (any environment). |
| `npm run retention -- --days 400` | Delete events and agent errors older than that now (any environment); the backend also does it daily. |
| `npm run encrypt-secrets` | After turning on `SECRETS_KEY` on an existing database: encrypt the signing secrets stored before it (any environment). |
| `npm run seed` | Dev org + app, `apps/demo/.env.local`, and a Studio token. |
| `npm run mint-token -- --sub <id> [--email <e>] [--name <n>] [--ttl 8h]` | A dev Studio sign-in token. |
| `npm run sign-identity -- --secret <ge_sk_…> --visitor <id> [--account <id>] [--tags a,b]` | Sign a visitor identity, as a customer's server would. |

## Secrets

| Secret | Where | If it leaks or is lost |
|---|---|---|
| Database and Keycloak admin passwords | `.env` | Change in `.env` and in the database or Keycloak, restart |
| `SECRETS_KEY` | `.env` | Every app must generate a new signing secret in the Studio; identities signed with the old one stop verifying. Back it up with `.env`. |
| `PREVIEW_TOKEN_SECRET` | `.env` | Change it and restart; open preview links stop working |
| `METRICS_TOKEN`, `ALERT_WEBHOOK_URL` | `.env` | Change and restart the monitoring profile |
| App public keys and signing secrets | the database, managed in the Studio | Rotate in the app's settings |

Keep `.env` and the backups in your secret store. Without `SECRETS_KEY`, a restored database can't
verify signed identities.

## Backups and restore

The `backup` service (the `postgres:16` image running `deploy/backup.sh`) dumps **both** databases
— `guide_engine` (guides, pages, members, events) and `keycloak` (the users who sign in; either is
useless without the other) — with `pg_dump -Fc` every day at `BACKUP_AT` (03:00 UTC) into
`deploy/backups/<database>-<timestamp>.dump`, and deletes dumps older than `BACKUP_KEEP_DAYS` (14).
Each run logs one line per database (`docker compose logs backup`); a failed dump exits non-zero,
which `docker compose ps` shows as a restart. Deleted customer data lives on in dumps until they
rotate; say so in your privacy notice.

```bash
docker compose run --rm backup now                                     # before a migration or upgrade
./restore.sh guide_engine backups/guide_engine-<stamp>.dump --yes      # or: keycloak
```

- **Off-host copy:** a dead disk takes `backups/` with it. Sync the directory from the host
  (`rclone sync deploy/backups remote:bucket` from cron), or set `BACKUP_COPY_CMD` to a command
  the container runs after every dump with the dump's path as `$1` (the image has no rclone or
  aws, so that means mounting the binary and its config in a compose override).
- **Restore** stops the services that use the database, takes a safety dump
  (`backups/<db>-pre-restore-<stamp>.dump`, so the restore itself can be undone), recreates the
  database, runs `pg_restore` in one transaction, starts the services and prints `/ready`. Without
  `--yes` it only prints that plan. A dump older than the running release is fine: the backend
  migrates it forward.
- **Rehearse it once** on a scratch host: a backup that was never restored is a hope, not a
  backup. A managed Postgres should have point-in-time recovery on instead.

## Observability

**Logs** are JSON lines on stdout (pino), one per request when its response finishes:

```json
{"level":"info","time":"2026-10-19T09:12:44.120Z","service":"guide-engine-backend","requestId":"5f0c…","method":"POST","route":"/v1/embed-agent/:key/guides","status":200,"durationMs":14,"keyPrefix":"ge_pk_3f9a1c2b","msg":"request completed"}
```

`route` is the Express route pattern, never the raw URL; agent requests carry only the start of the
public key. Bodies, headers and tokens are never logged. 4xx errors are logged at `info` (status
and code), 5xx at `error` with the stack. `/health`, `/ready` and `/metrics` are not logged. Each
request gets a **request id**: a well-formed incoming `X-Request-Id` (up to 128 characters of
`A-Z a-z 0-9 . _ : -`) or a new UUID, returned in the response header and on every log line and
Sentry event, so a user's report ("it failed at 09:12, id 5f0c…") leads straight to the cause.

**Metrics** at `GET /metrics` (Prometheus text) need `Authorization: Bearer <METRICS_TOKEN>`.
Without a token configured the endpoint answers 404, except in development and test, where it is
open.

| Metric | Labels | Meaning |
|---|---|---|
| `http_requests_total` | `route`, `method`, `status` | Requests served, by route pattern. |
| `http_request_duration_seconds` | `route`, `method` | Latency histogram (5 ms – 10 s buckets). |
| `agent_requests_total` | `endpoint`, `status` | Agent API calls: `guides`, `help`, `events`, `preview`, `script` (the agent bundle), `other`. |
| `db_pool_total` / `db_pool_idle` / `db_pool_waiting` | — | The Postgres pool: clients open, idle, and callers waiting for one. |
| `retention_deleted_total` | `table` | Rows the retention job deleted (`guide_event`, `agent_rate_limit`). |
| `process_*`, `nodejs_*` | — | The default Node.js metrics. |

Labels come from bounded sets, never an app key, app, organization or guide id. Outside the
`deploy/` stack, scrape through the API host:

```yaml
scrape_configs:
  - job_name: guide-engine-backend     # the name deploy/monitoring/alerts.yml matches on
    scheme: https
    authorization:
      type: Bearer
      credentials: <METRICS_TOKEN>        # or credentials_file
    static_configs:
      - targets: ['api.example.com']
```

**Error tracking** is optional: with `SENTRY_DSN` set, every 5xx goes to Sentry tagged
`request_id`, `route` and `status`, with `environment` from `NODE_ENV` and `release`
`guide-engine-backend@<version>`.

**Health.** `GET /health` is liveness: `{"ok":true}` while the process runs, with no database
call, so a database outage doesn't make an orchestrator restart backends. `GET /ready` is
readiness: `SELECT 1` through the pool, 503 `{"ok":false}` when Postgres doesn't answer within two
seconds. The image's `HEALTHCHECK` uses `/ready`.

**Alerts.** `deploy/monitoring/alerts.yml` is a Prometheus rules file (with `alerts.test.yml`, its
`promtool test rules` suite). Thresholds are starting points; adjust them in the file. Every rule
says what to do.

| Alert | Fires when | Severity |
|---|---|---|
| BackendDown | A replica's scrape fails for 2 minutes | page |
| BackendNotDiscovered | No replica is found for 2 minutes | page |
| HighErrorRate | Over 1% of requests answer 5xx for 5 minutes | page |
| DbPoolSaturated | Requests wait for a database connection for 1 minute | page |
| BackendRestarted | A process restarted in the last hour | warn |
| AgentEndpointFailing | Over 5% of `/guides` or `/events` calls fail for 10 minutes (each is a page that silently showed nothing) | warn |
| AgentGuidesLatencyHigh | `/guides` p95 above 250 ms for 10 minutes | warn |
| AgentRateLimitSaturated | Over 5% of agent calls are rate limited for 10 minutes | warn |
| RetentionNotRunning | Retention deleted nothing for 2 days | warn |

**Prometheus and Alertmanager in the `deploy/` stack** are optional, behind a profile:

```bash
docker compose --profile monitoring up -d       # needs METRICS_TOKEN and ALERT_WEBHOOK_URL in .env
```

Prometheus scrapes every backend replica over the compose network and sends what fires to
Alertmanager, which POSTs it, resolved alerts included, to `ALERT_WEBHOOK_URL`: the "Prometheus"
or "Alertmanager" integration URL of Slack, Teams, PagerDuty, Opsgenie, or anything that accepts
Alertmanager's JSON. The URL reaches Alertmanager as a compose secret file (`url_file`), never
written into `deploy/monitoring/alertmanager.yml`. That file has one route and one receiver, an
email receiver commented out as a model, and a commented sub-route that splits `severity: page`
from `severity: warn`. Both services listen on the host's loopback only: open them over SSH
(`ssh -L 9090:127.0.0.1:9090 -L 9093:127.0.0.1:9093 <host>`, then `http://localhost:9090/alerts`
and `http://localhost:9093` to silence). If you already run Prometheus and Alertmanager, skip the
profile and take the scrape job, `alerts.yml` and the receiver.

---

## Any other platform

Use the two images with these guarantees in place:

- Postgres **15+**, an app role that is `NOSUPERUSER NOBYPASSRLS` and owns the database (the
  backend refuses to start otherwise), automated backups.
- `NODE_ENV=production`, which makes the backend **refuse to start** unless `SECRETS_KEY`,
  `PREVIEW_TOKEN_SECRET`, an `https://` `PUBLIC_API_URL` and `RATE_LIMIT_STORE=postgres` are
  set; `TRUST_PROXY=true` behind a proxy.
- Every migration applied before the backend starts: with `RUN_MIGRATIONS=false` it refuses to
  start while any file in `apps/backend/migrations/` is missing from `schema_migrations`, and
  names them.
- Any OpenID Connect provider for `OIDC_ISSUER` / `OIDC_AUDIENCE` / `OIDC_STUDIO_CLIENT_ID`:
  a public (PKCE) client with `https://<studio>/auth/callback` as redirect URI and
  `https://<studio>/login` for logout, issuing JWT access tokens whose `aud` is
  `OIDC_AUDIENCE`. `docker/keycloak/guide-engine-realm.json` shows the exact Keycloak setup
  (an audience mapper on a client scope).
- The Studio served statically with an SPA fallback, and `/api/*` proxied to the backend with the
  prefix removed (`apps/studio/nginx.conf.template` does both).
- A CDN in front of `/embed-agent/v1/*` is a drop-in (see below).
- The security headers below, if you replace nginx or Caddy.

## Security headers

Each layer sets the headers it is placed to know about:

- **Caddy** (`deploy/Caddyfile`), where TLS ends: `Strict-Transport-Security` (a year, subdomains
  included) on all three hosts, and the one address check: `/admin*` on the Keycloak host (the
  admin console and its REST API) answers 403 unless the client is in `ADMIN_ALLOW_CIDRS`. The
  sign-in pages and the assets they share with the console stay open.
- **nginx** (`apps/studio/nginx.conf.template`), for the Studio: `X-Content-Type-Options`,
  `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, a
  `Permissions-Policy` that turns off camera, microphone and geolocation, and a
  `Content-Security-Policy` that allows only the Studio's own origin plus the identity provider.
  The provider's origin comes from the Studio image's **`OIDC_ORIGIN`** (scheme and host:
  `https://auth.example.com`; `deploy/docker-compose.yml` derives it from `AUTH_HOST`). The
  default is the development Keycloak, `http://localhost:8081`; with the wrong origin SSO fails.
- **Express** (`apps/backend/src/securityHeaders.ts`): `X-Content-Type-Options: nosniff` on
  every response; `X-Frame-Options: DENY`, `Content-Security-Policy: frame-ancestors 'none'`
  and `Referrer-Policy: no-referrer` on the Studio API and other first-party endpoints. The
  **agent surface** (`/embed-agent/v1/*` and `/v1/embed-agent/*`, loaded cross-origin by customers' pages)
  gets nosniff only, and keeps its per-app CORS, `ETag` and `Cache-Control`.

## The agent script: caching and rollbacks

The snippet customers paste loads `https://<api>/embed-agent/v1/<key>/guides.js`. That URL is a
**permanent contract**: it must keep working for every snippet ever pasted, so versioning lives in
the response, not the URL.

- `packages/embed-agent/build.mjs` writes the bundle with a first-line banner,
  `/* guide-engine agent <version> <hash> */` (`<version>` from `packages/embed-agent/package.json`,
  `<hash>` the first 16 hex characters of the SHA-256 of the code that follows). The backend
  recomputes the hash from the file it serves.
- The script is served with a **strong `ETag`** (`"<hash>"`), `If-None-Match` → `304`, and
  `Cache-Control: public, max-age=300, s-maxage=3600, stale-while-revalidate=86400`: browsers
  revalidate after 5 minutes, a CDN keeps it for an hour and may serve the stale copy for a day
  while it refetches, so an origin blip never takes the script off customers' pages. Nothing
  else in the API is cacheable.
- **Deploys and rollbacks** are the same mechanism: a new image serves a file with a different
  hash, and every visitor has it within about 5 minutes (a CDN copy at most an hour later; purge
  `/embed-agent/v1/*` to make it immediate). On the page, `guideEngine.version` says which build a
  customer runs.

---

## Troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| The backend restarts in a loop | `docker compose logs backend`: it refuses to start on a missing secret or unapplied migrations, and says which. |
| `Refusing to start: database role … bypasses Row-Level Security` | `DATABASE_URL` uses a superuser. Use the `guide_engine` role. |
| `OIDC_ISSUER is required outside development` | Production Studio sign-in is OIDC only. Configure your identity provider. |
| The Studio says it can't reach the backend | `docker compose logs backend`; `curl https://API_HOST/ready`. |
| Studio SSO: "The backend rejected your sign-in token" | `OIDC_ISSUER` must equal the token's `iss`, and `OIDC_AUDIENCE` its `aud`. |
| Sign-in fails at Keycloak | `docker compose logs keycloak`; the Studio host in the realm's redirect URIs. |
| `https://AUTH_HOST/admin` answers 403 | Your address isn't in `ADMIN_ALLOW_CIDRS` (empty = nobody). Add it and `docker compose up -d caddy`. |
| Certificates fail | DNS for the three hostnames; ports 80 and 443 open; `docker compose logs caddy`. |
| Disk filling up | `deploy/backups/` (lower `BACKUP_KEEP_DAYS`), `EVENT_RETENTION_DAYS`. |
| `/embed-agent/v1/<key>/guides.js` returns 503 | The agent isn't built. Run `npm run build` (or set `AGENT_BUNDLE_PATH`). |
| Agent requests fail with 403 `origin_not_allowed` | Add the site's origin (scheme + host + port) to the app's **Websites**. |
| Agent requests fail with 401 `signed_identity_required` / `identity_invalid` | The app requires signed identity. Pass a valid, unexpired `jwt` signed with the current secret. |
| `Could not prepare the test database` | Run `npm run db:up`. |
| Studio dev server: `Port 4300 is already in use` | Another `ng serve` is running; stop it. |
| Demo shows "No app key yet" | Run `npm run seed --workspace=apps/backend` and restart the demo dev server. |

**If a guide doesn't appear**, check in order:

1. Is it **published** (Versions shows `live`) **and Enabled**? Is the app switched on? Is a
   version released in the page's environment?
2. Does the **route** match the URL path?
3. Is now inside the start and end dates?
4. Is the visitor's **account** in the audience, and does the visitor carry one of its **tags**,
   if either is set? Tags are exact, case-sensitive strings.
5. Has this visitor already seen, dismissed or completed this version? Publish a newer one, or
   reset their state.
6. Is the element on the page with exactly that `data-guide-id`? A missing one shows up as
   `guide_error` in Analytics after about 16 s.
7. In the browser's Network tab, what did `POST /v1/embed-agent/<key>/guides` return?
