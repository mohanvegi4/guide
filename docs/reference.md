---
title: Configuration and API reference
nav_order: 2.8
---

# Configuration and API reference

Every setting, every endpoint and the database schema.

## Configuration reference

The backend reads `apps/backend/.env` (see `.env.example`). Misconfiguration stops the
process at boot.

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | — | Postgres URL. Must be a **non-superuser, NOBYPASSRLS** role (checked at boot). |
| `PORT` | `3000` | HTTP port. |
| `NODE_ENV` | — | `production` in real deployments. `development` / `test` allow dev tokens. |
| `PUBLIC_API_URL` | `http://localhost:$PORT` | Where browsers reach this API. Goes into every install snippet. |
| `OIDC_ISSUER` | — | Your identity provider. **Required outside development.** Must be `https://`; `http://localhost` is allowed only in dev or test. |
| `OIDC_AUDIENCE` | — | Required with `OIDC_ISSUER`. The `aud` of access tokens issued for this API. |
| `OIDC_JWKS_URI` | discovered | Skip discovery and use this JWKS URL. |
| `OIDC_STUDIO_CLIENT_ID` | — | Public OIDC client the Studio uses. Setting it turns on **Sign in with SSO**. |
| `OIDC_STUDIO_SCOPE` | `openid profile email` | Scopes the Studio requests. Add `offline_access` for refresh tokens if your provider needs it. |
| `JWT_SECRET` | — | **Dev/test only:** HS256 secret for `mint-token` / `seed` Studio tokens. Ignored in production. |
| `PREVIEW_TOKEN_SECRET` | — | Signs preview links. ≥ 32 chars, must differ from `JWT_SECRET`. Empty disables preview. |
| `AGENT_RATE_LIMIT_PER_MIN` | `600` | Agent requests allowed per app key and client IP, per minute. |
| `RATE_LIMIT_STORE` | `memory` (`postgres` in production) | Where that budget is counted: in the process, or in Postgres so every replica shares it. **Must be `postgres` in production.** |
| `TRUST_PROXY` | `false` | Set `true` behind a reverse proxy so rate limiting sees real client IPs. |
| `SECRETS_KEY` | — | 32 bytes (hex or base64) that encrypt apps' signing secrets at rest (AES-256-GCM). **Required in production.** After turning it on, `npm run encrypt-secrets` re-writes secrets stored earlier. |
| `EVENT_RETENTION_DAYS` | `400` in production, off elsewhere | The daily job deletes `guide_event` rows older than this. `0` turns it off. |
| `LOG_LEVEL` | `info` (`silent` in test) | Lowest level written to the JSON log on stdout: `trace`, `debug`, `info`, `warn`, `error`, `fatal`. |
| `METRICS_TOKEN` | — | Bearer token that `GET /metrics` requires. Unset: the endpoint is open in development/test and absent (404) elsewhere. |
| `SENTRY_DSN` | — | Optional. Set to report 5xx errors to Sentry (tagged with the request id, route and status; `environment` = `NODE_ENV`, `release` = the backend version). |
| `RUN_MIGRATIONS` | `true` | Container only: apply pending migrations before starting. `false` when a release step runs `node apps/backend/dist/migrate.js`. Either way the backend checks at boot that no migration is pending: in production it refuses to start and lists the files; elsewhere it logs a warning. |
| `AGENT_BUNDLE_PATH` | `packages/embed-agent/dist/guide-engine.js` | Where the backend reads the agent script from. |
| `SMTP_URL` | — | Invitation emails: `smtp://user:pass@host:587` or `smtps://…`. Unset: invitations are links to copy. `json://` logs messages instead of sending (development/tests). |
| `MAIL_FROM` | — | Required with `SMTP_URL`: the From header, e.g. `Guide Engine <no-reply@example.com>`. |
| `STUDIO_URL` | — | The Studio's public origin (`https://studio.example.com`), for links in emails. Invitations are only emailed when it is set. |

The Studio has no runtime config. It calls `/api/*` on its own origin: the dev server proxies
that to `localhost:3000` (`apps/studio/proxy.conf.json`), and in production a reverse proxy
must do the same.

