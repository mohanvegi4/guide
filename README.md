# Guide Engine

An in-house, multi-tenant in-app guide engine: a lightweight alternative to Pendo or WalkMe.
Non-engineers write **guides** (tooltips, modals, banners, tours) in the **Authoring Studio**. A
small **runtime SDK** embedded in the product shows them to end users. The SDK works with
Angular, Vue or plain TypeScript.

- **Multi-tenant.** Every guide belongs to one tenant, or is *global* (shown to every tenant).
  Isolation is enforced twice: in the application and by Postgres Row-Level Security.
- **Flag-driven.** A guide shows when it is **published and enabled**, its route matches and it is
  inside its date window. Global and per-tenant kill switches can turn everything off at once.
  There is no audience targeting yet.
- **Self-contained analytics.** Guide events are stored in the engine's own Postgres tables.
- **Fail closed, fail silent.** If anything can't be verified, the SDK shows nothing. It never
  throws into or blocks the host app.

---

## Contents

1. [Architecture](#architecture)
2. [Repository layout](#repository-layout)
3. [Quick start (local)](#quick-start-local)
4. [Embedding the SDK in a product](#embedding-the-sdk-in-a-product)
5. [Authoring guides (Studio)](#authoring-guides-studio)
6. [How a guide is chosen and shown](#how-a-guide-is-chosen-and-shown)
7. [Authentication and roles](#authentication-and-roles)
8. [Configuration reference](#configuration-reference)
9. [API reference](#api-reference)
10. [Data model and migrations](#data-model-and-migrations)
11. [Security model](#security-model)
12. [Testing](#testing)
13. [Deploying](#deploying)
14. [Operations](#operations)
15. [Troubleshooting](#troubleshooting)
16. [Known gaps and roadmap](#known-gaps-and-roadmap)

---

## Architecture

```
 ┌───────────────────────────┐        ┌────────────────────────────┐
 │ Host product (end users)  │        │ Authoring Studio (authors) │
 │ Angular / Vue / plain TS  │        │ apps/studio — Angular 21   │
 │ + @guide-engine/core SDK  │        │ SSO (OIDC) or dev token    │
 └─────────────┬─────────────┘        └─────────────┬──────────────┘
  Bearer token │ (end user)                  Bearer │ token (guide_admin /
               │ /guides/active /events             │ platform_admin)
               │ /system/flag /preview/guide        │ /guides  /platform/guides
               ▼                                    ▼
        ┌──────────────────────────────────────────────────────┐
        │          Backend — packages/backend (Express)        │
        │   auth: HS256 (JWT_SECRET) + OIDC (provider JWKS)    │
        │   sanitization · drafts/publish/rollback · preview   │
        └──────────────────────────┬───────────────────────────┘
                                   │ withTenant(): sets app.current_tenant_id
                                   ▼
                  ┌─────────────────────────────────────┐
                  │ Postgres 16 — RLS FORCEd,           │
                  │ connected as a non-superuser role   │
                  └─────────────────────────────────────┘
```

**A guide's lifecycle:**

1. **Create.** An author creates a guide in the Studio. It starts disabled, with nothing published.
2. **Save draft.** Steps, route and dates are saved as the guide's single **draft** version.
   Content is sanitized before it is stored.
3. **Preview** (optional). This mints a 15-minute signed link. Opening it in the product shows
   exactly that version, even while the guide is disabled or unpublished.
4. **Publish.** The draft becomes an immutable, numbered version and is made the live one.
5. **Enable.** The guide's `enabled` flag goes on.
6. **Show.** In the product, the SDK fetches `/guides/active`, matches the current route, finds the
   `data-guide-id` element and renders the step in a Shadow DOM card.
7. **Record.** The SDK batches events (`guide_shown`, `guide_step_completed`, …) to `/events`. A
   dismiss or complete is also recorded per user, so that user won't see the guide again until a
   newer version is published.
8. **Analyze.** Authors read funnel and per-step analytics in the Studio, and can roll back to any
   published version.

---

## Repository layout

An npm workspaces monorepo. Run commands from the repo root unless noted.

```
packages/
  core/              @guide-engine/core: framework-agnostic engine (state machine, event
                     queue, route matching) + default Shadow-DOM renderer
  angular-wrapper/   @guide-engine/angular: GuideService (Router hook) + [guideAnchor] directive
  vue-wrapper/       @guide-engine/vue: GuidePlugin (vue-router hook) + v-guide-anchor + useGuideEngine()
  backend/           @guide-engine/backend: Express + Postgres API, migrations, ops scripts
apps/
  studio/            Authoring Studio (Angular 21, standalone components). See apps/studio/README.md
  demo/              minimal host app embedding the SDK, for end-to-end checks
docker/
  init.sql           creates the NON-superuser `guide_engine` role (required for RLS)
  mock-idp.json      config for the dev-only mock OIDC provider
docker-compose.yml   Postgres 16 (:5433) + optional mock OIDC provider (:8080, profile "sso")
CLAUDE.md            conventions for contributors (including AI assistants)
GUIDE_ENGINE_IMPLEMENTATION_PROMPT.md   original task list and design rationale
```

---

## Quick start (local)

**Prerequisites:** Node **20.19+, 22.12+ or 24+** (required by Angular 21 and `jwks-rsa`), npm, and
Docker.

```bash
npm install
npm run db:up                    # Postgres 16 on localhost:5433, creates the app role + DBs
cp packages/backend/.env.example packages/backend/.env
```

Edit `packages/backend/.env`. Set `JWT_SECRET` and `PREVIEW_TOKEN_SECRET` to two **different**
values (each from `openssl rand -hex 32`). For local work, also set
`CORS_ORIGINS=http://localhost:5174` so the demo app can call the API.

```bash
npm run build                    # builds all packages (core first)
npm run migrate                  # applies packages/backend/migrations/*.sql
npm run dev:backend              # API on http://localhost:3000 (hot reload)
```

Create a tenant and some tokens (`npm run … --workspace=packages/backend` runs inside that package,
so its `.env` is picked up):

```bash
npm run create-tenant --workspace=packages/backend -- --name Acme
# -> prints the tenant id

npm run mint-token --workspace=packages/backend -- --tenant <tenant-id> --user alice --role guide_admin
npm run mint-token --workspace=packages/backend -- --tenant <tenant-id> --user pat --role guide_admin,platform_admin
npm run mint-token --workspace=packages/backend -- --tenant <tenant-id> --user bob
```

The first token is an author's, the second can also edit **global** guides, and the third
(no role) is an end user's for the SDK. Tokens last 8 hours by default (`--ttl 1h` to change it).

Start the apps, each in its own terminal:

```bash
npm run start --workspace=apps/studio -- --port 4300    # Studio: http://localhost:4300
npm run dev --workspace=apps/demo                       # demo host app: http://localhost:5174
```

- **Studio:** paste the author token, or use SSO (see [below](#try-sso-locally)). Create a guide,
  add a step anchored to `invite-button`, set the route to `/dashboard`, **Publish**, then switch
  it **Enabled**.
- **Demo app:** paste the end-user token. `/dashboard` has a button with
  `data-guide-id="invite-button"`, and your guide appears next to it. The Studio's **Preview**
  links open here (`PREVIEW_APP_BASE_URL`).

### Try SSO locally

```bash
npm run idp:up                   # dev-only mock OIDC provider on http://localhost:8080
```

In `packages/backend/.env`, set the following and restart the backend:

```
OIDC_ISSUER=http://localhost:8080/default
OIDC_AUDIENCE=guide-engine-api
OIDC_STUDIO_CLIENT_ID=guide-studio
```

The Studio's login page now shows **Sign in with SSO**. On the mock's login page, enter any
username and these claims:

```json
{ "tenantId": "<tenant-id>", "roles": ["guide_admin", "platform_admin"] }
```

`docker/mock-idp.json` sets the access-token audience to `guide-engine-api` for the
`guide-studio` client.

**Stopping:** run `npm run db:down`. It stops the containers; the database volume is kept.

---

## Embedding the SDK in a product

### 1. Give the SDK a token the backend accepts

The SDK sends the end user's bearer token on every request. The backend derives **tenant and
user from that token only**. The `tenantId` / `userId` you pass to the SDK are informational and
never trusted. Choose one option:

| Option | How |
|---|---|
| **A. Your product's backend mints guide tokens** | Sign a short-lived HS256 JWT per user with the shared `JWT_SECRET`. Claims: `tenantId` (uuid), `userId`, `exp`. Include `iss` / `aud` if `JWT_ISSUER` / `JWT_AUDIENCE` are set. No role is needed for end users. |
| **B. Reuse your identity provider's access token** | If your product already gets OIDC access tokens from the same provider configured as `OIDC_ISSUER`, with `aud` = `OIDC_AUDIENCE` and a tenant claim, pass that token directly. |

`getAuthToken` is called before each request, so it can return a freshly refreshed token.

### 2. Allow the product's origin

Add the product's origin to `CORS_ORIGINS` on the backend, for example `https://app.example.com`.

### 3. Tag elements with `data-guide-id`

Guides target elements by a stable `data-guide-id` attribute, never by CSS classes, so markup
refactors don't break them. Use the framework directives below, or set the attribute yourself.
Ids may use letters, digits, `-` and `_`.

### Angular

```ts
// app.config.ts
import { ApplicationConfig, inject, provideAppInitializer } from '@angular/core';
import { GuideService } from '@guide-engine/angular';

export const appConfig: ApplicationConfig = {
  providers: [
    // ...provideRouter(routes), etc.
    provideAppInitializer(() => {
      const guides = inject(GuideService);
      const auth = inject(MyAuthService); // your own auth service
      // Don't await: the engine fails silently and must never delay bootstrap.
      void guides.init({
        apiBaseUrl: 'https://guides-api.example.com',
        tenantId: auth.tenantId,  // informational
        userId: auth.userId,      // informational
        getAuthToken: () => auth.getGuideToken(),
      });
    }),
  ],
};
```

```ts
// any standalone component
import { GuideAnchorDirective } from '@guide-engine/angular';   // or import GuideModule

@Component({
  imports: [GuideAnchorDirective],
  template: `<button [guideAnchor]="'invite-button'">Invite teammates</button>`,
})
export class TeamComponent {}
```

`GuideService` re-evaluates guides on every `NavigationEnd`. `provideAppInitializer` needs
Angular 19+. On older versions, use an `APP_INITIALIZER` factory, or call `guides.init(...)` from
your root component's `ngOnInit`.

### Vue 3

```ts
import { createApp } from 'vue';
import { GuidePlugin, vGuideAnchor } from '@guide-engine/vue';

const app = createApp(App);
app.use(router);
app.use(GuidePlugin, {
  router,                                   // re-evaluates on router.afterEach
  apiBaseUrl: 'https://guides-api.example.com',
  tenantId: auth.tenantId,
  userId: auth.userId,
  getAuthToken: () => auth.getGuideToken(),
});
app.directive('guide-anchor', vGuideAnchor);   // the plugin doesn't register it for you
app.mount('#app');
```

```vue
<button v-guide-anchor="'invite-button'">Invite teammates</button>
```

Inside a component's `setup()`, `useGuideEngine()` returns the shared engine.

### Plain TypeScript (no framework)

```ts
import { GuideEngine, createDomRenderer } from '@guide-engine/core';

const engine = new GuideEngine();
const renderer = createDomRenderer({
  advanceStep: (id) => engine.advanceStep(id),
  dismissGuide: (id) => engine.dismissGuide(id),
});
void engine.init({ apiBaseUrl, tenantId, userId, getAuthToken }, renderer);

// call on every client-side navigation:
void engine.onRouteChange(location.pathname);
```

`apps/demo/src/main.ts` is a complete working example.

### Consuming the packages

The packages build to CommonJS in `dist/`, using `npm run build`. Inside this monorepo they're
linked by workspaces. To use them elsewhere, publish them to your registry or `npm link` them.
Angular CLI apps may warn about a CommonJS dependency. Add `@guide-engine/core` to
`allowedCommonJsDependencies`, or let Vite alias the TypeScript source as `apps/demo/vite.config.mts` does.

---

## Authoring guides (Studio)

Full details are in [`apps/studio/README.md`](apps/studio/README.md). In short:

- **Guides** is the tenant's own guides; **Global guides** (platform admins only) is the guides shown
  to every tenant. Both use the same editor.
- **Where and when:** route match (an exact path, or a pattern where `*` matches anything) and
  optional start and end dates.
- **Steps:** add, remove and reorder them. Each step has:
  - **Type.**
  - **Anchor:** the `data-guide-id` to point at. Leave it blank for a centered card.
  - **Position.**
  - **HTML content:** sanitized when saved, see [Security](#security-model).
  - **Buttons:** `next`, `dismiss` or `complete`. `back` is accepted but not yet handled by the
    default renderer.
- **Save draft** stores work in progress without going live. **Preview** saves the draft and gives
  you a signed 15-minute link to open in the product. **Publish new version** makes it live.
- **Versions** lists history. **Roll back to this** makes an older published version live again.
  **Load into editor** starts a new edit from any version.
- **Enabled** is the on/off switch. Nothing shows until a version is published **and** the guide
  is enabled.
- **Analytics** shows totals per event type plus a per-step funnel (views, done, dismissed). Step
  ids stay stable across edits, so a step's numbers carry over between versions.

---

## How a guide is chosen and shown

When the SDK starts (and on every route change), it:

1. **Checks the kill switches** at `GET /system/flag`. If either is off, the request fails or the
   response is unexpected, the SDK disables itself for the session.
2. **Handles preview links.** If the URL has `?guidePreview=<token>`, the SDK asks the backend to
   verify it. If it's valid, it shows **only** that version, ignores routes, the enabled flag and
   publish state, and sends no analytics. If it's invalid, it carries on in normal mode.
3. **Fetches candidates** from `GET /guides/active`. The server returns only guides that are:
   - from the caller's tenant, or global;
   - published and enabled;
   - inside their date window;
   - not already dismissed or completed by this user at this version or later.
4. **Matches the route** on the path only; query string and hash are ignored. `exact` compares the
   whole path; `pattern` turns each `*` into "match anything", so `/projects/*` matches
   `/projects/42/settings`.
5. **Finds the target.** If the anchor element isn't in the DOM yet, it retries with backoff (10
   attempts, about 16.5 s in total), then records `guide_error` with `target_not_found` and gives up
   until the next navigation.
6. **Renders** the step in a Shadow DOM card, so host styles don't leak in. It follows the target as
   the page changes and re-finds it if the framework re-creates the element.
7. **Records events**, batched every 5 s or every 20 events. `guide_dismissed` and `guide_completed`
   are sent immediately, and anything still queued is flushed on `pagehide`.

**Re-showing:** once a user dismisses or completes a guide, they don't see it again until a
**newer** version is published. Rolling back to an older version doesn't bring it back.

---

## Authentication and roles

Every API call except `/health` and `/auth/config` needs `Authorization: Bearer <token>`. Two kinds
of token are accepted, each checked against its own algorithms and keys:

| Token | Verified with | Typical use |
|---|---|---|
| **HS256 JWT** | `JWT_SECRET` (+ `JWT_ISSUER` / `JWT_AUDIENCE` if set) | SDK end users (minted by your product), scripts, local dev |
| **OIDC access token** (RS/PS/ES algorithms) | the provider's JWKS, found via `OIDC_ISSUER/.well-known/openid-configuration` | Studio SSO; optionally SDK end users |

Every token must have an `exp` and a UUID tenant claim. For OIDC tokens, the claim names are set by
`OIDC_TENANT_CLAIM`, `OIDC_USER_CLAIM` and `OIDC_ROLES_CLAIM`. Dot paths such as
`realm_access.roles` are allowed.

**Roles** come from a `role` string or a `roles` array. With OIDC, roles may also be a space- or
comma-separated string.

| Role | Can |
|---|---|
| *(none)* | SDK endpoints only: active guides, events, kill-switch flag, preview resolution |
| `guide_admin` | Author the tenant's own guides (`/guides/*`) |
| `platform_admin` | Author **global** guides (`/platform/guides/*`); see global analytics across tenants |

**Studio sign-in.**
- With `OIDC_STUDIO_CLIENT_ID` set, the Studio uses OIDC Authorization Code + PKCE.
- The backend returns this setup from `GET /auth/config`, and the user's verified identity from
  `GET /auth/me`. The Studio never decodes tokens itself.
- Paste-a-token is offered in development, or when no SSO is configured.

**Dev bypass.** `GUIDE_ENGINE_DEV_AUTH=true` also accepts raw `tenantId:userId[:role]` tokens. It
is only allowed when `NODE_ENV` is `development` or `test`. In any other environment, including an
unset `NODE_ENV`, the backend **refuses to start**.

---

## Configuration reference

The backend reads `packages/backend/.env` (see `.env.example`). Misconfiguration stops the process
at boot rather than running half-secured.

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | — | Postgres URL. Must be a **non-superuser, NOBYPASSRLS** role (checked at boot). |
| `PORT` | `3000` | HTTP port. |
| `NODE_ENV` | — | `production` in real deployments. `development` / `test` unlock dev conveniences. |
| `JWT_SECRET` | — | HS256 secret, ≥ 32 chars. Required unless OIDC is configured. |
| `JWT_ISSUER`, `JWT_AUDIENCE` | — | If set, HS256 tokens must carry a matching `iss` / `aud`. |
| `PREVIEW_TOKEN_SECRET` | — | Signs preview links. ≥ 32 chars, must differ from `JWT_SECRET`. Empty disables preview (503). |
| `PREVIEW_APP_BASE_URL` | — | Product URL that preview links open, e.g. `https://app.example.com`. If empty, the Studio shows the raw token. |
| `CORS_ORIGINS` | — | Comma-separated product origins allowed to call the API from a browser. Empty means same-origin only. |
| `GUIDE_ENGINE_DEV_AUTH` | `false` | Dev-only raw-token bypass (see above). |
| `OIDC_ISSUER` | — | Enables OIDC. Must be `https://`; `http://localhost` is allowed only in dev or test. |
| `OIDC_AUDIENCE` | — | Required with `OIDC_ISSUER`. The `aud` the provider puts in access tokens for this API. |
| `OIDC_JWKS_URI` | discovered | Skip discovery and use this JWKS URL. |
| `OIDC_TENANT_CLAIM` | `tenantId` | Claim path holding the tenant UUID. |
| `OIDC_USER_CLAIM` | `sub` | Claim path holding the user id. |
| `OIDC_ROLES_CLAIM` | `roles` | Claim path holding roles. |
| `OIDC_STUDIO_CLIENT_ID` | — | Public OIDC client used by the Studio. Setting it turns on **Sign in with SSO**. |
| `OIDC_STUDIO_SCOPE` | `openid profile` | Scopes the Studio requests. Add `offline_access` if your provider needs it to issue refresh tokens. |

The Studio has no runtime configuration of its own. It calls `/api/*` on its own origin: the dev
server proxies that to `localhost:3000` (`apps/studio/proxy.conf.json`), and in production a
reverse proxy must do the same.

---

## API reference

Responses are JSON. Admin endpoints return database rows (snake_case); SDK endpoints return
camelCase. **Cross-tenant access always returns `404 not_found`**, the same as a missing id, so ids
from other tenants can't be probed.

### Public

| Method & path | Notes |
|---|---|
| `GET /health` | `{ ok: true }` |
| `GET /auth/config` | `{ oidc: { issuer, clientId, scope } \| null, tokenPaste: boolean }`. No secrets. |

### Any valid token (SDK)

| Method & path | Notes |
|---|---|
| `GET /auth/me` | `{ tenantId, userId, roles }`, the verified identity. |
| `GET /system/flag` | `{ globalEnabled, tenantEnabled }`, the kill switches. |
| `GET /guides/active` | `Guide[]`: `{ id, versionId, tenantId, isGlobal, name, type, steps, routeMatch }`. |
| `POST /events` | `{ events: Event[] }`, 1–100 per batch → `202 { accepted }`. Events for guides the caller can't see are dropped. |
| `GET /preview/guide` | Header `X-Guide-Preview: <token>`. Returns the previewed `Guide` with `preview: true`. The preview token must belong to the caller's tenant. |

An `Event` is `{ guideId, guideVersionId, stepId?, sessionId, eventType, occurredAt (ISO), metadata? }`.
`eventType` is one of: `guide_shown`, `guide_step_viewed`, `guide_step_completed`,
`guide_dismissed`, `guide_completed`, `guide_error`, `survey_response`.

### Authoring

The same routes exist under **`/guides`** (role `guide_admin`, the tenant's own guides) and
**`/platform/guides`** (role `platform_admin`, global guides).

| Method & path | Body → response |
|---|---|
| `GET /` | List the scope's guides, with `current_version_number`. |
| `POST /` | `{ name, type }` → `201` the new guide (disabled, draft). |
| `GET /:id` | The guide row plus `versions[]` (newest first). A version with `published_at: null` is the draft. |
| `PATCH /:id/flag` | `{ enabled: boolean }` → `{ id, enabled }` |
| `PUT /:id/draft` | `VersionBody` → the saved draft (created or updated in place). |
| `POST /:id/publish` | `VersionBody` → saves it as the draft and promotes it. **Empty body** promotes the existing draft as-is. `201` the version. |
| `POST /:id/rollback/:versionNumber` | Make a published version current. Drafts aren't valid targets. |
| `POST /:id/preview-token` | `{ versionId }` → `{ token, url, expiresAt }` (15 min). |
| `GET /:id/analytics` | `{ guideId, scope, counts: [{event_type, count}], steps: [{step_id, event_type, count}] }` |

A `VersionBody` looks like this:

```jsonc
{
  "routeMatch": { "type": "exact" | "pattern", "value": "/dashboard/*" },  // must start with "/"
  "startAt": "2026-11-01T00:00:00Z",   // optional
  "endAt":   "2026-12-01T00:00:00Z",   // optional; must be after startAt
  "steps": [{                          // 1–50 steps
    "id": "uuid",                      // optional: send it back to keep the step's identity
    "order": 0,
    "type": "tooltip",                 // tooltip|modal|banner|tour|checklist|survey|beacon
    "targetSelector": "[data-guide-id=\"invite-button\"]",   // optional; must use this exact form
    "position": "bottom",              // top|bottom|left|right|center
    "content": "<p>Invite your team</p>",                    // ≤ 20,000 chars, sanitized
    "actions": [{ "label": "Next", "action": "next" }]       // next|back|dismiss|complete
  }]
}
```

### Errors

| Status | `error` | Meaning |
|---|---|---|
| 400 | `invalid_body` | Validation failed (`details` holds the zod field errors). |
| 400 | `empty_content_after_sanitize` | A step had nothing left after unsafe HTML was removed. |
| 400 | `no_draft_to_publish` | Publish was called with no body and there's no draft. |
| 401 | `missing_auth` / `invalid_token` | No bearer token, or it failed verification. |
| 403 | `forbidden` | Valid token, but the required role is missing. |
| 403 | `invalid_preview_token` | The preview token is invalid or expired. |
| 404 | `not_found` | Doesn't exist, or belongs to another tenant. |
| 503 | `preview_not_configured` | `PREVIEW_TOKEN_SECRET` isn't set. |
| 500 | `internal_error` | Logged server-side; no details are returned. |

---

## Data model and migrations

| Table | Purpose |
|---|---|
| `tenant` | Customers. |
| `system_config` | Global settings, including `guide_engine_enabled` (the global kill switch). |
| `tenant_config` | Per-tenant settings, including `guide_engine_enabled` (the tenant kill switch). |
| `guide` | A guide: `tenant_id` **or** `is_global`, `type`, `status`, `enabled`, `current_version_id`. |
| `guide_version` | Numbered versions with steps (JSONB), route match and date window. `published_at IS NULL` means the draft (at most one per guide). Published rows are immutable. |
| `guide_event` | Analytics events, tagged with the tenant they came from. |
| `user_guide_state` | Per-user dismissed or completed status, with `last_seen_version`. |
| `active_guide` (view) | Published, enabled guides inside their date window. |
| `step` | Unused. Steps live in `guide_version.steps`. It's kept only because `001` must not be edited. |

| Migration | What it does |
|---|---|
| `001_init.sql` | Original schema, RLS policies and the `active_guide` view. |
| `002_rls_hardening.sql` | `FORCE` RLS; tenants can read global guides but not write them; RLS on `guide_version` and `tenant_config`; null-safe tenant lookup; `security_invoker` view; drops the unused step foreign key. |
| `003_drafts.sql` | One draft per guide; published versions can't be updated or deleted, enforced in the database. |
| `004_platform_admin.sql` | Extra policies for writing global guides and reading their events, unlocked only for verified platform admins. |

**Rules:** never edit a migration once it's applied; add a new numbered file instead. Every query
on a tenant table goes through `withTenant()` in `packages/backend/src/db.ts`, never a raw
`pool.query()`.

---

## Security model

- **Tenant isolation, twice.** Every query filters by tenant in the application. Postgres RLS is
  `FORCE`d, so it applies even to the table owner. Tests check each layer separately, including
  that turning RLS off makes the database-level tests fail.
- **The database role must not bypass RLS.** Superusers and `BYPASSRLS` roles skip RLS entirely,
  so the backend refuses to start if `DATABASE_URL` uses one. `docker/init.sql` creates a suitable
  role.
- **Tenants never come from client input.** Tenant ids come only from verified tokens. Global-guide
  writes need a database session flag that is set only for verified `platform_admin` requests,
  and it never opens up another tenant's rows.
- **Content is sanitized when saved** with `sanitize-html`, on both draft and publish, before
  anything is stored.
  - Allowed tags: `p br strong em b i u s a ul ol li h1–h4 code pre blockquote span img`.
  - No `style`, no `on*` handlers, no `iframe`, `script` or `svg`.
  - Links must be `http`, `https` or `mailto`, and get `rel="noopener noreferrer"`.
  - Images must be `http` or `https`; `data:` URIs are removed.
  - The SDK sets button labels via `textContent`.
- **Preview tokens** use their own secret and audience, so they can never pass as login tokens.
  They last 15 minutes and only work for a signed-in user of the same tenant.
- **No algorithm confusion.** The HS256 path accepts only `HS256` with `JWT_SECRET`. The OIDC path
  accepts only asymmetric algorithms with the provider's keys. Every token must have an `exp`.
- **Published versions are immutable**, enforced by RLS: history can't be rewritten, even by a
  buggy route.

---

## Testing

```bash
npm run db:up                         # backend tests need Postgres
npm test                              # every workspace
npm test --workspace=packages/backend # API tests against a real Postgres (DB: guide_engine_test)
npm test --workspace=packages/core    # vitest + jsdom
npm test --workspace=apps/studio      # Angular unit tests (vitest)
```

- **Backend:**
  - Each run drops and re-migrates `guide_engine_test`.
  - Tests use real HS256 tokens and a local JWKS server.
  - Fixtures that need superuser rights (global guides, kill switches) use a separate admin pool.
  - Test files run one at a time because they share the database.
  - The test environment pins its own settings, so your `.env` never leaks in
    (`packages/backend/vitest.config.mts`).
  - Coverage includes auth (including algorithm confusion and the dev bypass), sanitization,
    lifecycle, tenant isolation (API and database level), drafts and preview, per-user state,
    stable step ids, global guides and OIDC.
- **Core:** route matching, fail-closed kill switches, target retry and backoff, the event queue
  (batching, urgent flush, `pagehide`), preview mode, finished guides, and the renderer and
  observer edge cases.
- **Studio:** auth service, list toggle with revert on error, scope routing, and analytics
  re-fetching.

Type-checking is part of every `test` script (`tsc -p tsconfig.test.json`), with strict mode
throughout.

---

## Deploying

There's no deployment pipeline in this repo. This is the checklist:

**Database**

- [ ] Postgres **15+** (16 recommended).
- [ ] Create an app role with `NOSUPERUSER NOBYPASSRLS` that owns the database (see
  `docker/init.sql`).
- [ ] Run migrations as that role: `npm run migrate --workspace=packages/backend` after building.

**Backend**

- [ ] `NODE_ENV=production`, and **no** `GUIDE_ENGINE_DEV_AUTH`.
- [ ] Unique random values for `JWT_SECRET` and `PREVIEW_TOKEN_SECRET`, from a secret store.
- [ ] `CORS_ORIGINS` set to your product origins; `PREVIEW_APP_BASE_URL` set to your product URL.
- [ ] Run it: `npm run build && node packages/backend/dist/index.js`, behind HTTPS. Provide the
  settings as real environment variables: `dotenv` only reads a `.env` in the working directory,
  and it never overrides variables that are already set.

**Studio**

- [ ] Build it with `npm run build --workspace=apps/studio`. The output is `apps/studio/dist/studio/browser`.
- [ ] Serve it as static files with an SPA fallback to `index.html`.
- [ ] Proxy `/api/*` to the backend, removing the `/api` prefix (same-origin, so no CORS is needed).

**Identity provider**

- [ ] Register a public SPA client (`OIDC_STUDIO_CLIENT_ID`).
- [ ] Redirect URI `https://<studio>/auth/callback`; post-logout URI `https://<studio>/login`.
- [ ] Access tokens must be JWTs with `aud` = `OIDC_AUDIENCE`, a tenant UUID claim and a roles
  claim.
- [ ] Enable refresh tokens if you want silent renewal.

**Products**

- [ ] Embed the SDK and pass a verifiable end-user token through `getAuthToken`.

Don't run the mock identity provider (`docker compose --profile sso`) in any real environment.

---

## Operations

**Kill switches.** Run these as an operator role; tenants can't change them.

```sql
-- Turn guides off everywhere, then back on
UPDATE system_config SET value = 'false', updated_at = now() WHERE key = 'guide_engine_enabled';
UPDATE system_config SET value = 'true',  updated_at = now() WHERE key = 'guide_engine_enabled';

-- Turn guides off for one tenant (no row = enabled)
INSERT INTO tenant_config (tenant_id, key, value) VALUES ('<tenant-id>', 'guide_engine_enabled', 'false')
ON CONFLICT (tenant_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
```

The SDK checks the switches when it starts, so pages already open pick up a change on their next
reload.

**Scripts** (in `packages/backend`; run `npm run build` first):

| Command | Purpose |
|---|---|
| `npm run migrate` | Apply pending migrations (tracked in `schema_migrations`). |
| `npm run create-tenant -- --name <name>` | Create a tenant and print its id. |
| `npm run mint-token -- --tenant <uuid> --user <id> [--role a,b] [--ttl 8h]` | Sign an HS256 token with `JWT_SECRET`. |

**Reset a user's dismissal** so they see a guide again:
`DELETE FROM user_guide_state WHERE tenant_id = '<t>' AND user_id = '<u>' AND guide_id = '<g>';`

---

## Troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| Backend exits with `Refusing to start: database role … bypasses Row-Level Security` | `DATABASE_URL` uses a superuser (e.g. `postgres`). Use the `guide_engine` role. |
| Backend exits with `GUIDE_ENGINE_DEV_AUTH=true is only allowed when NODE_ENV is development or test` | Set `NODE_ENV=development` locally, or remove the flag. |
| `npm run build` fails in `angular-wrapper` with `Cannot find module '@guide-engine/core'` | Build from the repo root. It builds `core` first. |
| `Could not prepare the test database` | Postgres isn't running; run `npm run db:up`. |
| Studio: `Port 4200 is already in use` | Start it on another port: `-- --port 4300`. |
| Studio: "Cannot reach the backend" | The backend isn't on :3000, or (in production) `/api` isn't proxied. |
| Studio SSO: "The backend rejected your sign-in token" | Check `OIDC_ISSUER` matches the token's `iss` exactly; `OIDC_AUDIENCE` matches `aud`; the tenant claim is a UUID at `OIDC_TENANT_CLAIM`. |
| SSO redirect error at the provider | Register the redirect URI `https://<studio>/auth/callback`. |
| Guide doesn't appear | Work through the list in the next section. |
| SDK calls fail in the browser with CORS errors | Add the product's origin to `CORS_ORIGINS` and restart the backend. |
| Preview link shows nothing | It expired (15 min); the viewer isn't signed in to the product as a user of the same tenant; or a kill switch is off. |

**Guide doesn't appear checklist**

1. Is the guide **published** (Versions shows a `live` version) **and Enabled**?
2. Does the route match? The match uses the path only. `exact` must match the whole path;
   `pattern` uses `*`.
3. Is now within the start and end dates?
4. Are both kill switches on (`GET /system/flag`)?
5. Has this user already dismissed or completed this version? Publish a newer version, or reset
   their state (see [Operations](#operations)).
6. Is the anchor in the DOM with exactly that `data-guide-id`? If not, the SDK logs `guide_error`
   with `target_not_found` after about 16 s; check Analytics.
7. In the browser's Network tab, does `GET /guides/active` return the guide?

---

## Known gaps and roadmap

- **"back" buttons do nothing yet.** The Studio offers the action, but the default renderer doesn't
  handle it.
- **Identity providers that can't put the tenant id in access tokens** need a user→tenant mapping
  table, which isn't built.
- **SSO silent renewal needs refresh tokens.** Without them, users sign in again when the access
  token expires.
- **One preview URL for all tenants.** `PREVIEW_APP_BASE_URL` is global; per-tenant product URLs
  aren't supported.
- **Global guides have no per-tenant breakdown.** Platform admins see totals only.
- **Kill switches have no admin UI.** They're changed with SQL.
- **`useGuideEngine()` (Vue)** relies on `app.provide`, so only call it inside `setup()`.
- **Deferred to later phases** by design: audience and segment targeting, surveys, i18n, rollout
  percentages, cross-tenant reporting, and a drag-and-drop visual editor.
