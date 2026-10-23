---
title: How Guide Engine is built
nav_order: 4
---

# How Guide Engine is built

This guide explains, part by part, how Guide Engine works inside: what runs where, what each piece
stores, how a request is authorized, and how a guide gets from the Studio onto a visitor's screen.
It is written for engineers who will run, extend or review the system, and it describes the code
as it is on `main` (version 0.3.0, migrations 001 to 020). Where the code and the intent differ, the
guide says so in [Known gaps and quirks](#16-known-gaps-and-quirks).

For *using* the product, read the [Guide Engine reference](../README.md) and the
[Studio reference](../apps/studio/README.md). This page is about the machinery.

## Contents

1. [The big picture](#1-the-big-picture)
2. [The life of a guide, end to end](#2-the-life-of-a-guide-end-to-end)
3. [Repository, packages and build](#3-repository-packages-and-build)
4. [The backend process](#4-the-backend-process)
5. [The database](#5-the-database)
6. [Isolation: row-level security and session variables](#6-isolation-row-level-security-and-session-variables)
7. [Studio sign-in and authorization](#7-studio-sign-in-and-authorization)
8. [The agent API](#8-the-agent-api)
9. [Visitors, accounts and audience targeting](#9-visitors-accounts-and-audience-targeting)
10. [In the browser: agent, engine, renderer, help widget](#10-in-the-browser-agent-engine-renderer-help-widget)
11. [Authoring: guides, versions, pages and preview](#11-authoring-guides-versions-pages-and-preview)
12. [The Studio application](#12-the-studio-application)
13. [Analytics and the data lifecycle](#13-analytics-and-the-data-lifecycle)
14. [Deployment and operations](#14-deployment-and-operations)
15. [CI, releases and the docs site](#15-ci-releases-and-the-docs-site)
16. [Known gaps and quirks](#16-known-gaps-and-quirks)
17. [Where to look in the code](#17-where-to-look-in-the-code)

---

## 1. The big picture

Guide Engine has three surfaces and one store.

```
 Customer's website (any framework)               Guide Engine service
┌──────────────────────────────────────┐         ┌────────────────────────────────────────┐
│ <script> install snippet (app key)   │  GET    │ Backend (Node, Express)                │
│   └─ loads guides.js (the agent) ────┼────────▶│  /agent/v1/<key>/guides.js  (script)   │
│ agent = core engine + renderer       │  POST   │  /v1/agent/<key>/guides|help|events|…  │
│   + help widget, in Shadow DOM ──────┼────────▶│        public, per-app CORS            │
│ elements tagged data-guide-id="…"    │         │                                        │
└──────────────────────────────────────┘         │  /v1/…  Studio API (OIDC bearer token) │
                                                 │                                        │
 Guide Studio (Angular SPA, nginx)               │            ▼  every query in a         │
┌──────────────────────────────────────┐  /api/* │    transaction with session variables  │
│ authors, managers, platform admins   ├────────▶│                                        │
│ signs in through Keycloak (PKCE)     │ proxied │ Postgres 16  (FORCE row-level security)│
└──────────────────────────────────────┘         └────────────────────────────────────────┘
                     │ OIDC                                       ▲ JWKS
                     ▼                                            │
               Keycloak (identity only, its own database) ────────┘
```

- **The agent** is one JavaScript file, served by the backend, that every customer page loads
  through the install snippet. It contains the whole browser engine. It knows the app's public key
  and the visitor's ids, asks the backend which guides apply, matches them to the current URL,
  draws them, and sends back what the visitor did.
- **The Studio** is where people author guides, manage apps, members and settings, and read
  analytics. It is a static Angular app; every call goes to its own origin under `/api`, which
  nginx forwards to the backend.
- **The backend** serves both. It has two separate APIs: the public **agent API**, keyed by an
  app's public key, and the **Studio API**, which needs a signed-in Studio user.
- **Postgres** is the only store: guides, versions, events, visitor state, members, rate-limit
  counters, error reports. There is no cache server, no queue and no analytics warehouse.
- **Keycloak** proves who a Studio user is, and nothing else. Organizations, memberships and roles
  live in Guide Engine's own database. In production Keycloak keeps its users in its own
  `keycloak` database, separate from the `guide_engine` database and owned by a separate role.

Three ideas run through everything below:

1. **Isolation is enforced twice.** Every handler filters by app or organization, and Postgres
   row-level security (RLS) independently refuses rows outside the caller's scope. The scope comes
   only from verified credentials, never from ids in the request.
2. **Fail closed, fail silent.** In the browser, anything that can't be verified shows nothing and
   never throws into the host page. On the server, unknown and forbidden look the same (404).
3. **The app key is public.** It identifies an app; it authenticates nobody. When visitor identity
   matters, the customer's backend signs it (see [section 9](#9-visitors-accounts-and-audience-targeting)).

### Vocabulary

| Term | Meaning |
|---|---|
| Organization | A customer of Guide Engine. Owns applications and has members. |
| Application (app) | One website or product. Has a public key, a websites list, settings, guides and pages. |
| Studio user | A person who signs in to the Studio (`studio_user`), identified by OIDC issuer + subject. |
| Member | A Studio user's membership in an organization, with one role: owner, manager, editor or viewer. |
| Visitor | An end user of the customer's website, identified by a string the host page passes in. |
| Account | The visitor's company, customer or library: an optional string used for targeting and analytics. |
| Guide | A named item (tooltip, modal, banner, tour, …) belonging to one app. |
| Version | An immutable published snapshot of a guide's steps, route, audience and help listing. |
| Draft | The single unpublished version of a guide, edited in place. |
| Saved page | A named URL rule per app that guides can point at instead of a raw route. |
| Platform admin | An operator of the Guide Engine service itself, above all organizations. |

---

## 2. The life of a guide, end to end

Following one guide through the system touches almost every component, so it is the quickest way
to see how the parts fit.

**1. An author signs in.** The Studio fetches `/api/auth/config`, learns the Keycloak issuer and
client id, and redirects to Keycloak with PKCE. Keycloak redirects back with a code; the Studio
exchanges it for an access token and sends it as `Authorization: Bearer …` on every API call.
The backend verifies the token against Keycloak's public keys, finds or creates the `studio_user`
row, loads the user's memberships, and runs the request inside a transaction whose session
variables list exactly the organizations and apps that user may touch.

**2. The author creates the guide and saves a draft.** `POST /v1/apps/:appId/guides` creates a
`guide` row (status `draft`, disabled). `PUT …/:id/draft` validates the body (steps, route or saved
page, dates, account allowlist, help listing, activation), sanitizes every bit of HTML, and writes
the single draft `guide_version` row.

**3. The author previews it.** `POST …/:id/preview-token` signs a 15-minute token bound to that
app, guide and version. The Studio opens the customer's site with `?guidePreview=<token>`. The
agent sees the parameter, sends the token to `/v1/agent/<key>/preview`, and shows exactly that
version to that browser only, recording nothing.

**4. The author publishes and enables it.** Publishing stamps `published_at` on the draft, which
makes the row immutable in the database, and points `guide.current_version_id` at it. Enabling
flips `guide.enabled`. From now on the `active_guide` view includes it.

**5. A visitor loads a page.** The snippet defines a tiny `window.guideEngine` queue, injects
`guides.js`, and queues `initialize({ visitor, account })`. The agent loads, finds its own script
tag to learn the API host and app key, replays the queue, and calls `POST /v1/agent/<key>/guides`.

**6. The backend decides what this visitor may get.** It checks the app key, the page's Origin
against the app's websites, and the rate limit. It checks the kill switches. Then one query returns
every guide that is published, enabled, inside its date window, automatic, open to this account,
and not yet seen by this visitor at this version.

**7. The agent decides what to show now.** It matches each guide's route against the current
path, puts walkthroughs before single tips, and starts the first one. It finds the step's element
by `[data-guide-id="…"]`, waits for it if needed, scrolls it into view, draws a spotlight and a
card in a Shadow DOM, and records `guide_shown`.

**8. The visitor clicks through.** Each step records `guide_step_viewed` and
`guide_step_completed`; the end records `guide_completed`, a close records `guide_dismissed`.
Events go out in batches. The backend stores them and updates the visitor's state for that guide,
so the guide does not show again until a newer version is published.

**9. The author reads the results.** The Studio's analytics run aggregate queries over
`guide_event`: shown, completed, dismissed, per step, per account, and help-center searches.

**10. Time passes.** A daily job deletes events older than the retention period (400 days by
default in production). A manager can export or forget one visitor's data. An owner can export or
delete the whole organization.

---

## 3. Repository, packages and build

```
packages/
  core/              the engine, DOM renderer and help widget (framework-agnostic TypeScript)
  agent/             the install-snippet agent: core bundled into one IIFE file
  backend/           Express + Postgres: Studio API, agent API, migrations, operator scripts
  angular-wrapper/   @guide-engine/angular: optional npm alternative to the snippet
  vue-wrapper/       @guide-engine/vue: optional npm alternative to the snippet
apps/
  studio/            the authoring Studio (Angular 21, zoneless)
  demo/              a plain Vite page that installs Guide Engine through the snippet
e2e/                 Playwright smoke test against a running stack
deploy/              single-host production stack (compose, Caddy, backups, monitoring)
docker/              development Postgres init and the development Keycloak realm
docs/                this site
```

It is an npm workspaces monorepo. `npm run build` builds `packages/core` first, then every
workspace. TypeScript runs in strict mode everywhere from `tsconfig.base.json` (ES2020, CommonJS).

**How core is consumed.** The agent and the wrappers take core in different ways, which matters
when you change core:

| Consumer | How it gets core |
|---|---|
| Agent typecheck and tests | TypeScript `paths` and a vitest alias to `packages/core/src` |
| Agent bundle | esbuild `alias` to `packages/core/src`; core is inlined into the IIFE |
| Angular and Vue wrappers | the workspace symlink to `packages/core/dist` (CommonJS), so core must be built first |
| Demo | nothing; it uses the snippet only |

**The agent bundle.** `packages/agent/build.mjs` runs esbuild with `bundle`, `minify`,
`format: iife`, `target: es2018`, no sourcemap, and defines `__GUIDE_ENGINE_VERSION__` from
`package.json`. It writes `packages/agent/dist/guide-engine.js` with a first-line banner:

```
/* guide-engine agent 0.3.0 5d901a3d386fd80e */
```

The second value is the first 16 hex characters of a SHA-256 of the code after the banner. The
backend recomputes it from the bytes it serves and uses it as the ETag. The bundle is about 30 KB,
about 10 KB gzipped. It is a build artefact and is not committed; the backend image builds it.

**Versions.** The three public packages (`core`, `angular`, `vue`) share one version, set with
`npm run version:set X.Y.Z`, which also stamps the private agent. Releases are git tags `vX.Y.Z`
(see [section 15](#15-ci-releases-and-the-docs-site)).

**Tests.**

| Package | Runner | Tests |
|---|---|---|
| backend | vitest against a real Postgres (`guide_engine_test`) | 258 |
| core | vitest + jsdom | 102 |
| agent | vitest + jsdom | 8 |
| studio | Angular unit-test builder (vitest) | 45 |
| e2e | Playwright, Chromium, against Keycloak + backend + Studio | 1 end-to-end flow |

The wrappers and the demo have no tests.

---

## 4. The backend process

Source: [`packages/backend/src`](../packages/backend/src).

### 4.1 Boot sequence

[`index.ts`](../packages/backend/src/index.ts) does this, in order. Any failure logs a fatal line
and exits with code 1, so a misconfigured process never serves traffic.

1. Load `.env` (`dotenv`). Importing modules creates the `pg` pool from `DATABASE_URL`, the
   Prometheus registry and the root logger.
2. **`assertProductionConfig()`** ([`production.ts`](../packages/backend/src/production.ts)). Only
   when `NODE_ENV=production`. It collects every problem and refuses to start if `SECRETS_KEY` or
   `PREVIEW_TOKEN_SECRET` is unset, `RATE_LIMIT_STORE` is anything but `postgres`, or
   `PUBLIC_API_URL` is not `https://`. It warns if `TRUST_PROXY` is not `true`.
3. **`assertRlsEnforceable()`** ([`db.ts`](../packages/backend/src/db.ts)). Reads the current
   role from `pg_roles` and refuses to start if it is a superuser or has `BYPASSRLS`, because RLS
   would silently not apply.
4. **`assertMigrationsApplied()`** ([`migrate.ts`](../packages/backend/src/migrate.ts)). Compares
   the migration files with `schema_migrations`. Pending migrations stop a production boot; in
   development they only warn.
5. **`initErrorTracking()`**. Loads Sentry lazily, only when `SENTRY_DSN` is set.
6. **`createApp()`** ([`app.ts`](../packages/backend/src/app.ts)). Builds the Express app and
   validates the auth, preview and mail configuration, throwing on malformed values.
7. Listen on `PORT` (default 3000), then schedule the retention job.

There are no signal handlers: the process does not drain in-flight requests on `SIGTERM`.

**Migrations.** The container entrypoint runs `node packages/backend/dist/migrate.js` before the
server when `RUN_MIGRATIONS` is `true` (the default). The runner takes a Postgres advisory lock
(key "GUID"/"MIGR"), so several replicas starting at once apply each file exactly once: the others
wait for the lock, then skip what is recorded. Each file runs in its own transaction and is recorded
in `schema_migrations`. A failing file rolls back and stops the run. Applied files are never
edited; every change is a new numbered file.

### 4.2 Request pipeline

Middleware runs in this order ([`app.ts`](../packages/backend/src/app.ts)):

| # | Middleware | What it does |
|---|---|---|
| 1 | Request logging (pino-http) | Takes `X-Request-Id` if it is well formed, else makes a UUID, and echoes it on the response. Logs one line per request: method, route *pattern*, status, duration, and for agent calls the first 14 characters of the key. Never bodies, headers, tokens or raw URLs. Probes are not logged. |
| 2 | Metrics | Counts `http_requests_total`, times `http_request_duration_seconds`, counts `agent_requests_total` per agent endpoint. |
| 3 | Security headers | `X-Content-Type-Options: nosniff` everywhere. Outside the agent paths also `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY` and `Content-Security-Policy: frame-ancestors 'none'`. |
| 4 | JSON body parser | 256 KB limit. |
| 5 | `/health`, `/ready` | Liveness (no database) and readiness (`SELECT 1` within 2 s). |
| 6 | `/metrics` | Prometheus text, behind `METRICS_TOKEN`. |
| 7 | `/auth/config` | Public sign-in configuration for the Studio. |
| 8 | `/agent/v1` | The agent script. |
| 9 | `/v1/agent/:key` | The agent API, with its own CORS, rate limit and text body parser. |
| 10 | `/v1` | The Studio API; every route first passes `requireStudioUser`. |
| 11 | Error handler | Turns errors into JSON. |

The agent router is mounted before the Studio router, so agent calls never require a Studio token.

**Errors.** Handlers throw `HttpError(status, code, details?)`. The error handler answers
`{ "error": code }` (plus `details` for validation failures). Errors of 500 and above are logged at
error level and sent to Sentry with the request id and route; lower ones are logged at info. A
body over 256 KB answers `413 payload_too_large`, malformed JSON answers `400 invalid_body`, and
anything unexpected answers `500 internal_error` with no stack trace. Unknown paths get Express's
default 404 page.

**404 versus 403.** Across the Studio API an id that does not exist and an id that belongs to
someone else both answer 404, so ids can't be probed. A 403 only ever means "you are a member, but
your role is too low".

### 4.3 Logging, metrics and error tracking

- **Logs** are JSON lines on stdout (`service: guide-engine-backend`, ISO time, `LOG_LEVEL`
  default `info`). Pipe through `npx pino-pretty` locally.
- **Metrics** at `/metrics`: the Node defaults, request counters and latency histograms, agent
  requests per endpoint and status, `retention_deleted_total{table}`, and database pool gauges
  (`db_pool_total`, `db_pool_idle`, `db_pool_waiting`). Labels are always bounded: route patterns,
  never a key, app or organization. With `METRICS_TOKEN` set, a bearer token is required and
  compared in constant time. Without it, `/metrics` is open in development and answers 404 in
  production.
- **Sentry** is optional and receives only server errors, tagged with request id, route and status.

---

## 5. The database

Source: [`packages/backend/migrations`](../packages/backend/migrations).

### 5.1 Tables

All ids are UUIDs (`gen_random_uuid()`) unless noted. Every table except the three unscoped ones
has RLS **enabled and forced**, so even the table owner is subject to it.

| Table | Holds | Key columns |
|---|---|---|
| `studio_user` | Everyone who has signed in to the Studio | `oidc_issuer` + `oidc_sub` (unique), `email`, `email_verified`, `name`, `last_seen_at`, `platform_admin` |
| `organization` | Customers | `name`, `created_by`, `suspended_at`, `support_access_until`, `support_access_granted_by` |
| `org_member` | Memberships | `(org_id, user_id)` primary key, `role` in owner, manager, editor, viewer |
| `invitation` | Pending invitations | `email`, `org_role` (never owner), `token_hash` (SHA-256 only), `expires_at`, `accepted_at`, `accepted_by` |
| `application` | Apps | `org_id`, `name`, `public_key` (unique), `allowed_origins[]`, `identity_mode`, `signing_secret` (encrypted), `enabled`, help button settings, `route_mode`, `suspended_at` |
| `guide` | Guides | `app_id`, `name`, `type`, `status`, `enabled`, `current_version_id`, `created_by` |
| `guide_version` | Drafts and published versions | `guide_id`, `version_number`, `steps` (JSONB), `route_match` (JSONB), `page_id`, `start_at`, `end_at`, `account_ids[]`, `visitor_tags[]`, `help` (JSONB), `activation`, `published_at` |
| `app_page` | Saved pages | `app_id`, `name` (unique per app, case-insensitive), `match_type`, `match_value`, `start_path` |
| `guide_event` | Everything visitors did | `BIGSERIAL id`, `app_id`, `guide_id`, `guide_version_id`, `step_id`, `visitor_id`, `account_id`, `session_id`, `event_type`, `occurred_at`, `metadata` |
| `user_guide_state` | Per-visitor guide state | `(app_id, visitor_id, guide_id)` primary key, `status` (shown, dismissed, completed), `last_seen_version` |
| `agent_error` | Error reports from browsers | `app_id`, `message`, `stack`, `agent_version`, `url` |
| `support_access_log` | Every request a platform admin made under support access | `org_id`, `admin_user_id`, `admin_name`, `admin_email`, `method`, `path` |
| `system_config` | Global settings (unscoped) | `guide_engine_enabled` is the global kill switch |
| `agent_rate_limit` | Rate-limit windows (unscoped) | `(bucket, window_start)`, `count` |
| `schema_migrations` | Applied migrations (unscoped) | `filename`, `applied_at` |

Two leftovers exist: `app_member` (per-app roles, emptied in 016 and unused) and `step` (an early
normalized steps table that was never used). Neither is read by the code.

**Constraints that encode rules.** A few business rules live in the schema, not only in code:

- One draft per guide: a partial unique index on `guide_version (guide_id) WHERE published_at IS NULL`.
- An app that requires signed identity must have a secret: `identity_mode = 'optional' OR signing_secret IS NOT NULL`.
- A help-only guide must be listed in the help center: `activation = 'auto' OR help IS NOT NULL`.
- A pattern page must have a start page: `match_type = 'exact' OR start_path IS NOT NULL`.
- Help events have no guide, guide events must have one (`chk_help_event_has_no_guide`).
- The help button colour must be `#rrggbb`, because it is injected into the agent's stylesheet.
- Invitations can never grant owner.

**Cascades.** Deleting an organization removes its apps, guides, versions, pages, events, visitor
state, errors, members, invitations and support log through foreign keys. `studio_user` rows are
never deleted. Deleting a saved page sets `page_id` to null on old versions, which then fall back to
their own route snapshot.

### 5.2 The `active_guide` view

Everything that serves guides to visitors reads this view, so the rules for "live" are in one place:

```sql
SELECT g.id, g.app_id, g.name, g.type,
       gv.id AS version_id, gv.version_number, gv.steps,
       CASE WHEN p.id IS NOT NULL
            THEN jsonb_build_object('type', p.match_type::text, 'value', p.match_value)
            ELSE gv.route_match END AS route_match,
       gv.account_ids, gv.start_at, gv.end_at, gv.help,
       p.id AS page_id,
       COALESCE(p.start_path, CASE WHEN p.match_type = 'exact' THEN p.match_value END) AS page_start_path,
       gv.activation, gv.visitor_tags
FROM guide g
JOIN guide_version gv ON gv.id = g.current_version_id
LEFT JOIN app_page p ON p.id = gv.page_id
WHERE g.enabled = TRUE
  AND g.status = 'published'
  AND (gv.start_at IS NULL OR gv.start_at <= now())
  AND (gv.end_at   IS NULL OR gv.end_at   >= now());
```

It is created `WITH (security_invoker = true)`, so it runs with the caller's RLS rather than the
view owner's. A guide on a saved page follows that page's *current* URL: editing a page moves every
live guide on it at once, with no republish.

### 5.3 How the schema got here

The migrations tell the design history. In short:

| Migration | Change | Why |
|---|---|---|
| 001 | Tenants, guides, versions, events, visitor state, RLS on a tenant id | The original OCLC-era single-product model |
| 002 | `FORCE` RLS, split policies, RLS on versions, `security_invoker` view | 001 left the owner exempt, and the view bypassed RLS |
| 003 | Drafts; published versions immutable | What was previewed must be exactly what ships |
| 005 | Tenant → organization → application; Studio users; public keys; visitors and accounts; session-variable policies | Become a public, Pendo-style product. Data converted losslessly |
| 006 | Help center listing and button | Visitors can find guides themselves |
| 007 | Saved pages | Name URL rules once, reuse them, move guides together |
| 008 | Help button position | |
| 009 | Platform admins, suspension, support access and its log | Run the service without reading customers' content |
| 010 | Postgres rate-limit table, retention policies, event time index | Several replicas, long-running production |
| 011 | Agent error reports | See failures in visitors' browsers |
| 012 | Hash routing, help analytics events | Hash-routed apps and help-center measurement |
| 013 | Delete policies for organization export and deletion | Customers can take their data and leave |
| 014 | Forget-visitor policies | Data-subject requests |
| 015, 016 | One org-wide role (owner, manager, editor, viewer); per-app roles retired | Simpler model; two files because new enum values can't be used in the transaction that adds them |
| 017 | Editor/manager split enforced in the database | 016 made every editor an app admin; this restores manager-only actions at the RLS level |
| 018 | `activation` auto or manual | Guides that only appear from the help center |
| 019 | `shown` visitor state | An automatic guide shows once per visitor per version |
| 020 | `visitor_tags` on versions | Target guides by what the visitor may do in the host application |

---

## 6. Isolation: row-level security and session variables

This is the most important mechanism in the backend. Read it before changing any query.

### 6.1 The idea

The backend connects as a role that is **not** a superuser and does **not** have `BYPASSRLS`, and
every scoped table has RLS forced on. So every row any query can see or write must pass a policy.

Policies never look up memberships themselves. Instead, before the handler's queries run, the
backend writes the caller's scope into **transaction-local session variables** with
`set_config(name, value, true)`. Policies read only those variables through small SQL functions
such as `app_app_ids()`. This has three effects:

- Policies can't recurse (a policy on `org_member` never queries `org_member`).
- The scope is computed once per request from verified credentials only.
- The variables vanish at commit or rollback, so a pooled connection never leaks one request's
  scope into the next.

If a variable is not set, its function returns null or an empty array and the policy matches
nothing. Forgetting to set up a session therefore fails closed.

### 6.2 The session helpers

Every query on a scoped table goes through one of these helpers in
[`db.ts`](../packages/backend/src/db.ts). A raw `pool.query()` on a scoped table would see nothing.

| Helper | Used for | Session variables it sets |
|---|---|---|
| `withStudioSession(userId, fn)` | Every normal Studio request | `app.current_user_id`, then from the user's memberships: `app.org_ids`, `app.admin_org_ids` (manager or owner), `app.owner_org_ids`, `app.app_ids` (every app of those orgs), `app.admin_app_ids` (editor or above), `app.manager_app_ids` (manager or above) |
| `withSupportSession(userId, orgId, …)` | A platform admin reading a customer under support access | Logs the request first, then a **read-only** transaction shaped as a viewer of that one org: `org_ids` and `app_ids` set, every admin/manager/owner set empty |
| `withPlatformSession(userId, fn)` | Platform administration | `app.current_user_id`, `app.platform_admin = true` (only if the user's row says so) |
| `withAgentSession(publicKey, fn)` | Every agent request | `app.public_key`, then `app.current_app_id` of the app with that key |
| `withIdentity(identity, fn)` | First sign-in (creating the user row) | `app.current_identity` = `issuer|sub` |
| `presentInvitation(client, hash)` | Reading or accepting an invitation | `app.invite_token_hash` |
| `withRetentionSession(fn)` | The retention job | `app.retention = true` |
| `withMaintenanceSession(fn)` | Operator scripts only (`encrypt-secrets`) | `app.platform_admin = true`, no user |
| `withoutScope(fn)` | Unscoped tables only | none |

Memberships are read *inside* the same transaction under `app.current_user_id`, where the
`org_member` policy lets a user see their own rows. After a membership change in the same
transaction (creating an org, accepting an invitation), the helper re-reads and re-sets the scope.

### 6.3 What the policies say

In words, for the main tables. Policies of the same command are OR-ed together.

| Table | Who can read | Who can write |
|---|---|---|
| `organization` | Members (`org_ids`), its creator, the holder of a valid invitation, platform admins | Update: managers and owners. Delete: owners, platform admins. Insert: anyone, as `created_by = me` |
| `org_member` | Yourself, fellow members, platform admins | Insert: managers and owners; the creator as owner in the creating transaction; an invitee with the invited role. Update: managers and owners. Delete: managers and owners, or yourself |
| `invitation` | Managers and owners of the org, the token holder | Managers and owners; the token holder may mark it accepted |
| `application` | Members of its org, the agent holding its key, an invitee, platform admins | Insert and delete: managers and owners. Update: editor or above, **but** changing `public_key` or `signing_secret` is blocked by the `application_guard_keys` trigger unless the caller is a manager or a platform admin |
| `guide`, `app_page` | Members of the app's org; the agent for its own app; platform admins see guide names for counts | Members of the app's org (role checks in code) |
| `guide_version` | Members of the app's org; the agent for its own app. **Never platform admins** | Insert: members. Update and delete: **only while `published_at IS NULL`** |
| `guide_event` | Members; platform admins (for counts); the retention job | Insert: the agent for its own app. Delete: managers (forget visitor), the retention job. No update, ever |
| `user_guide_state` | The agent for its own app; managers | The agent; managers may delete (forget visitor) |
| `support_access_log` | Managers and owners of that org, platform admins | Insert: platform admins |

Two details are worth understanding:

- **Published versions are immutable in the database.** The update policy's `USING` clause
  requires `published_at IS NULL`. Promoting a draft still works because `USING` is evaluated
  against the row *before* the update.
- **Column-level protection uses a trigger.** RLS can't tell columns apart, and editors may update
  an application's settings. The `application_guard_keys` trigger refuses a change to the key or
  the signing secret unless `app.manager_app_ids` contains the app or the session is a platform
  admin. It tests `app_platform_admin() IS NOT TRUE` because that function returns null, not false,
  in an unset session.

### 6.4 Role checks in code

RLS draws the outer boundary (which orgs and apps). The finer role checks are in the route
handlers, in [`routes/studio/context.ts`](../packages/backend/src/routes/studio/context.ts):

- `requireOrgRole(ctx, orgId, min)`: not a member → 404; below `min` → 403.
- `requireAppRole(ctx, appId, min)`: no access to the app → 404; below `min` → 403.
- `requireAppManager(ctx, appId)`: app access **and** org role manager or owner.

Content writes (guides, pages) are gated only here: at the database level any member of the org
passes the `guide` and `app_page` policies. Manager-only actions are gated in both places.

---

## 7. Studio sign-in and authorization

### 7.1 Signing in

Studio identity comes from OIDC and is **identity only**: the backend reads the subject, email,
email-verified flag and name from the token, and nothing about roles.

1. The Studio calls `GET /api/auth/config`. The backend answers
   `{ oidc: { issuer, clientId, scope } | null, tokenPaste, mailEnabled }`. `oidc` is set when
   `OIDC_STUDIO_CLIENT_ID` is configured; `tokenPaste` is true only in development with a
   development secret.
2. The Studio uses `oidc-client-ts` for the authorization-code flow with PKCE, a
   `redirect_uri` of `/auth/callback`, tokens kept in `sessionStorage`, and silent renewal by
   refresh token.
3. On each API request the backend's `requireStudioUser`:
   - reads `Authorization: Bearer …` (missing → `401 missing_auth`);
   - rejects any token whose `alg` is not one of RS256/384/512, PS256/384/512, ES256/384 (no HS*
     for OIDC, so an attacker can't sign with a public key as an HMAC secret);
   - fetches the signing key from the issuer's JWKS (discovered from
     `/.well-known/openid-configuration` unless `OIDC_JWKS_URI` is set; cached 10 minutes, rate
     limited, 5-second timeout);
   - verifies signature, `iss` = `OIDC_ISSUER`, `aud` = `OIDC_AUDIENCE`, requires `exp` and `sub`,
     5 seconds of clock skew (failure → `401 invalid_token`);
   - **provisions** the user just in time: finds `studio_user` by issuer and subject, creating it
     on first sign-in, and refreshes email and name at most every 5 minutes.
4. In development only (`NODE_ENV` development or test, with `JWT_SECRET` of 32+ characters), HS256
   tokens from `npm run mint-token` are also accepted, with issuer `guide-engine-dev`. In
   production they are rejected even if `JWT_SECRET` is set.

The Studio never decodes tokens itself. It asks `GET /v1/me` who it is and what it can reach.

**Keycloak.** Development uses `docker/keycloak/guide-engine-realm.json`: realm `guide-engine`,
public client `guide-studio` (PKCE S256, refresh tokens, redirect `http://localhost:4300/*`), an
audience mapper that adds `guide-engine-api` to access tokens, 15-minute access tokens, and three
users whose password equals their username (`olivia`, `eddie`, `root`). Production renders the same
realm with `deploy/render-realm.sh`, which removes the users, sets the real Studio host and turns
on brute-force protection.

### 7.2 Roles

Each person has **one role per organization**, and it applies to every app of that organization.

| Role | In one sentence |
|---|---|
| Viewer | Reads the organization's apps: guides, pages, analytics and the install snippet. |
| Editor | Runs the apps day to day: authors, publishes and deletes guides and pages, changes app settings. |
| Manager | Everything an editor does, plus people, new apps, and destructive or security-sensitive app actions. |
| Owner | Everything a manager does, plus the organization itself: ownership, support access, export and deletion. |

Internally the backend still has a per-app ladder (`viewer < editor < publisher < app_admin`) from
the older per-app model. It is derived from the org role: viewer becomes `viewer`, and every other
role becomes `app_admin`. So route checks for "editor" and "publisher" both mean "editor or above".

### 7.3 Who can do what

This is the effective permission matrix, as the backend enforces it.

| Action | Viewer | Editor | Manager | Owner |
|---|:-:|:-:|:-:|:-:|
| See the organization, its apps, guides, pages, analytics and install snippet | ✓ | ✓ | ✓ | ✓ |
| See app settings and recent agent errors in the Studio | | ✓ | ✓ | ✓ |
| Create a guide, save a draft, make a preview link | | ✓ | ✓ | ✓ |
| Publish, roll back, enable or disable a guide | | ✓ | ✓ | ✓ |
| Delete a guide | | ✓ | ✓ | ✓ |
| Create, edit and delete saved pages (including moving live guides) | | ✓ | ✓ | ✓ |
| Change app settings: websites, routing, help button, require signed identity, app on/off | | ✓ | ✓ | ✓ |
| Rotate the public key, generate or rotate the signing secret | | | ✓ | ✓ |
| Export or forget one visitor's data | | | ✓ | ✓ |
| Delete an app | | | ✓ | ✓ |
| Create an app, rename the organization | | | ✓ | ✓ |
| Invite people, revoke invitations, change roles, remove members | | | ✓ | ✓ |
| Make someone owner, or change or remove an owner | | | | ✓ |
| See support-access status and its log | | | ✓ | ✓ |
| Open, extend or close support access | | | | ✓ |
| Export or delete the whole organization | | | | ✓ |
| Leave the organization | ✓ | ✓ | ✓ | ✓ (not the last owner) |

Rules that apply on top: the last owner can't be demoted or removed (`409 last_owner`); invitations
grant manager, editor or viewer, never owner; an invitation sent to an email address can only be
accepted by a user whose verified email matches.

### 7.4 Invitations

1. A manager creates an invitation (`email` optional, role defaults to viewer). The backend makes a
   32-byte random token, stores only its SHA-256 hash, and sets a 7-day expiry.
2. The raw token is returned once in the response as a link, `<Studio>/invite/<token>`. If mail is
   configured (`SMTP_URL`, `MAIL_FROM`, `STUDIO_URL`) and an email was given, the link is also
   emailed after the transaction commits. A mail failure never fails the request.
3. The invitee signs in and opens the link. The backend sets `app.invite_token_hash`, which is what
   lets RLS show them the invitation and the organization's name.
4. Accepting checks it is unused, unexpired, and (if bound to an email) that the verified email
   matches, then inserts the membership with exactly the invited role.

### 7.5 Platform administration and support access

Above organizations sit **platform admins**: the people running the Guide Engine service. The flag
is `studio_user.platform_admin`. The first one is granted with SQL; after that, from the
Administration page (`PUT /v1/platform/admins`, which requires a verified email and refuses to
revoke yourself). A user can never grant it to themselves through the API.

A platform admin session (`withPlatformSession`) can list organizations with usage counts, look at
apps and members, suspend or unsuspend an organization, delete an organization on the customer's
request, switch one app off, and flip the global kill switch. It **cannot** read guide content:
there is no platform policy on `guide_version`, `app_page` or `user_guide_state`.

To help a customer with their content, the customer's **owner** opens **support access** for 1 to
90 days. While it is open:

- the admin sends `X-Support-Org: <orgId>` with ordinary Studio requests;
- each request is first written to `support_access_log` (method, path, admin name and email) in its
  own committed transaction, so even a failed read is logged;
- the request then runs in a `READ ONLY` transaction shaped as a **viewer** of that one
  organization, so writes fail in Postgres and manager-only reads answer 403;
- the organization's managers and owners can read the log in the Studio.

Without the header, or when access is closed, the organization is suspended, or the user is not a
platform admin, the answer is a plain 404.

**Suspension.** Suspending an organization stamps `suspended_at` on it and copies it to each of its
apps. The agent reads the app's copy and serves nothing; support access is refused; the Studio
shows a banner.

---

## 8. The agent API

Source: [`routes/agent.ts`](../packages/backend/src/routes/agent.ts). Public, keyed by the app's
public key, and designed so that a bad or hostile page can't hurt anyone else.

### 8.1 The script

`GET /agent/v1/<key>/guides.js` serves the same file for every well-formed key. The key is checked
only for shape (`ge_pk_` + 32 hex characters); the agent reads its own key from its URL later.

| Header | Value | Why |
|---|---|---|
| `Cache-Control` | `public, max-age=300, s-maxage=3600, stale-while-revalidate=86400` | Browsers re-check every 5 minutes, a CDN hourly |
| `ETag` | the bundle hash | Cheap revalidation (`304`) |
| `Cross-Origin-Resource-Policy` | `cross-origin` | Customer sites may load it |

The file is read from `AGENT_BUNDLE_PATH` (default `packages/agent/dist/guide-engine.js`) on first
request and kept in memory, so **a new agent build needs a backend restart** to be served. A missing
bundle answers `503`. `GET /agent/v1/version` returns `{ version, hash }` uncached.

### 8.2 What every agent request passes through

1. **Key.** Malformed or unknown keys answer the same `404 not_found`, so keys can't be enumerated.
   The app is looked up in a per-process cache for 10 seconds (`AGENT_APP_CACHE_MS`), including
   misses.
2. **Origin.** If the request has an `Origin` header, it must exactly equal one of the app's
   websites, else `403 origin_not_allowed`. An app with no websites refuses every browser. On
   success the response gets `Access-Control-Allow-Origin: <origin>` and `Vary: Origin`; no
   credentials are ever allowed. Requests with no Origin (servers, scripts) pass, which is what
   signed identity is for.
3. **Preflight.** `OPTIONS` answers `204` with `POST` and `Content-Type` allowed, before rate
   limiting. The agent avoids preflights anyway by sending JSON as `text/plain`, which is a CORS
   "simple request" and also works with `keepalive` on page exit.
4. **Rate limit.** A fixed 60-second window per `key|client IP`, default 600 requests per minute
   (`AGENT_RATE_LIMIT_PER_MIN`). Counted in memory in development and in the `agent_rate_limit`
   table in production, so all replicas share one count. Over the limit: `429 rate_limited`.
   Behind a proxy, `TRUST_PROXY=true` is what makes the client IP real.
5. **Session.** The handler runs in `withAgentSession`, so RLS limits it to that one app.
6. **Kill switches.** Guides are served only if the app is enabled, not suspended, and the global
   switch (`system_config.guide_engine_enabled`) is not `'false'`. Otherwise the answer is
   `{ enabled: false, guides: [] }` and the agent goes quiet for that page load.

### 8.3 Endpoints

All are `POST`, and every body carries the identity fields described in
[section 9](#9-visitors-accounts-and-audience-targeting).

**`/v1/agent/<key>/guides`**: the automatic guides for this visitor.

```sql
SELECT a.id, a.app_id, a.name, a.type, a.version_id, a.steps, a.route_match
FROM active_guide a
WHERE a.app_id = $1                                            -- this app
  AND a.activation = 'auto'                                    -- not help-only
  AND (a.account_ids IS NULL OR $3::text = ANY(a.account_ids)) -- account audience
  AND (a.visitor_tags IS NULL OR a.visitor_tags && $4::text[])  -- visitor tags
  AND NOT EXISTS (                                             -- not seen at this version
    SELECT 1 FROM user_guide_state s
    WHERE s.app_id = $1 AND s.visitor_id = $2 AND s.guide_id = a.id
      AND s.status IN ('shown', 'dismissed', 'completed')
      AND s.last_seen_version >= a.version_number)
```

Response: `{ enabled: true, routeMode, guides: [{ id, versionId, name, type, steps, routeMatch }] }`.
Route matching is left to the browser, so one response serves every page of a single-page app.

**`/v1/agent/<key>/help`**: the help center. If the app's help center is off, `{ enabled: false }`.
Otherwise the button settings and every listed guide (automatic and help-only), filtered by the
account allowlist but **not** by visitor state, so finished guides can be replayed. Each item gets a
`startPath`: the listing's own, else the saved page's start, else the exact route. Searching
happens in the browser; there is no search endpoint.

**`/v1/agent/<key>/events`**: 1 to 100 events per call. Guide events carry `guideId`,
`guideVersionId`, optional `stepId`, `sessionId`, `occurredAt` and an event type (`guide_shown`,
`guide_step_viewed`, `guide_step_completed`, `guide_dismissed`, `guide_completed`, `guide_error`).
Help events (`help_opened`, `help_searched`) have no guide; a search query is cut to 200
characters. Events for guides of other apps are silently dropped. Accepted events are inserted in
one statement, then the visitor's state is updated:

- `guide_shown` → `shown`, `guide_dismissed` → `dismissed`, `guide_completed` → `completed`;
- the latest event per guide wins, except that a later `shown` at the same version (a help-center
  replay) never downgrades `dismissed` or `completed`;
- `last_seen_version` only ever goes up, so publishing a newer version re-serves the guide and
  rolling back to an older one does not.

Answer: `202 { accepted: n }`.

**`/v1/agent/<key>/errors`**: `{ message, stack?, url?, agentVersion? }`, length-capped, at most
1,000 per app per hour (extra reports are accepted and dropped). No visitor identity needed.
The Studio lists the latest ones in the app's settings for editors and above.

**`/v1/agent/<key>/preview`**: `{ token }`. Verifies the preview token (HS256 with
`PREVIEW_TOKEN_SECRET`, audience `guide-preview`, 15-minute lifetime) and that it was minted for
*this* app. Returns that exact version, draft or not, ignoring enabled, published, dates, audience,
activation and visitor state. The kill switches still apply. `503 preview_not_configured` when the
secret is unset.

---

## 9. Visitors, accounts and audience targeting

### 9.1 How a visitor is identified

The host page passes ids to `guideEngine.initialize()` and later `identify()`. Every agent request
body carries:

```json
{ "visitor": { "id": "…", "tags": ["…"] }, "account": { "id": "…" }, "jwt": "…" }
```

[`auth/visitor.ts`](../packages/backend/src/auth/visitor.ts) resolves them in this order:

1. **A `jwt` is present** (in any mode): the app must have a signing secret; the token must verify
   with HS256 and that secret (5 seconds of skew, `exp` required) and carry `visitor.id` and
   optionally `visitor.tags` and `account.id`. Ids and tags come from the token; anything else in
   the body is ignored.
   Any failure → `401 identity_invalid`.
2. **No `jwt`, and the app requires signed identity** → `401 signed_identity_required`.
3. **No `jwt` and no visitor** → `401 visitor_required`.
4. Otherwise the plain ids and tags are used.

Ids are strings of 1 to 256 characters. If the page passes no visitor and no token, the agent makes
an anonymous id (`anon-<uuid>`) and keeps it in `localStorage` under `guideEngine.anonymousId`,
so show-once still works per browser.

**Why signed identity exists.** The app key is in every page's source, so anyone can call the agent
API with any visitor or account id they like. That is harmless for tips, but it means plain ids can
be spoofed to see another account's guides or to pollute analytics. With **Require signed identity**
on, the customer's backend signs `{ visitor: { id, tags }, account: { id }, exp }` with the app's
`ge_sk_…` secret, and only those ids and tags are believed. The secret is generated by the backend, shown
once, and stored encrypted with AES-256-GCM under `SECRETS_KEY`. The full contract for the
customer's backend is in [Signed identity](integration/signed-identity.md).

### 9.2 Audience: accounts and visitor tags

Each published version has two independent audience rules. A visitor gets the guide only if both
pass.

| Rule | Stored in | Empty means | Matches when |
|---|---|---|---|
| Accounts | `guide_version.account_ids` (up to 500 ids, 1 to 256 characters) | every account | the visitor's account id is in the list |
| Visitor tags | `guide_version.visitor_tags` (up to 100 tags) | every visitor | the visitor carries **at least one** of the listed tags |

- Both filters run **on the server**, in `/guides` and `/help`, so a visitor who doesn't qualify
  never receives the guide at all.
- A visitor with no account never matches an account list; a visitor with no tags never matches a
  tag list.
- In the Studio both live in the editor's **Audience** section: "All accounts" or "Only these
  accounts", and "All visitors" or "Only visitors with any of these tags", one per line or comma
  separated.
- With signed identity on, the account id and the tags come from the token and can't be faked.
  Without it, both are whatever the page sends, like the visitor id.

**What a tag is.** An opaque, case-sensitive string of letters, digits and `_ . : / -`, at most 100
characters. Guide Engine never interprets it; it only tests whether the visitor's tags and the
guide's tags overlap (`visitor_tags && $tags` in SQL). The host application decides what the tags
mean. The usual choice is one tag per permission the person holds, so an author can limit
"Sell at Point of sale" to `POINT_OF_SALE`. A visitor may carry up to 1,000 tags. Tags are used for
matching only: they are not stored with events and do not appear in analytics.

**Where tags come from in the browser.** The page passes
`initialize({ visitor: { id, tags } })` or `identify(...)`. The engine drops malformed and
duplicate tags before sending, so one bad tag can't get every request refused, and it sends tags
only for unsigned visitors (a signed token carries its own). Calling `identify` with new tags
re-evaluates the page, so a host whose permissions load after the user should wait for both before
calling `initialize`, or the first guide may be torn down and re-chosen.

What this is not: there are no groups, wildcards, attributes or rules. Each guide lists account ids
and tags explicitly. Metadata segments are deliberately not built.

**Before tags existed** the only way to reach "people who may do X" was to point a guide's first
step at an element the host only renders for them, so the engine waited and silently gave up for
everyone else. That still works, but it is invisible to authors and records a `target_not_found`
error each time; tags replace it.

---

## 10. In the browser: agent, engine, renderer, help widget

Source: [`packages/core/src`](../packages/core/src) and [`packages/agent/src`](../packages/agent/src).

### 10.1 The snippet and the agent

The Studio shows each app's snippet, generated by the backend with the app's key and
`PUBLIC_API_URL`:

```html
<script>
(function(w,d,k){var g=w.guideEngine=w.guideEngine||{_q:[]};
['initialize','identify','openHelp','closeHelp','toggleHelp'].forEach(function(m){g[m]=g[m]||function(){g._q.push([m].concat([].slice.call(arguments)))}});
var s=d.createElement('script');s.async=1;s.src='https://guides.example.com/agent/v1/'+k+'/guides.js';d.head.appendChild(s);
})(window,document,'ge_pk_…');
guideEngine.initialize({ visitor: { id: 'USER_ID' }, account: { id: 'ACCOUNT_ID' } });
</script>
```

The stub records calls into `window.guideEngine._q` until the real agent arrives, so the page never
waits for it. When `guides.js` runs ([`agent/src/index.ts`](../packages/agent/src/index.ts)):

1. If `window.guideEngine.version` already exists (snippet included twice), it stops.
2. It finds its own `<script>` (via `document.currentScript`, else by scanning for the URL
   pattern) and takes the API origin and the key from the URL. No configuration is embedded.
3. It builds the engine, the DOM renderer and the help widget, replaces the stub with the real API,
   and replays the queue, `initialize` calls first.
4. After `initialize`, it **watches navigation**: it wraps `history.pushState` and `replaceState`
   and listens for `popstate` and `hashchange`. When the route path actually changes, it calls the
   engine's `onRouteChange`. Single-page apps need no extra code.

Every public method is wrapped in try/catch. A second `initialize` acts as `identify`.

The npm wrappers do the same wiring without the snippet: the Angular `GuideService` follows the
router's `NavigationEnd`, the Vue plugin uses `router.afterEach`. Both expose a directive that
writes `data-guide-id`. The Angular package is compiled with plain `tsc`, so AOT apps should copy
its source or use the snippet.

### 10.2 Starting up

`GuideEngine.init()` ([`engine.ts`](../packages/core/src/engine.ts)) never rejects. In order:

1. Build the identity. A token is passed through; a visitor id is stringified; with neither, the
   anonymous id is used.
2. **Preview?** If the URL has `?guidePreview=<token>` and the backend accepts it, show that guide
   and nothing else. No events, no help center, no route changes for the rest of the page.
3. **Launch link?** If the URL has `?guideEngine=<id>` or `?guideEngine=help:<id>`, load the help
   list, start that guide, and remove the parameter from the address bar so a reload doesn't
   restart it.
4. **Evaluate automatic guides** for the current route (below).
5. **Load the help center** list and show the button if there is anything to list.

Any exception during startup sets the engine to disabled for the page load and sends an error
report.

### 10.3 Choosing what to show

On startup and on every route change the engine calls `/guides` again, then:

1. **Matches routes.** The current path is `location.pathname` in path mode, or the part of
   `location.hash` after `#` in hash mode. Query strings never count. An exact route must be equal;
   a pattern route turns each `*` into `.*` and matches the whole path, so `/dashboard/*` matches
   `/dashboard/x` but not `/dashboard`.
2. **Drops** guides already on screen or finished in this page session.
3. **Orders** walkthroughs (tours, or anything with more than one step) before single tips, keeping
   server order otherwise.
4. **Shows one at a time.** Only when nothing is on screen does the next queued guide start.
   Completion, a missing anchor or a render failure moves on to the next. **Dismissing empties the
   queue**, so "not now" means no more pop-ups on this page; the rest come back on the next
   navigation. A guide still running from the previous page (a cross-page tour) keeps the screen.

Starting a guide from the help center puts any automatic guide that was showing back at the front
of the queue, and starts the chosen one even if this visitor already finished it.

### 10.4 Finding the element

A step's `targetSelector` is always `[data-guide-id="…"]`; the backend refuses any other selector.
That convention keeps guides off CSS classes, which change with every refactor.

| Situation | What happens |
|---|---|
| First step, element present | Draw it anchored. |
| First step, element missing | Wait quietly, polling at 300 ms, 600 ms, … up to 10 tries (about 16.5 seconds). If it never appears: record `guide_error` with `reason: target_not_found`, show nothing, move on. |
| Later step (or going back), element missing | Draw the card **centered** right away, and watch the DOM. When the element appears (for example after the visitor opens a menu), move the card onto it. |
| Element present and the page keeps changing | A `MutationObserver` re-positions the card on each change, coalesced to one animation frame, ignoring changes inside Guide Engine's own elements. If the element is replaced, the selector is re-queried. |

### 10.5 Drawing a step

[`dom-renderer.ts`](../packages/core/src/dom-renderer.ts) creates two elements per guide, appended
to `document.body`:

- a **card host** (`data-guide-host`, `position: fixed`, `z-index: 2147483000`) with an open
  **Shadow DOM**, so the host page's CSS can't restyle the card and the card's CSS can't leak out;
- a **spotlight** sibling: a ring around the target whose huge box-shadow dims the rest of the
  page. It ignores pointer events, so the visitor can still click the highlighted element.

The card contains the step's HTML (sanitized when it was saved), a × close button, and the action
buttons (Next, Back, Dismiss, Done), built with DOM APIs so labels can't inject markup. Back on the
first step is disabled. Escape closes the guide while focus is in the card.

Positioning: the card goes above, below, left or right of the target, 8 px away (below by default),
or centered when there is no target. It is then nudged to stay 8 px inside the viewport. It follows
the target on scroll (a capturing listener, so inner scroll containers count) and on resize. If the
page scrolls the target out of view within 2 seconds of the step appearing, it is scrolled back
once.

**The card is built once per step.** Later re-renders (DOM changes, scrolling, the element arriving)
only move it. Rebuilding it on every change used to replace the buttons under the visitor's cursor,
so clicks on busy pages were lost.

### 10.6 Events and their delivery

| Visitor action | Events |
|---|---|
| First step appears | `guide_shown` |
| A later step appears, or Back | `guide_step_viewed` |
| Next or Done | `guide_step_completed`, then the next step's event, or `guide_completed` after the last |
| ×, Escape or Dismiss | `guide_dismissed` |
| First step's element never appears | `guide_error` (`target_not_found`) |
| Help panel opened | `help_opened` |
| A search pauses for 500 ms with 2+ characters | `help_searched` (query, result count) |

Each event carries the guide, version, step, a per-page-load `sessionId`, and `metadata.source`
(`help` or `link`) when the guide was started on demand. Preview mode records nothing.

The queue sends a batch when it reaches 20 events or 5 seconds after the first one. Dismissed and
completed go out **immediately**, because the server's state must be updated before the next page
load asks for guides. On `pagehide` the queue flushes with `fetch(…, { keepalive: true })`. There is
no retry: a failed batch is dropped. To close the gap before the server's state lands, the engine
also remembers finished guides (by guide and version) for the rest of the page session.

**Error reports.** The engine never writes to the console. About 10% of internal errors, at most 5
per page load, are sent to `/errors` with a context (`init`, `guides`, `render`, …), the message,
stack and page URL.

### 10.7 The help center widget

[`help-widget.ts`](../packages/core/src/help-widget.ts) adds one host element with its own Shadow
DOM: a floating button (label, colour and position from the app's settings), a panel
(`role="dialog"`, `aria-modal`) with a search box and a list, and a confirmation dialog.

- The button shows only when the app's help center is on, there is at least one listed guide, and
  the page did not pass `helpButton: false`. `guideEngine.openHelp()`, `closeHelp()` and
  `toggleHelp()` work either way, so a product can use its own Help button.
- Search runs locally over the list: every word must appear in the title, description or keywords;
  title matches rank first.
- Choosing a guide whose start page is the current page starts it in place. Otherwise the panel asks
  "Go to another page?", and on confirmation does a full page load of the start path with
  `?guideEngine=help:<id>`, which step 3 of startup picks up. Help links never leave the site's
  origin.
- Keyboard: arrows move through results, Enter starts one, Escape closes, Tab stays inside the
  panel.

### 10.8 Failing closed and silent

Every entry point is wrapped. Specifically:

- a non-OK `/guides` answer shows nothing for that navigation; `enabled: false` disables the engine
  until the next page load;
- a render failure tears down that guide, reports it, and moves on;
- storage errors fall back to an in-memory anonymous id;
- requests never send cookies (`credentials: 'omit'`);
- the host page never sees an exception from Guide Engine.

---

## 11. Authoring: guides, versions, pages and preview

Source: [`routes/studio/guides.ts`](../packages/backend/src/routes/studio/guides.ts) and
[`routes/studio/pages.ts`](../packages/backend/src/routes/studio/pages.ts).

### 11.1 A guide and its versions

- A **guide** row holds the name, type, status, `enabled` flag and `current_version_id`. It starts
  as `draft` and disabled, with no versions.
- The **draft** is the one version with `published_at` null. Saving updates it in place.
- **Publishing** promotes the draft: `published_at = now()`, then
  `guide.current_version_id = <it>` and `status = 'published'`. Publishing does not enable the guide;
  enabling is a separate switch, so "published but off" is the normal state after a first publish.
- **Version numbers** are `max + 1` across all versions of the guide and never reused.
- **Rollback** points `current_version_id` at an older published version. Nothing is copied.
- **Delete** removes the guide with all versions, events and visitor state.
- Concurrent saves are serialized with `SELECT … FOR UPDATE` on the guide row.

### 11.2 What a version contains

Validated with zod before anything is written:

| Field | Rules |
|---|---|
| `steps` | 1 to 50. Each: `type`, optional `targetSelector` matching `[data-guide-id="[A-Za-z0-9_-]+"]`, `content` up to 20,000 characters of HTML, `position` (top, bottom, left, right, center), `actions` (label up to 100; next, back, dismiss, complete). Step ids are kept across versions so per-step analytics follow a step through edits. |
| Where | Exactly one of `pageId` (a saved page of this app) or `routeMatch` (`exact` or `pattern`, starting with `/`). With a page, its route is also copied into `route_match` as a fallback. |
| `startAt`, `endAt` | Optional; start must be before end. |
| `accountIds` | Optional, 1 to 500 ids; null means everyone. |
| `visitorTags` | Optional, 1 to 100 tags (letters, digits and `_ . : / -`, up to 100 characters); null means every visitor. |
| `help` | Optional listing: title (≤120), description (≤500), up to 20 keywords, a same-site start path. A pattern route needs a start path unless a saved page provides one. |
| `activation` | `auto` (shows by itself on matching pages) or `manual` (only from the help center; requires a help listing). |

**Sanitizing.** Step content goes through `sanitize-html` with a small allowlist (paragraphs,
emphasis, links, lists, headings, code, quotes, images). Only `href`/`target`/`rel` on links and
`src`/`alt`/`width`/`height` on images survive; no `style`, `class`, `id` or event handlers; only
http, https and mailto URLs; images from http or https only; every link opens in a new tab with
`rel="noopener noreferrer"`. Labels and help text are stripped to plain text. This happens once, on
save, because the renderer injects content as HTML in visitors' browsers.

### 11.3 Saved pages

A saved page is a named URL rule: exact or pattern, with a start path that the help center and
preview open (required for patterns). Guides reference it by id, and the live guide always follows
the page's current URL. Consequences:

- Renaming a page needs an editor. Changing the URL of a page that a live guide uses is effectively a
  publish, and moves those guides immediately.
- A page in use by a live guide or a draft can't be deleted (`409 page_in_use`). Older versions keep
  their route snapshot.

### 11.4 Preview links

An editor asks for `POST …/guides/:id/preview-token { versionId }`. The backend signs
`{ typ: 'guide_preview', guideId, versionId, appId }` with `PREVIEW_TOKEN_SECRET` (at least 32
characters and different from `JWT_SECRET`) for 15 minutes, and returns a URL on the app's first
website: the help start path, else the exact route, else the literal start of the pattern, with
`?guidePreview=<token>` added. The token is useless for any other app.

---

## 12. The Studio application

Source: [`apps/studio/src/app`](../apps/studio/src/app).

**Shape.** Angular 21, standalone components, zoneless, signals throughout. Only the login and
callback pages are loaded eagerly; every other page is its own lazy chunk. Production budgets warn
at 500 KB and fail at 1 MB for the initial bundle.

**Routes.**

| Path | Page | Guard |
|---|---|---|
| `/login`, `/auth/callback` | Sign in, finish SSO | none |
| `/welcome` | Create your first organization and app | signed in |
| `/invite/:token` | Accept an invitation | signed in |
| `/operator` | Administration | platform admin |
| `/o/:orgId/apps` | Apps of an organization | member |
| `/o/:orgId/members` | Members, invitations, support access, danger zone | member |
| `/o/:orgId/apps/:appId/guides` | Guide list with analytics | app viewer |
| `/o/:orgId/apps/:appId/guides/:id` | Guide editor | app viewer |
| `/o/:orgId/apps/:appId/pages` | Saved pages | app viewer |
| `/o/:orgId/apps/:appId/settings` | Install and settings | app viewer |

Guards only shape the UI. Every decision is made again by the backend.

**Talking to the backend.** All calls go to `/api/v1/…` on the Studio's own origin. In development
the Angular dev server proxies `/api` to `http://localhost:3000`; in production nginx does. An
HTTP interceptor adds the bearer token, adds `X-Support-Org` while in support mode (except for
`/me` and `/platform/*`), and on a `401` signs out and goes to `/login?expired=1`. Because the
interceptor reads the token signal, every `effect()` that loads data calls the API inside
`untracked()`, or it would re-run on each token refresh.

**Runtime configuration.** Nothing is baked into the bundle. The Studio learns the identity
provider from `/api/auth/config` at startup. The Studio image has two variables: `BACKEND_URL`
(where nginx proxies `/api`) and `OIDC_ORIGIN` (allowed in the Content-Security-Policy so the token
exchange isn't blocked).

**nginx.** Serves the built files with `index.html` uncached and hashed assets cached for a year,
falls back to `index.html` for client routes, proxies `/api/`, answers `/healthz`, and sets
`X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy` and this CSP:

```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:;
font-src 'self'; connect-src 'self' ${OIDC_ORIGIN}; frame-ancestors 'none'; base-uri 'self';
form-action 'self' ${OIDC_ORIGIN}
```

**The guide editor** is a form, not a visual designer: the author types the anchor id that the
developers put in `data-guide-id`, and the Studio turns it into the selector. Its sections are
*Where & when* (saved page or custom route, start and end, how it starts, audience), *Help center*,
*Steps*, a toolbar (Publish new version, Save draft, Preview, Delete guide), version history and
analytics.

---

## 13. Analytics and the data lifecycle

### 13.1 Analytics

All analytics are SQL over `guide_event` at request time. There is no rollup table.

| View | Endpoint | What it computes |
|---|---|---|
| App overview | `GET /v1/apps/:appId/analytics` | Per guide: shown, completed, dismissed, completion rate (lifetime). Distinct visitors and accounts in the last 30 days. |
| One guide | `GET …/guides/:id/analytics?from&to&by=account` | Counts per event type, counts per step (step ids are stable across versions), guides started from the help center, and with `by=account` the top 50 accounts with their visitors. |
| Help center | `GET /v1/apps/:appId/help-analytics` | Last 30 days: opens, searches, guides started from help, top 20 queries with their average result count (zero-result searches show what to write next). |

`guide_event` is one unpartitioned table with indexes on `(app_id, guide_id, occurred_at)`,
`(app_id, event_type, occurred_at)` and `(occurred_at)`. It is append-only: no session can update an
event.

### 13.2 Retention

`EVENT_RETENTION_DAYS` (default 400 in production, off in development, `0` turns it off) controls a
job that starts 60 seconds after boot and runs daily. It deletes `guide_event` and `agent_error`
rows older than the limit in batches of 10,000, each batch its own transaction, and clears
rate-limit windows older than an hour. It runs under `app.retention`, the only session allowed to
bulk-delete events. Several replicas may run it at once harmlessly. `npm run retention -- --days N`
runs it by hand. `user_guide_state` has no age limit.

### 13.3 One visitor's data

A manager can, from the app's settings:

- **Export** a visitor: their events and guide state as a JSON download;
- **Forget** a visitor: delete their events and guide state in one transaction. The log records the
  counts, never the id.

Removal is a hard delete; nothing is anonymized. After forgetting, that visitor is served every
automatic guide again.

### 13.4 A whole organization

- **Export** (owner): one JSON file with the organization, members, pending invitations, every app's
  settings, saved pages, every guide with all its versions, and lifetime totals per guide. It never
  includes signing secrets, invitation tokens, raw events or visitor state.
- **Delete** (owner, or a platform admin on the customer's request): type the name to confirm; one
  `DELETE` and the foreign keys remove everything. Studio user rows remain.

---

## 14. Deployment and operations

Source: [`deploy/`](../deploy). The reference covers the steps in
[Deploying](../README.md#deploying) and the [Go-live checklist](../README.md#go-live-checklist);
this section explains the shape.

### 14.1 The single-host stack

```
                 Internet :80/:443
                        │
                    ┌───▼────┐   automatic TLS (ACME), HSTS
                    │ Caddy  │
                    └┬──┬──┬─┘
     STUDIO_HOST ────┘  │  └──── AUTH_HOST  (/admin* only from ADMIN_ALLOW_CIDRS)
            │       API_HOST          │
      ┌─────▼────┐ ┌───▼─────┐ ┌──────▼─────┐
      │ studio   │ │ backend │ │ keycloak   │
      │ nginx    ├─▶ :3000   │ │ :8080      │
      └──────────┘ └───┬─────┘ └──────┬─────┘
                       │              │
                 ┌─────▼──────────────▼─────┐      ┌──────────┐
                 │ postgres 16              │◀─────┤ backup   │ nightly pg_dump
                 │  db guide_engine (role   │      └──────────┘
                 │   guide_engine, NOBYPASSRLS)
                 │  db keycloak (role keycloak)
                 └──────────────────────────┘
   optional profile "monitoring": prometheus + alertmanager (localhost ports only)
```

- **Postgres** creates two roles and two databases on first start (`deploy/init.sh`). The backend's
  role can't bypass RLS; Keycloak's role owns only its own database. Neither can read the other.
- **Keycloak** runs in production mode against its own database, behind Caddy, with its admin
  console limited to `ADMIN_ALLOW_CIDRS`. An empty list blocks everyone, which is the safe default.
- **The backend** runs migrations on start, then serves. `BACKEND_REPLICAS` can be raised: the rate
  limit is in Postgres, migrations take a lock, and retention tolerates concurrency.
- **Caddy** obtains certificates, adds HSTS, and routes the three hostnames. The backend and nginx
  set their own security headers.
- **Backups** dump both databases nightly at `BACKUP_AT` (UTC) with `pg_dump -Fc`, keep
  `BACKUP_KEEP_DAYS`, and can copy each file off the host through `BACKUP_COPY_CMD`.
  `deploy/restore.sh` restores one database, stopping the services that use it and taking a
  safety dump first.

### 14.2 Monitoring

With the `monitoring` profile, Prometheus scrapes every backend replica (discovered by DNS) with
`METRICS_TOKEN`, and Alertmanager sends to `ALERT_WEBHOOK_URL`. The rules in
`deploy/monitoring/alerts.yml` (unit-tested in `alerts.test.yml` with `promtool`):

| Alert | Fires when | Severity |
|---|---|---|
| BackendDown | A replica's scrape fails for 2 minutes | page |
| BackendNotDiscovered | No replica is found for 2 minutes | page |
| HighErrorRate | Over 1% of requests answer 5xx for 5 minutes | page |
| DbPoolSaturated | Requests wait for a database connection for 1 minute | page |
| BackendRestarted | A process restarted in the last hour | warning |
| AgentEndpointFailing | Over 5% of `/guides` or `/events` calls fail for 10 minutes | warning |
| AgentGuidesLatencyHigh | `/guides` p95 above 250 ms for 10 minutes | warning |
| AgentRateLimitSaturated | Over 5% of agent calls are rate limited for 10 minutes | warning |
| RetentionNotRunning | Retention deleted nothing for 2 days | warning |

### 14.3 Secrets and keys

| Secret | Made by | Stored | If lost or leaked |
|---|---|---|---|
| App public key `ge_pk_…` | Backend, 16 random bytes, on app creation or rotation | Plain text; it is public | Rotate: old snippets stop working immediately |
| App signing secret `ge_sk_…` | Backend, 32 random bytes, on request | AES-256-GCM under `SECRETS_KEY` | Rotate: tokens signed with the old one stop verifying |
| Invitation token | Backend, 32 random bytes | SHA-256 hash only | Revoke the invitation |
| `SECRETS_KEY` | Operator | Environment | Every app's signing secret becomes unreadable: signed identities fail closed until each app generates a new one |
| `PREVIEW_TOKEN_SECRET` | Operator | Environment | Change it: outstanding preview links stop working |
| `METRICS_TOKEN`, `ALERT_WEBHOOK_URL` | Operator | Environment, mounted as files for Prometheus and Alertmanager | Change them |

`npm run encrypt-secrets` re-writes any signing secrets stored before `SECRETS_KEY` was turned on.

### 14.4 Configuration

The full table is in the [Configuration reference](../README.md#configuration-reference). The
settings that change behaviour in production:

| Variable | Effect |
|---|---|
| `NODE_ENV=production` | Turns on every boot refusal, rejects development tokens, hides `/metrics` without a token, defaults retention to 400 days and the rate limiter to Postgres |
| `DATABASE_URL` | Must be a role without superuser or `BYPASSRLS` |
| `PUBLIC_API_URL` | Where snippets load the agent; must be `https://` |
| `TRUST_PROXY=true` | Makes the client IP real behind Caddy, for rate limiting |
| `OIDC_ISSUER`, `OIDC_AUDIENCE`, `OIDC_JWKS_URI`, `OIDC_STUDIO_CLIENT_ID` | Studio sign-in |
| `SECRETS_KEY`, `PREVIEW_TOKEN_SECRET` | Required in production |
| `RATE_LIMIT_STORE`, `AGENT_RATE_LIMIT_PER_MIN`, `AGENT_APP_CACHE_MS` | Agent protection |
| `EVENT_RETENTION_DAYS` | Data retention |
| `SMTP_URL`, `MAIL_FROM`, `STUDIO_URL` | Invitation emails (all three needed) |
| `METRICS_TOKEN`, `SENTRY_DSN`, `LOG_LEVEL` | Observability |
| `AGENT_BUNDLE_PATH`, `RUN_MIGRATIONS` | Packaging |

### 14.5 Operating the agent script

Browsers cache the agent for 5 minutes and revalidate by ETag, so a new agent reaches visitors
within minutes of a deploy, and a rollback is simply deploying the previous image. Customers never
change their snippet for an agent update. The script URL contains the key, so rotating a key is the
only change that requires customers to edit their pages.

---

## 15. CI, releases and the docs site

**CI** (`.github/workflows/ci.yml`, on every push to `main` and every pull request):

1. *Build and test*: Postgres 16 service, `docker/init.sql`, `npm run build`, migrations against the
   test database, `npm test`.
2. *End-to-end*: starts Postgres and Keycloak with compose, the built backend and the Studio, then
   runs the Playwright smoke test: sign in through Keycloak, create an organization and app, read the
   key from the snippet, create and publish a modal, enable it, load a page with the snippet in a
   fresh browser and check the card and its buttons, then delete the organization.
3. *Docker images*: builds the backend and Studio images and, on pushes, publishes them to
   `ghcr.io/mohanvegi4/guide/{backend,studio}` tagged with the commit SHA and `latest`.

**Releases** (`.github/workflows/release.yml`, on tags `v*`): builds, tests the public packages,
checks each package's version equals the tag, publishes `@guide-engine/core`, `/angular` and `/vue`
to npm with provenance (skipping versions already published), and creates a GitHub release. It needs
the `NPM_TOKEN` repository secret. The backend, agent and Studio ship as images, not npm packages.

**Docs** (`.github/workflows/docs.yml`, on changes to the READMEs, `docs/` or the build script):
`scripts/build-docs.mjs` assembles the site: everything in `docs/`, plus the root README and the
Studio README as the two reference pages, with repository links rewritten to GitHub. Every page in
`docs/` must start with front matter (`title`, `nav_order`) or the build stops. Jekyll with the
Just the Docs theme renders it to GitHub Pages.

---

## 16. Known gaps and quirks

Things that are true of the code today and worth knowing before you rely on or change them.

**Authorization**

- The Studio shows editors the *Generate signing secret*, *Rotate public key*, *Forget a visitor*
  and *Delete app* controls, because its settings page treats the derived `app_admin` role as
  "admin". The backend refuses them
  with 403 ("Your role doesn't allow this."). The fix is to gate those controls on the org role
  being manager or owner.
- Editors can publish, roll back and delete guides. The `publisher` checks in the guide routes are a
  leftover of the per-app model and currently mean "editor or above".
- Content writes (guides, pages) are role-checked in code only; RLS allows any member of the org.
  Manager-only actions are enforced in both layers.
- Visitor tags are exact strings with no hierarchy. If the host's permissions have levels
  (read < edit < delete), it must emit one tag per level the person reaches, so a guide can list
  the lowest level it needs.

**Agent and browser**

- Event delivery has no retry: a failed batch is lost. Page exit relies on `fetch` with `keepalive`
  (no `sendBeacon`, no `visibilitychange` flush).
- The step card has no dialog role and does not move focus; Escape works only while focus is inside
  it. The help panel, by contrast, is fully labelled and traps focus.
- There is no placement flipping and no arrow; cards are clamped into the viewport instead.
- `survey_response`, the `custom` step action and the `checklist`, `survey` and `beacon` types exist
  in the type lists but have no dedicated behaviour; they render like any other step.
- The app-by-key cache (10 seconds per process) means a website added in settings, or a rotated key,
  can take up to 10 seconds to be honoured by every replica.

**Backend and operations**

- No graceful shutdown on `SIGTERM`, and unknown paths get Express's default HTML 404.
- `/v1/agent/<key>/errors` is counted under the endpoint label `other` in metrics, and agent-error
  deletions by retention are logged but not counted in `retention_deleted_total`.
- Rate-limit responses carry no `Retry-After` header, and in production each agent request costs
  one Postgres upsert for the counter.
- Signed-identity tokens are checked for signature and expiry only (no issuer or audience).
- `guide_event` is not partitioned; very large volumes would need it.
- Forgetting a visitor is a hard delete; there is no anonymization path, and `user_guide_state` is
  never aged out.
- The Angular wrapper is not built with ng-packagr, so AOT apps must copy its source or use the
  snippet.

---

## 17. Where to look in the code

| If you are changing… | Start here |
|---|---|
| What a Studio user may do | [`routes/studio/context.ts`](../packages/backend/src/routes/studio/context.ts), [`db.ts`](../packages/backend/src/db.ts), migrations 005, 016, 017 |
| A database rule | A **new** file in [`migrations/`](../packages/backend/migrations); never edit an applied one |
| Which guides a visitor gets | [`routes/agent.ts`](../packages/backend/src/routes/agent.ts) (`/guides`, `/help`), the `active_guide` view (migration 018) |
| Visitor identity | [`auth/visitor.ts`](../packages/backend/src/auth/visitor.ts), [Signed identity](integration/signed-identity.md) |
| Studio sign-in | [`auth/oidc.ts`](../packages/backend/src/auth/oidc.ts), [`auth/studio.ts`](../packages/backend/src/auth/studio.ts), [`auth/config.ts`](../packages/backend/src/auth/config.ts), Studio [`core/auth.service.ts`](../apps/studio/src/app/core/auth.service.ts) |
| Guide validation and publishing | [`routes/studio/guides.ts`](../packages/backend/src/routes/studio/guides.ts), [`sanitize.ts`](../packages/backend/src/sanitize.ts) |
| Route matching, queueing, events in the browser | [`core/src/engine.ts`](../packages/core/src/engine.ts) |
| How a step looks or is positioned | [`core/src/dom-renderer.ts`](../packages/core/src/dom-renderer.ts) |
| The help center | [`core/src/help-widget.ts`](../packages/core/src/help-widget.ts), `/help` in `routes/agent.ts` |
| Snippet loading and navigation detection | [`agent/src/index.ts`](../packages/agent/src/index.ts), `installSnippet` in [`services/orgs.ts`](../packages/backend/src/services/orgs.ts) |
| Boot checks and production refusals | [`index.ts`](../packages/backend/src/index.ts), [`production.ts`](../packages/backend/src/production.ts), [`migrate.ts`](../packages/backend/src/migrate.ts) |
| Logs, metrics, alerts | [`logging.ts`](../packages/backend/src/logging.ts), [`metrics.ts`](../packages/backend/src/metrics.ts), [`deploy/monitoring`](../deploy/monitoring) |
| The production stack | [`deploy/docker-compose.yml`](../deploy/docker-compose.yml), [`deploy/Caddyfile`](../deploy/Caddyfile), [`deploy/.env.example`](../deploy/.env.example) |
