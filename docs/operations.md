---
title: Deploying and operating
nav_order: 4.5
---

# Deploying and operating

The go-live checklist, deploying, day-to-day operations and troubleshooting. For the short
version, see the [DevOps quick guide](devops.md).

## Go-live checklist

What to have in place before real customers depend on a deployment. Each item points at the
section or variable that explains it; the `deploy/` stack is assumed, and
[Any other platform](#any-other-platform) says what replaces it elsewhere.

1. **DNS and certificates.** Three A records at the host: `STUDIO_HOST`, `API_HOST`, `AUTH_HOST`
   in `deploy/.env`, plus `ACME_EMAIL` for Let's Encrypt
   ([Staging or production on one host](#staging-or-production-on-one-host)).
2. **Secrets in `deploy/.env`** (`deploy/.env.example`; never commit it). Required by
   `deploy/docker-compose.yml`: `POSTGRES_SUPERUSER_PASSWORD`, `APP_DB_PASSWORD`,
   `KEYCLOAK_DB_PASSWORD`, `KEYCLOAK_ADMIN_PASSWORD` (with `KEYCLOAK_ADMIN_USER`),
   `PREVIEW_TOKEN_SECRET` and `SECRETS_KEY` (`openssl rand -hex 32` each; losing `SECRETS_KEY`
   invalidates every app's signing secret). Keep `.env` and `SECRETS_KEY` in your secret store,
   not only on the host.
3. **Keycloak.** `deploy/render-realm.sh` before the first `docker compose up` (no dev users,
   brute-force detection on, redirect URIs = `https://STUDIO_HOST`). After the stack is up:
   create the first user in the admin console, create a permanent admin in the **master** realm,
   and put your office / VPN ranges in `ADMIN_ALLOW_CIDRS` — `https://AUTH_HOST/admin` answers
   403 to everyone else, and to everyone while it's empty.
4. **First platform admin.** After that person has signed in once:
   `UPDATE studio_user SET platform_admin = TRUE WHERE email = '…'`
   ([Guide Engine administration](security.md#guide-engine-administration)).
5. **Invitation emails.** `SMTP_URL` and `MAIL_FROM` in `deploy/.env` (compose derives
   `STUDIO_URL` from `STUDIO_HOST`), or accept that invitations are links the inviter copies
   ([Configuration reference](reference.md#configuration-reference)).
6. **Error tracking, metrics and alerts.** `SENTRY_DSN` (optional), `METRICS_TOKEN` and
   `ALERT_WEBHOOK_URL` in `deploy/.env`, then `docker compose --profile monitoring up -d`:
   Prometheus scrapes the backend and Alertmanager posts to the webhook — without the URL, no
   one is paged ([Observability](#observability)).
7. **Backups.** The `backup` service runs by itself; set `BACKUP_COPY_CMD` or a host cron job
   for an off-host copy, check `BACKUP_KEEP_DAYS` against what your privacy policy says, and
   rehearse `deploy/restore.sh` once on a scratch host
   ([Backups and restore](#backups-and-restore)).
8. **Event retention.** `EVENT_RETENTION_DAYS` (default 400 in production; `0` is off). Write
   the number you chose into the privacy policy and the DPA ([Operations](#operations)).
9. **The agent script.** The snippet URL `https://API_HOST/agent/v1/<key>/guides.js` is a
   permanent contract. A CDN in front of `/agent/v1/*` is optional and drop-in; purge it on a
   rollback. After each deploy: `curl https://API_HOST/agent/v1/version` matches the image's
   banner ([caching and rollbacks](#the-agent-script-caching-and-rollbacks)).
10. **Security headers.** Nothing to do inside the compose stack. A Studio image run elsewhere
    needs `OIDC_ORIGIN` = the identity provider's origin, or SSO fails the CSP; a replaced
    Caddy/nginx must set HSTS and the Studio headers itself
    ([Security headers](#security-headers)).
11. **Smoke test the deployed stack** (`e2e/`, Playwright, Chromium). It needs a Keycloak user
    in the `guide-engine` realm it can sign in as (a dedicated one is simplest; a user who
    already owns an organization works too), and it **creates and deletes an organization**
    `E2E <timestamp>` through the Studio, which platform admins see on the Administration page
    while it exists. `STUDIO_URL=https://STUDIO_HOST API_URL=https://API_HOST KEYCLOAK_USER=…
    KEYCLOAK_PASSWORD=… npm run e2e` (`e2e/playwright.config.ts`, `e2e/tests/smoke.spec.ts`;
    `SITE_ORIGIN` defaults to `http://e2e.localhost`, a page the test serves itself).
12. **Legal templates.** `docs/legal/`: replace `{{COMPANY}}`, `{{CONTACT_EMAIL}}`,
    `{{JURISDICTION}}` and every `[date]` / `[…]` placeholder in `terms.md`, `privacy.md`,
    `dpa.md` and `subprocessors.md` (the retention and backup numbers above go in there), and
    have counsel review them before publishing.
13. **Per customer (each app in the Studio).** The **Websites** list contains the real site
    origins (scheme + host + port; nothing loads elsewhere). For production customers:
    generate the **signing secret** and switch on **Require signed identity**
    ([Require signed identity](install.md#3-recommended-require-signed-identity)).

---

## Deploying

Everything needed to run Guide Engine for real is in the repo:

- **CI** (`.github/workflows/ci.yml`): on every push and pull request, installs, builds every
  package, migrates a throwaway Postgres, runs all four test suites, runs the browser smoke test
  against Keycloak, the backend and the Studio (job `e2e`), and builds both images.
  On `main` the images are pushed to GitHub Container Registry as
  `ghcr.io/<owner>/<repo>/backend` and `/studio`, tagged with the commit and `latest`.
- **Images:** `apps/backend/Dockerfile` (the API plus the agent script; runs pending
  migrations at start unless `RUN_MIGRATIONS=false`) and `apps/studio/Dockerfile` (the Angular
  build behind nginx, which also proxies `/api/*` to `BACKEND_URL`).
- **`deploy/`:** a single-host staging/production stack — Postgres, **Keycloak**, the backend,
  the Studio and Caddy (automatic HTTPS) — on three hostnames.

### Staging or production on one host

1. Point three DNS names at the host: the Studio, the API, and Keycloak (for example
   `studio.`, `api.` and `auth.example.com`).
2. `cd deploy && cp .env.example .env` and fill it in: the hostnames, Postgres passwords, the
   Keycloak admin password, `ADMIN_ALLOW_CIDRS` (the networks that may open the Keycloak admin
   console: office, VPN or bastion CIDRs, space-separated; empty means nobody, see step 5), and
   two secrets from `openssl rand -hex 32` (`PREVIEW_TOKEN_SECRET`, `SECRETS_KEY`).
3. `./render-realm.sh` (needs `jq`) writes `keycloak-import/guide-engine-realm.json` from the
   development realm, made safe for a real deployment: **no users** (the development realm's
   `vegim` / `editor` / `root` are stripped), brute-force detection on (temporary lockouts:
   5 failures lock a user for 1 min, growing to 15 min), and the Studio client's redirect
   URIs and web origins set to exactly `https://STUDIO_HOST`. It prints what it changed and
   the token/session lifetimes it kept (15 min access tokens, 8 h idle / 10 h max sessions).
   Keycloak imports the file on its first start only; later changes are made in the admin
   console.
4. `docker compose up -d --wait`. Postgres creates the two application roles on first start
   (`init.sh`); Keycloak imports the realm; the backend migrates; Caddy fetches certificates;
   the `backup` service starts its daily dumps into `./backups`
   ([Backups and restore](#backups-and-restore)).
5. **Create the first user.** Nobody can sign in yet: the realm has no users and
   self-registration is off. Open the Keycloak admin console at `https://AUTH_HOST/admin`
   with `KEYCLOAK_ADMIN_USER` / `KEYCLOAK_ADMIN_PASSWORD` from `.env`. Caddy serves `/admin*`
   only to the addresses in `ADMIN_ALLOW_CIDRS` and answers 403 to everyone else, you included
   while the variable is empty: put the network you are on in it (`203.0.113.0/24`, or your
   current address as a `/32` for a one-off), then `docker compose up -d caddy` to apply it.
   Caddy reads the list when its container starts, and recreating it costs the three hosts a
   few seconds. There is no back door, by design: an SSH tunnel to the host reaches Caddy from
   the host's own address, not yours, and Keycloak serves the console on `AUTH_HOST` only, so
   the allowlist is the one way in. Once in, switch to the
   **guide-engine** realm, and under **Users → Add user** enter the person's username and
   email, tick **Email verified**, create the user, then set a password on its
   **Credentials** tab. (Keycloak 26 treats that bootstrap admin as temporary and says so in
   the console: create a permanent admin in the **master** realm while you are there, and turn
   on that realm's **Realm settings → Security defenses → Brute force detection**:
   `render-realm.sh` enables it for the guide-engine realm, but the master realm, where the
   admin account lives, ships with it off.)
   Repeat for each further person, or set up an identity provider under **Identity providers**
   so they sign in with their company account.
6. The person signs in to the Studio with that user. The Studio's **Welcome** page creates
   their organization (and its first application); they invite colleagues from **Members**.
7. **The first platform admin.** To administer Guide Engine itself (all organizations, the kill
   switch, support access), set the flag by SQL on a user who has signed in once:
   `UPDATE studio_user SET platform_admin = TRUE WHERE email = '…'`, as described in
   [Guide Engine administration](security.md#guide-engine-administration). From then on platform admins
   are managed on the Studio's **Administration** page.

More than one backend replica: set `BACKEND_REPLICAS`. The rate limiter is already shared
through Postgres (`RATE_LIMIT_STORE=postgres`); the app-key cache is per process with a 10 s
TTL, which is the most a rotated key can linger.

Monitoring is optional: set `METRICS_TOKEN` and `ALERT_WEBHOOK_URL`, and
`docker compose --profile monitoring up -d` adds Prometheus and Alertmanager with the alert
rules in `deploy/monitoring/` ([Observability](#observability)).

### Any other platform

Use the two images with these guarantees in place:

- Postgres **15+**, an app role that is `NOSUPERUSER NOBYPASSRLS` and owns the database (the
  backend refuses to start otherwise), automated backups.
- `NODE_ENV=production`, which makes the backend **refuse to start** unless `SECRETS_KEY`,
  `PREVIEW_TOKEN_SECRET`, an `https://` `PUBLIC_API_URL` and `RATE_LIMIT_STORE=postgres` are
  set; `TRUST_PROXY=true` behind a proxy.
- Every migration applied before the backend starts: with `RUN_MIGRATIONS=false` it refuses to
  start (in production) while any file in `apps/backend/migrations/` is missing from
  `schema_migrations`, and names them.
- Any OpenID Connect provider for `OIDC_ISSUER` / `OIDC_AUDIENCE` / `OIDC_STUDIO_CLIENT_ID`:
  a public (PKCE) client with `https://<studio>/auth/callback` as redirect URI and
  `https://<studio>/login` for logout, issuing JWT access tokens whose `aud` is
  `OIDC_AUDIENCE`. `docker/keycloak/guide-engine-realm.json` shows the exact Keycloak setup
  (an audience mapper on a client scope).
- Serve the Studio statically with an SPA fallback and proxy `/api/*` to the backend with the
  prefix removed (`apps/studio/nginx.conf.template` does both).
- A CDN in front of `/agent/v1/*` is a drop-in (next section).
- Set the security headers below yourself if you replace nginx or Caddy.

### Security headers

Each layer sets the headers it is placed to know about:

- **Caddy** (`deploy/Caddyfile`), where TLS ends: `Strict-Transport-Security` (a year, subdomains
  included) on all three hosts. It is also the one place with an address check: `/admin*` on the
  Keycloak host (the admin console and its REST API, guarded by the admin password alone)
  answers 403 unless the client address is in `ADMIN_ALLOW_CIDRS`; empty means nobody
  ([Staging or production on one host](#staging-or-production-on-one-host), step 5). The
  sign-in pages and the assets they share with the console stay open. Everything else passes
  through from the services.
- **nginx** (`apps/studio/nginx.conf.template`), for the Studio: `X-Content-Type-Options`,
  `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, a
  `Permissions-Policy` that turns off camera, microphone and geolocation, and a
  `Content-Security-Policy` that allows only the Studio's own origin plus the identity provider
  (for the PKCE token exchange and the sign-in redirect). The provider's origin comes from the
  **`OIDC_ORIGIN`** environment variable of the Studio image (scheme and host, no path:
  `https://auth.example.com`; `deploy/docker-compose.yml` derives it from `AUTH_HOST`). The
  image's default is the development Keycloak, `http://localhost:8081`; with the wrong origin
  SSO simply fails to sign in. `ng serve` is not affected: the headers live in nginx.
- **Express** (`apps/backend/src/securityHeaders.ts`): `X-Content-Type-Options: nosniff` on
  every response; `X-Frame-Options: DENY`, `Content-Security-Policy: frame-ancestors 'none'`
  and `Referrer-Policy: no-referrer` on the Studio API and the other first-party endpoints. The
  **agent surface** — `/agent/v1/*` and `/v1/agent/*`, which customers' pages load and call
  cross-origin — gets nosniff only, and keeps its per-app CORS, `ETag` and `Cache-Control`.

### The agent script: caching and rollbacks

The snippet customers paste loads `https://<api>/agent/v1/<key>/guides.js`. That URL is a
**permanent contract**: it must keep working for every snippet ever pasted, so versioning lives
in the response, not the URL.

- `packages/agent/build.mjs` writes the bundle with a first-line banner,
  `/* guide-engine agent <version> <hash> */` (`<version>` from `packages/agent/package.json`,
  `<hash>` the first 16 hex chars of the sha256 of the code that follows). The backend reads the
  version from the banner and recomputes the hash from the file it serves.
- The script is served with a **strong `ETag`** (`"<hash>"`), `If-None-Match` → `304`, and
  `Cache-Control: public, max-age=300, s-maxage=3600, stale-while-revalidate=86400`: browsers
  revalidate after 5 minutes, a CDN keeps it for an hour and may serve the stale copy for a day
  while it refetches in the background, so an origin blip never takes the script off customers'
  pages. Put a CDN in front of `/agent/v1/*` as is; nothing else in the API is cacheable.
- **Deploys and rollbacks** are the same mechanism: a new image serves a file with a different
  hash, revalidations return it, and every visitor has it within about 5 minutes (a CDN's
  cached copy at most an hour later — purge `/agent/v1/*` to make it immediate). Rolling back
  means redeploying the previous image; nothing in the database changes.
- `GET /agent/v1/version` → `{ version, hash }` (no key, never cached) is the deploy check: it
  must match the banner of the image you shipped (`head -1 packages/agent/dist/guide-engine.js`
  in the container), and it makes a fine uptime probe. On the page, `guideEngine.version` says
  which build a customer is running.

### Keycloak in development

`npm run idp:up` starts the same Keycloak (`:8081`, admin console `admin` / `admin`) with the
realm imported, so development, staging and production all authenticate the same way. Set
`OIDC_ISSUER=http://localhost:8081/realms/guide-engine` in `apps/backend/.env`, restart the
backend, and sign in as `vegim` / `vegim` (see [Studio login details](../README.md#studio-login-details)).

---

## Operations

- **Turn an app off:** use the **Guides on/off** switch in that app's settings.
- **Turn guides off everywhere** (global kill switch): the switch at the top of the Studio's
  **Administration** page (platform admins), or as a database operator:
  ```sql
  UPDATE system_config SET value = 'false', updated_at = now() WHERE key = 'guide_engine_enabled';
  ```
- **A customer needs help:** ask an owner to open **Members → Guide Engine support access**, then
  use **Open (read-only)** on the Administration page. They see every page you open.
- **Abuse or non-payment:** **Suspend** the organization on the Administration page; its apps
  serve nothing until lifted.
- **Deletion requests** (GDPR, end of contract): an owner does it themselves from **Members →
  Danger zone** (export first, then delete by typing the organization's name). When no owner
  can, a platform admin uses **Delete** on the Administration page, with the same confirmation;
  the backend logs it at `warn` with the organization and admin ids. Studio user accounts are
  never deleted. For a request about one end user (visitor), query `guide_event` and
  `user_guide_state` by `visitor_id` / `account_id` as a database operator: the export never
  contains them.
- **A key leaked somewhere unexpected:** **Rotate public key** in the app's settings, then
  update the snippet.
- **Is the right build live?** `curl https://<api>/agent/v1/version` gives `{ version, hash }`;
  compare with the banner of the image's `packages/agent/dist/guide-engine.js`. It answers
  `503` when the bundle is missing, so it doubles as an uptime check. To roll back, redeploy the
  previous image (see [caching and rollbacks](#the-agent-script-caching-and-rollbacks)).
- **The agent misbehaves on a customer's site:** open the app's settings, **Recent agent
  errors**: message, page URL, agent version and time of the exceptions the script caught
  (a 10 % sample, at most 5 per page load, at most 1000 per app per hour). Platform admins see
  the 24-hour count per app in `GET /v1/platform/orgs/:orgId`.
- **Event retention:** the backend deletes events and agent errors older than
  `EVENT_RETENTION_DAYS` once a day (and sweeps spent rate-limit windows). To run it now:
  `npm run retention --workspace=apps/backend -- --days 400`.
- **Turning on `SECRETS_KEY` on an existing database:** set it, restart, then run
  `npm run encrypt-secrets --workspace=apps/backend` once. Losing the key means every app
  must generate a new signing secret (visitor identities signed with the old one stop verifying).
- **Backups:** see [Backups and restore](#backups-and-restore) below.
- **Reset a visitor's dismissal**, as a database operator:
  ```sql
  DELETE FROM user_guide_state WHERE app_id = '<app>' AND visitor_id = '<visitor>' AND guide_id = '<guide>';
  ```
- **Scripts** (in `apps/backend`, after `npm run build`; development only unless noted):

  | Command | Purpose |
  |---|---|
  | `npm run migrate` | Apply pending migrations (any environment). |
  | `npm run seed` | Dev org + app, `apps/demo/.env.local`, and a Studio token. |
  | `npm run mint-token -- --sub <id> [--email <e>] [--name <n>] [--ttl 8h]` | A dev Studio sign-in token. |
  | `npm run sign-identity -- --secret <ge_sk_…> --visitor <id> [--account <id>] [--tags a,b]` | Sign a visitor identity, as a customer's server would. |

### Backups and restore

The `backup` service in `deploy/` (the same `postgres:16` image, running `deploy/backup.sh`)
dumps **both** databases — `guide_engine` (guides, pages, members, events) and `keycloak` (the
users and realm that sign them in; either one is useless without the other) — with `pg_dump -Fc`
every day at `BACKUP_AT` (03:00 UTC) into `deploy/backups/`, named `<database>-<timestamp>.dump`,
and deletes dumps older than `BACKUP_KEEP_DAYS` (14). Each run logs one line per database
(`docker compose logs backup`); a failed dump exits the container non-zero, which
`docker compose ps` shows as a restart. Deleted customer data lives on in dumps until they
rotate; say so in your privacy notice (`docs/legal/`).

- **Take one now**, before a migration or an upgrade: `docker compose run --rm backup now`.
- **Off-host copy:** a disk that dies takes `backups/` with it. Either sync the directory from the
  host (`rclone sync deploy/backups remote:bucket` from cron), or set `BACKUP_COPY_CMD` to a
  command the container runs after every dump with the dump's path as `$1`. The image carries no
  rclone or aws, so that route means mounting the binary and its config in a compose override.
- **Restore:** `./restore.sh guide_engine backups/guide_engine-<stamp>.dump --yes` (or
  `keycloak`). It stops the backend and the Studio (Keycloak too for its database), dumps the
  current state to `backups/<db>-pre-restore-<stamp>.dump` so the restore itself can be undone,
  drops and recreates the database, runs `pg_restore` in one transaction, starts the services and
  prints the backend's `/ready`. Without `--yes` it only prints that plan. A dump older than the
  running release is fine: the backend migrates it forward at start.
- **Rehearse it once** on a scratch host (`docker compose up` with a copy of `.env`, then
  `restore.sh` with one dump): a backup that was never restored is a hope, not a backup. A managed
  Postgres elsewhere should have point-in-time recovery on instead.

### Observability

**Logs** are JSON lines on stdout (pino), one object per event, so any log shipper can index
them without parsing text. In a terminal, `npm run dev:backend | npx pino-pretty` is easier on
the eyes. Every request produces one line when its response finishes:

```json
{"level":"info","time":"2026-10-19T09:12:44.120Z","service":"guide-engine-backend","requestId":"5f0c…","method":"POST","route":"/v1/agent/:key/guides","status":200,"durationMs":14,"keyPrefix":"ge_pk_3f9a1c2b","msg":"request completed"}
```

`route` is the Express route pattern, never the raw URL, and agent requests carry only the first
characters of the public key. Bodies, headers and tokens are never logged. Errors the handler
turns into a 4xx are logged at `info` (status and code, no stack); 5xx responses are logged at
`error` with the stack and reported to Sentry when configured. `/health`, `/ready` and
`/metrics` are not logged.

Each request gets a **request id**: an incoming `X-Request-Id` header is honoured (up to 128
characters of `A-Z a-z 0-9 . _ : -`), otherwise a UUID is generated. It is returned in the
`X-Request-Id` response header and appears on every log line and Sentry event for that request,
so a user's report ("it failed at 09:12, id 5f0c…") leads straight to the cause.

**Metrics** are served at `GET /metrics` in Prometheus text format, when `METRICS_TOKEN` is set
and the request carries `Authorization: Bearer <METRICS_TOKEN>` (in development and test the
endpoint is open when the token is unset; elsewhere it answers 404 until one is configured):

| Metric | Labels | Meaning |
|---|---|---|
| `http_requests_total` | `route`, `method`, `status` | Requests served, by route pattern. |
| `http_request_duration_seconds` | `route`, `method` | Latency histogram (5 ms – 10 s buckets). |
| `agent_requests_total` | `endpoint`, `status` | Public agent API calls: `guides`, `help`, `events`, `preview`, `script` (the agent bundle), `other`. |
| `db_pool_total` / `db_pool_idle` / `db_pool_waiting` | — | The Postgres pool: clients open, idle, and callers waiting for one. |
| `retention_deleted_total` | `table` | Rows the retention job deleted (`guide_event`, `agent_rate_limit`). |
| `process_*`, `nodejs_*` | — | The default Node.js metrics (CPU, memory, event-loop lag, GC, handles). |

Labels come from bounded sets (route patterns, endpoint names, tables): never an app key, an
app, an organization or a guide id. A Prometheus job for it, scraping through the public API
host (inside the `deploy/` stack, `deploy/monitoring/prometheus.yml` does the same over the
compose network):

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

**Error tracking** is optional: set `SENTRY_DSN` and every 5xx the error handler produces is
sent to Sentry, tagged `request_id`, `route` and `status`, with `environment` from `NODE_ENV`
and `release` as `guide-engine-backend@<version>`. Nothing is loaded or sent while it is unset.

**Health:** `GET /health` is liveness: `{"ok":true}` as long as the process runs, with no
database call, so a database outage doesn't make an orchestrator restart backends (which would
not help). `GET /ready` is readiness: it runs `SELECT 1` through the pool and answers 503
`{"ok":false}` when Postgres is unreachable or doesn't respond within two seconds, which takes
the instance out of rotation. The container image's `HEALTHCHECK` (and so `deploy/`'s compose
stack) uses `/ready`.

**Alerting:** the rules are shipped, not described: `deploy/monitoring/alerts.yml` is a
Prometheus rules file (with `alerts.test.yml`, its `promtool test rules` suite). It pages on a
backend that is down or restarting into failure, a 5xx rate above 1 %, and a saturated Postgres
pool; it warns on agent calls failing on `guides`/`events` (each one is a page that silently
showed nothing, since the agent fails closed), p95 latency above 250 ms on the guides route, a
retention job that has deleted nothing for two days, and rate limiting biting more than 5 % of
agent traffic. Every description says what to do and points back here. Thresholds are starting
points: adjust them in the file.

**Prometheus and Alertmanager in the `deploy/` stack:** optional, behind a compose profile. Set
`METRICS_TOKEN` and `ALERT_WEBHOOK_URL` in `.env`, then `docker compose --profile monitoring up -d`.
Prometheus scrapes every backend replica over the compose network (`backend:3000`), evaluates
the rules and sends what fires to Alertmanager, which POSTs it, resolved alerts included, to
`ALERT_WEBHOOK_URL`: the "Prometheus" or "Alertmanager" integration URL of Slack, Teams,
PagerDuty, Opsgenie, or anything that accepts Alertmanager's JSON. Alertmanager expands no
environment variables, so the URL (which usually embeds a token) reaches it as a compose secret
file (`url_file`) and is never written into `deploy/monitoring/alertmanager.yml`. That file is
one route and one receiver, with an email receiver left commented out as a model. Every rule
carries `severity: page` or `severity: warn`, so the route can split on it, pager for one and a
channel for the other; a commented sub-route shows how. Both services listen on the host's
loopback only, `127.0.0.1:9090` and `127.0.0.1:9093`: open them over an SSH tunnel
(`ssh -L 9090:127.0.0.1:9090 -L 9093:127.0.0.1:9093 <host>`, then `http://localhost:9090/alerts`
for what is firing and `http://localhost:9093` to silence it). If you already run Prometheus and
Alertmanager, skip the profile and take the files: the scrape job in `prometheus.yml`,
`alerts.yml` (which only assumes the job is named `guide-engine-backend`) and the receiver in
`alertmanager.yml`.

---

## Troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| `Refusing to start: database role … bypasses Row-Level Security` | `DATABASE_URL` uses a superuser. Use the `guide_engine` role. |
| `OIDC_ISSUER is required outside development` | Production Studio sign-in is OIDC only. Configure your identity provider. |
| `Could not prepare the test database` | Run `npm run db:up`. |
| `/agent/v1/<key>/guides.js` returns 503 | The agent isn't built. Run `npm run build` (or set `AGENT_BUNDLE_PATH`). |
| Agent requests fail with 403 `origin_not_allowed` | Add the site's origin (scheme + host + port) to the app's **Websites**. |
| Agent requests fail with 401 `signed_identity_required` / `identity_invalid` | The app requires signed identity. Pass a valid, unexpired `jwt` signed with the current secret. |
| Studio: `Port 4200 is already in use` | Use `-- --port 4300`. |
| Studio SSO: "The backend rejected your sign-in token" | `OIDC_ISSUER` must equal the token's `iss`, and `OIDC_AUDIENCE` its `aud`. |
| `https://AUTH_HOST/admin` answers 403 (deploy stack) | Your address isn't in `ADMIN_ALLOW_CIDRS` in `deploy/.env` (empty = nobody). Add it and `docker compose up -d caddy`. |
| Demo shows "No app key yet" | Run `npm run seed --workspace=apps/backend` and restart the demo dev server. |

**If a guide doesn't appear**, check in order:

1. Is it **published** (Versions shows `live`) **and Enabled**? Is the app switched on?
2. Does the **route** match the URL path?
3. Is now inside the start and end dates?
4. Is the visitor's **account** in the audience, and does the visitor carry one of its **tags**,
   if either is set? Tags are exact, case-sensitive strings.
5. Has this visitor already seen, dismissed or completed this version? Publish a newer one, or reset
   their state.
6. Is the element on the page with exactly that `data-guide-id`? A missing one shows up as
   `guide_error` in Analytics after about 16 s.
7. In the browser's Network tab, what did `POST /v1/agent/<key>/guides` return?