The `deploy/` stack reads `deploy/.env` instead (`deploy/.env.example` lists everything): the
three hostnames, the Postgres and Keycloak passwords, the two backend secrets above, and the
backup settings `BACKUP_AT` (daily run time, `03:00` UTC), `BACKUP_KEEP_DAYS` (`14`) and
`BACKUP_COPY_CMD` (off-host copy, unset) — see [Backups and restore](operations.md#backups-and-restore).

---

## API reference

JSON throughout. Studio responses that are database rows use snake_case.

### Public

| Method & path | Notes |
|---|---|
| `GET /health` | `{ ok: true }` |
| `GET /auth/config` | `{ oidc: { issuer, clientId, scope } \| null, tokenPaste, mailEnabled }`: how the Studio signs in, and whether invitations are emailed. |
| `GET /agent/v1/:key/guides.js` | The agent script. The same static file for every key, with a strong `ETag` (its content hash), `Cache-Control: public, max-age=300, s-maxage=3600, stale-while-revalidate=86400` and `Cross-Origin-Resource-Policy: cross-origin`; `If-None-Match` is answered with `304`. |
| `GET /agent/v1/version` | `{ version, hash }` of the script this backend serves (no key): a cheap uptime and deploy check. `Cache-Control: no-store`. |

### Agent API (public app key; CORS for the app's websites)

Bodies may be `text/plain` or `application/json`. `/guides`, `/help` and `/events` carry an identity:
`{ visitor?: { id, tags? }, account?: { id } | null, jwt? }`. With a `jwt`, its claims replace the
plain `visitor` and `account`, and anything else sent beside it is ignored. Tags that can't match
(malformed, or not a list) are ignored rather than refused.

| Method & path | Body → response |
|---|---|
| `POST /v1/agent/:key/guides` | identity → `{ enabled, routeMode, theme: { color, matchSite }, guides: [{ id, versionId, name, steps, routeMatch }] }`. `routeMode` is `path` or `hash`; `theme` is the app's color and whether to match the website's Bootstrap theme ([Help center](install.md#help-center)). |
| `POST /v1/agent/:key/events` | identity + `{ events: [{ guideId, guideVersionId, stepId?, sessionId, eventType, occurredAt, metadata? }] }` (1–100) → `202 { accepted }`. Stored under the environment of the page's `Origin`; when that environment's analytics are off, the events update show-once state only and are not stored. Help-center events (`help_opened`, `help_searched`) carry no `guideId` / `guideVersionId`; a `help_searched` event's `metadata` is `{ query, results }` (the query is cut to 200 characters; other keys are dropped). |
| `POST /v1/agent/:key/preview` | `{ token }` → the previewed guide with `preview: true` and the app's `theme` |
| `POST /v1/agent/:key/errors` | `{ message (1–500 chars), stack? (≤ 4000), url? (≤ 2000), agentVersion? }` → `202 { accepted }`. `accepted: false` once the app already has 1000 reports in the last hour. |
| `POST /v1/agent/:key/help` | identity → `{ enabled, routeMode, theme, button: { label, color, position }, guides: [{ …guide, help: { title, description, keywords, startPath } }] }`. The help-center list; not route-filtered, and includes guides the visitor already finished. Account and tag rules still apply. |

`eventType` is one of `guide_shown`, `guide_step_viewed`, `guide_step_completed`,
`guide_dismissed`, `guide_completed`, `guide_error`, `survey_response`, `help_opened`,
`help_searched`.

### Studio API (`/v1`, bearer token from OIDC, or a dev token)

| Method & path | Who | Notes |
|---|---|---|
| `GET /me` | anyone signed in | `{ user: { id, email, name, platformAdmin }, orgs: [{ id, name, role, suspendedAt, apps: [{ id, name, role }] }] }`. Creates the user on first sign-in. |
| `GET` / `PUT` / `DELETE /orgs/:orgId/support-access` | manager / owner / owner | `PUT` takes `{ days }` (1–90) → `{ active, until, grantedBy, maxDays, log[] }`. |
| `GET /support-context` | platform admin, with `X-Support-Org: <orgId>` | The organization as a viewer sees it, if support access is open; otherwise 404. Any `/v1` org/app read works the same way under that header (read-only, logged). |
| `GET /platform/orgs`, `GET /platform/orgs/:orgId` | platform admin | Organizations with owners and usage; one with its apps (each with `usage: { guides, events30d, errors24h }`). 403 for everyone else. |
| `PUT /platform/orgs/:orgId/suspension` | platform admin | `{ suspended }` |
| `DELETE /platform/orgs/:orgId` | platform admin | `{ confirmName }`: the same deletion an owner can do, for a customer's deletion request; logged at `warn` with the admin's user id. |
| `PATCH /platform/apps/:appId` | platform admin | `{ enabled }` |
| `GET` / `PUT /platform/kill-switch` | platform admin | `{ enabled }` |
| `GET` / `PUT /platform/admins` | platform admin | `PUT` takes `{ email, platformAdmin }`; `400 unknown_user` / `cannot_revoke_self`. |
| `POST /orgs` | anyone | `{ name, app: { name, websites[] } }` → you become owner. |
| `GET` / `PATCH /orgs/:orgId` | viewer / manager | `PATCH` takes `{ name }`. |
| `GET /orgs/:orgId/export` | owner | The organization's data as a JSON download (`Content-Disposition: attachment; filename="guide-engine-<org-slug>-<date>.json"`): `{ format, formatVersion, exportedAt, organization, members[], invitations[], apps: [{ …, pages[], guides: [{ …, analytics: { shown, completed, dismissed }, versions[] }] }], notes[] }`. Never signing secrets, invitation tokens or raw events. |
| `DELETE /orgs/:orgId` | owner | `{ confirmName }` must equal the organization's name (`400 confirmation_mismatch`). Deletes the organization and everything in it; `204`. |
| `GET` / `POST /orgs/:orgId/apps` | viewer / manager | Every member sees every app of the organization. |
| `GET` / `PATCH /apps/:appId` | viewer / editor | `GET` includes `snippet`. `PATCH` takes `{ name?, websites?, identityMode?, enabled?, helpEnabled?, helpButtonLabel?, helpButtonColor?, helpPosition?, routeMode?, matchSiteTheme? }` (returned as `match_site_theme`); the color must be hex, the position one of `bottom-right`, `bottom-left`, `top-right`, `top-left`, `center`, the route mode `path` or `hash` (returned as `route_mode`). `websites` edits the app's only environment; with several, `400 websites_per_environment` (edit each environment instead). |
| `GET` / `POST /apps/:appId/environments` | viewer / editor | `[{ id, name, position, websites, analyticsEnabled }]` in promotion order (the last is production). `POST` takes `{ name, websites?, analyticsEnabled?, last? }` and adds it in front of production unless `last`. Names are unique per app ignoring case (`409 environment_name_taken`); a website belongs to one environment (`409 website_in_use`, `details.websites`). |
| `PATCH /apps/:appId/environments/:environmentId` | editor | `{ name?, websites?, analyticsEnabled? }` |
| `PUT /apps/:appId/environments/order` | editor | `{ ids }`: every environment id, in the new order (`400 order_must_list_every_environment`). The last becomes production. |
| `DELETE /apps/:appId/environments/:environmentId` | manager | `{ confirmName }`. Removes its releases and visitor state; its events stay, without an environment. `409 last_environment`. |
| `GET /apps/:appId/help-analytics` | viewer | Help-center usage over the last 30 days in one environment (`?environment=<id>`, default production): `{ days, environmentId, opens, searches, guidesStarted, topQueries: [{ query, count, avgResults }] }` (top 20 queries, normalized to lower case). |
| `POST /apps/:appId/rotate-key` | manager | New public key; old snippets stop working. |
| `GET` / `DELETE /apps/:appId/visitors/:visitorId` | manager | Data-subject requests for one end user: `GET` downloads their events and guide state as JSON; `DELETE` ("forget this visitor") removes them → `{ visitorId, events, guideState }`. |
| `DELETE /apps/:appId` | manager | `{ confirmName }` must equal the app's name. Deletes the app with its guides, pages, events, visitor state, agent errors and grants; `204`. |
| `POST /apps/:appId/signing-secret` | manager | `{ secret }`, shown once. |
| `GET /apps/:appId/errors?limit=50` | viewer | The newest agent errors (1–200): `[{ id, message, stack, agentVersion, url, occurredAt }]`. |
| `GET /orgs/:orgId/members` | viewer | `[{ userId, email, name, orgRole }]`, owners first. |
| `PATCH` / `DELETE /orgs/:orgId/members/:userId` | manager (or yourself, to leave) | `PATCH` takes `{ orgRole }`. Only owners give or take `owner`; the last owner can't be demoted or removed (`409 last_owner`). |
| `GET` / `POST /orgs/:orgId/invitations` | manager | `POST` takes `{ email?, orgRole: manager\|editor\|viewer }` (default viewer; owners are promoted, never invited) → `{ …, token, emailSent }`. With an `email` and mail configured, the link is emailed; `emailSent` is false when it wasn't (no mail set up, or sending failed — the request still succeeds). |
| `DELETE /orgs/:orgId/invitations/:id` | manager | revoke |
| `GET /invitations/:token`, `POST /invitations/:token/accept` | the link holder | |
| `GET` / `POST /apps/:appId/guides` | viewer / editor | `POST` takes `{ name }` (a `type` older clients send is ignored). Each listed guide carries `releases: [{ environmentId, versionNumber }]` in environment order. |
| `GET /apps/:appId/guides/:id` | viewer | Guide + `versions[]`. The version with `published_at: null` is the draft. |
| `PUT /apps/:appId/guides/:id/draft` | editor | `VersionBody` |
| `POST /apps/:appId/guides/:id/publish` | editor | `VersionBody`, or empty to publish the draft as-is. |
| `PATCH /apps/:appId/guides/:id/flag` | editor | `{ enabled }` |
| `DELETE /apps/:appId/guides/:id` | editor | Deletes the guide with its versions, analytics events and visitor state; `204`. No undo. |
| `POST /apps/:appId/guides/:id/rollback/:n` | editor | Releases published version `n` in production → `{ id, current_version_id }`. |
| `GET /apps/:appId/guides/:id/releases` | viewer | Per environment, in order: `[{ environmentId, name, position, versionId, versionNumber, releasedAt, canRevert, history: [{ action, versionNumber, at, by, reverted }] }]`. |
| `POST /apps/:appId/guides/:id/releases` | editor | `{ environmentId, versionId }` releases a published version there (`400 version_not_published`); `versionId: null` withdraws the guide from it. Returns the releases. |
| `POST /apps/:appId/guides/:id/promote` | editor | `{ from }`: the next environment gets what `from` runs (`409 nothing_to_promote` / `already_in_production`). Returns the releases. |
| `POST /apps/:appId/guides/:id/releases/:environmentId/revert` | editor | Undoes that environment's latest release change, restoring the state before it; repeat to walk further back (`409 nothing_to_revert`). Returns the releases. |
| `POST /apps/:appId/guides/:id/preview-token` | editor | `{ versionId }` → `{ token, url, expiresAt }` |
| `GET /apps/:appId/guides/:id/analytics` | viewer | `{ environmentId, counts[], steps[], startedFromHelp, accounts? }` for one environment: `?environment=<id>`, default production. `?from=` / `?to=` (ISO date or timestamp; `from` inclusive, a date `to` covers that whole day, a timestamp `to` is exclusive; `400` when `to` isn't after `from`). `?by=account` adds `accounts: [{ accountId \| null, shown, completed, dismissed, visitors }]`: the 50 accounts shown the guide most, most first. |
| `GET /apps/:appId/analytics` | viewer | `{ guides: [{ guideId, name, shown, completed, dismissed, completionRate }], visitors, accounts, windowDays, environmentId }` for one environment (`?environment=<id>`, default production). Lifetime totals per guide (`completionRate` is `completed / shown`, 0–1), ordered by `shown`; `visitors` / `accounts` are distinct over the last `windowDays` (30). |
| `GET` / `POST /apps/:appId/pages` | viewer / editor | List (by name, with `usage: { guides, live }`) or create `{ name, routeMatch: { type, value }, startPath? }`. A pattern needs `startPath`. Names are unique per app, ignoring case. |
| `GET /apps/:appId/pages/:pageId` | viewer | The page + `guides: [{ id, name, live, draft }]` (live versions and drafts on it). |
| `PUT /apps/:appId/pages/:pageId` | editor | Same body as `POST`. Guides on the page follow at once. |
| `DELETE /apps/:appId/pages/:pageId` | editor | `409 page_in_use` (with `details.guides`) while a live version or draft uses it. |

A `VersionBody` is:

```
{ steps: [{ id?, order, targetSelector?, content, position?, actions: [{ label, action }] }],
  pageId? | routeMatch?: { type, value },   // exactly one
  startAt?, endAt?, accountIds?: string[] | null, visitorTags?: string[] | null,
  help?: { title, description?, keywords?: string[], startPath? } | null,
  activation?: 'auto' | 'manual' }
```

- `pageId` is one of the app's saved pages (`400 unknown_page` otherwise); the version then follows
  the page's URL. `routeMatch` is a custom route.
- `targetSelector` must be `[data-guide-id="…"]`.
- `content` is at most 20,000 characters and is sanitized.
- `accountIds` is null for everyone, or 1–500 ids.
- `visitorTags` is null for every visitor, or 1–100 tags (letters, digits and `_ . : / -`, up to 100
  characters each, case-sensitive). The guide then shows only to visitors carrying at least one.
- `help` is null when the guide isn't in the help center. Its text is plain, and `startPath` must
  be a path on your own site. It defaults to the page's start page, then to an exact route; custom
  pattern routes require one.
- `activation` is how the guide starts: `auto` (default) pops up when a visitor opens the page,
  once per published version; `manual` never pops up and is only reachable from the help center
  or a help link, so it requires `help` (`400` otherwise).

**Errors** are `{ error, details? }`:

| Status | Codes |
|---|---|
| 400 | `invalid_body`, `empty_content_after_sanitize`, `no_draft_to_publish`, `signing_secret_required`, `unknown_app`, `unknown_page`, `unknown_user`, `cannot_revoke_self`, `confirmation_mismatch`, `version_not_published`, `websites_per_environment`, `order_must_list_every_environment` |
| 401 | `missing_auth`, `invalid_token`, `visitor_required`, `signed_identity_required`, `identity_invalid` |
| 403 | `forbidden`, `origin_not_allowed`, `invalid_preview_token`, `invitation_email_mismatch` |
| 404 | `not_found`, including other organizations' resources and unknown keys |
| 409 | `last_owner`, `already_member`, `page_name_taken`, `page_in_use`, `environment_name_taken`, `website_in_use`, `last_environment`, `nothing_to_promote`, `already_in_production`, `nothing_to_revert` |
| 410 | `invitation_used`, `invitation_expired` |
| 413 | `payload_too_large` |
| 429 | `rate_limited` |
| 503 | `preview_not_configured` |

---

## Data model

The tables, their key columns, the constraints that encode business rules and the
`active_guide` view are described in [How Guide Engine is built](architecture.md#5-the-database);
the row-level security policies in [section 6](architecture.md#63-what-the-policies-say) of the
same page.

Every table under an organization references its parent with `ON DELETE CASCADE`, so deleting
an `organization` (or one `application`) removes everything beneath it in one statement.
Referential actions bypass Row-Level Security, which is what lets a deletion take published
versions and events with it without any session being allowed to delete those directly.

## Migrations

Migration runs are serialized with a Postgres advisory lock (held for the whole run, released
when it ends), so replicas that all run `migrate.js` at start can boot together: one applies the
pending files and the others wait, then find nothing to do.

| Migration | What it does |
|---|---|
| `001_schema.sql` | The whole schema: types, the session-variable helpers RLS reads, every table with its constraints and indexes, the `application_guard_keys` trigger, the `active_guide` view, every RLS policy (enabled and forced), and the kill-switch row. |
| `002_drop_leftovers.sql` | Drops what the code no longer used: `app_member` and `app_role` (per-app roles), `invitation.app_roles`, the never-used `step` table, the retired `admin` / `member` roles (`org_role` now has only owner, manager, editor, viewer) and the unused `snoozed` visitor status. The two enums are rebuilt, with the policy and CHECK constraints that embed them. |
| `003_match_site_theme.sql` | `application.match_site_theme` (default on, existing apps included): guide cards and the help center follow the website's Bootstrap theme, with `help_button_color` as the fallback. |
| `004_drop_guide_type.sql` | Drops `guide.type` and the `guide_type` enum (rebuilding `active_guide` without it): the type never changed how a guide looks. Steps saved earlier keep a `type` key in their JSON, which nothing reads. |

The 21 migrations written during development were squashed into `001_schema.sql` before the first
deployment (they had only run on development databases); [How the schema got
here](architecture.md#53-how-the-schema-got-here) keeps their design history. From here on,
a schema change is a new numbered file, and an applied file is never edited.
