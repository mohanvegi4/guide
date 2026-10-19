# Guide Engine

In-app guides for any web application: a lightweight alternative to Pendo or WalkMe.

1. **Install.** Add one snippet to your site's `<head>`. It carries your application's public
   key.
2. **Author.** Your team writes tooltips, modals, banners and tours in the **Studio**, and
   points them at elements tagged `data-guide-id`.
3. **Ship.** Preview a draft on your real site, publish, and switch it on.
4. **Measure.** Track shown / completed / dismissed, per step.
5. **Help center.** A floating **Help** button (or your own button) opens a searchable list of
   guides. Users pick a task and are taken to the right page, where the guide starts.

**One Studio, many apps.** An **organization** owns any number of **applications**.
- Org owners and admins manage all of them.
- Teammates get a role per app: viewer, editor, publisher or app admin.

Guides work in any framework (Angular, React, Vue, server-rendered pages…) with no code changes
beyond the snippet. Single-page-app navigation is detected automatically.

---

## Contents

1. [How it works](#how-it-works)
2. [Repository layout](#repository-layout)
3. [Quick start (local)](#quick-start-local)
4. [Installing Guide Engine on a website](#installing-guide-engine-on-a-website)
5. [Using the Studio](#using-the-studio)
   - [Saved pages](#saved-pages)
   - [Help center](#help-center)
6. [How a guide is chosen and shown](#how-a-guide-is-chosen-and-shown)
7. [Identity, roles and security](#identity-roles-and-security)
8. [Configuration reference](#configuration-reference)
9. [API reference](#api-reference)
10. [Data model and migrations](#data-model-and-migrations)
11. [Testing](#testing)
12. [Deploying](#deploying)
13. [Operations](#operations)
14. [Troubleshooting](#troubleshooting)
15. [Known gaps and roadmap](#known-gaps-and-roadmap)

---

## How it works

```
  Your website (any framework)                  Guide Studio (apps/studio)
  ┌────────────────────────────────┐            ┌──────────────────────────────┐
  │ <head> install snippet          │            │ sign in with your identity   │
  │   key ge_pk_…  (public)         │            │ provider (OIDC)              │
  │ guideEngine.initialize({        │            │ orgs → apps → guides         │
  │   visitor:{id}, account:{id} }) │            │ members, roles, invites      │
  └───────────────┬────────────────┘            └──────────────┬───────────────┘
   GET /agent/v1/<key>/guides.js                      /api/v1/… (same-origin proxy)
   POST /v1/agent/<key>/guides|events|preview         │
                  ▼                                   ▼
        ┌──────────────────────────────────────────────────────────┐
        │                Backend (packages/backend)                 │
        │ agent API: per-app CORS, rate limit, optional signed      │
        │            visitor identity                               │
        │ Studio API: OIDC identity → org/app memberships → roles   │
        └──────────────────────────┬───────────────────────────────┘
                                   │ withAgentSession / withStudioSession
                                   ▼
                    Postgres 16: Row-Level Security on every table,
                    connected as a non-superuser role
```

**A guide's life:**

1. **Create.** An author creates a guide in an app. It starts disabled, with nothing published.
2. **Save draft.** Steps, route and audience are stored as the guide's single draft. HTML is
   sanitized server-side.
3. **Preview** (optional). This gives a signed 15-minute link to the app's website. It shows
   that exact version, even while the guide is disabled or unpublished, and records no
   analytics.
4. **Publish.** The draft becomes an immutable, numbered version. **Enable** turns it on.
5. **Show.** On the website, the agent asks for the visitor's active guides, matches the URL
   path, finds the `data-guide-id` element and renders the step in a Shadow DOM card.
6. **Record.** Events are batched to the backend. A dismiss or complete is remembered per
   visitor, so they don't see it again until a **newer version** is published.

---

## Repository layout

An npm workspaces monorepo; run commands from the repo root.

```
packages/
  core/              @guide-engine/core: engine (matching, retries, events, preview) + Shadow-DOM renderer
  agent/             the install-snippet agent: one ~10 KB IIFE served at /agent/v1/<key>/guides.js
  backend/           @guide-engine/backend: Express + Postgres — Studio API, agent API, migrations, scripts
  angular-wrapper/   @guide-engine/angular: optional npm alternative to the snippet ([guideAnchor] directive)
  vue-wrapper/       @guide-engine/vue: optional npm alternative to the snippet (v-guide-anchor directive)
apps/
  studio/            Guide Studio (Angular 21) — see apps/studio/README.md
  demo/              a plain host page that installs Guide Engine via the snippet (no SDK import)
docker/              init.sql (non-superuser app role), mock-idp.json (dev-only OIDC provider)
docker-compose.yml   Postgres 16 (:5433); mock OIDC provider (:8080, profile "sso")
CLAUDE.md            conventions for contributors (including AI assistants)
```

---

## Quick start (local)

**Prerequisites:** Node **20.19+, 22.12+ or 24+**, npm, and Docker.

```bash
npm install
npm run db:up                                    # Postgres 16 on :5433 (creates the app role + DBs)
cp packages/backend/.env.example packages/backend/.env
```

Edit `packages/backend/.env`. Set `JWT_SECRET` and `PREVIEW_TOKEN_SECRET` to two **different**
values, each from `openssl rand -hex 32`.

```bash
npm run build                                    # all packages, including the agent bundle
npm run migrate                                  # applies packages/backend/migrations/*.sql
npm run seed --workspace=packages/backend        # dev org + app + demo config + a Studio sign-in token
npm run dev:backend                              # API on http://localhost:3000
```

In two more terminals:

```bash
npm run start --workspace=apps/studio -- --port 4300    # Studio: http://localhost:4300
```

```bash
npm run dev --workspace=apps/demo                       # demo site: http://localhost:5174
```

1. **Studio:** paste the token `seed` printed. Open **Demo site → Guides**, create a guide, give
   step 1 the anchor `invite-button`, set the route to `/dashboard`, then **Publish** and
   **Enable**.
2. **Demo site:** reload `/dashboard`, and the guide appears next to "Invite teammates". Use the
   "Sign in as" box to switch visitor and account, which exercises `guideEngine.identify()`.

### Signing in with SSO locally

```bash
npm run idp:up      # dev-only mock OIDC provider on http://localhost:8080
```

Set `OIDC_ISSUER=http://localhost:8080/default` in `packages/backend/.env` and restart the
backend. **Sign in with SSO** appears on the login page. On the mock's page, enter any username
plus, optionally, `{"email": "you@example.com", "email_verified": true, "name": "You"}`.

New users land on **Welcome**, where they create their organization and first app.

---

## Installing Guide Engine on a website

### 1. Add the snippet

Copy the snippet from **Studio → your app → Install & settings**. It contains the app's
**public key** and your Guide Engine host:

```html
<script>
(function(w,d,k){var g=w.guideEngine=w.guideEngine||{_q:[]};
['initialize','identify','openHelp','closeHelp','toggleHelp'].forEach(function(m){g[m]=g[m]||function(){g._q.push([m].concat([].slice.call(arguments)))}});
var s=d.createElement('script');s.async=1;s.src='https://guides.example.com/agent/v1/'+k+'/guides.js';d.head.appendChild(s);
})(window,document,'ge_pk_0123456789abcdef0123456789abcdef');
guideEngine.initialize({
  visitor: { id: 'USER_ID' },      // your signed-in user's id
  account: { id: 'ACCOUNT_ID' }    // optional: their company / customer id
  // helpButton: false             // hide the floating help button (use your own, see Help center)
});
</script>
```

- It loads asynchronously and queues calls until the agent arrives, so it never delays your page.
- **Single-page apps need nothing else.** The agent follows `history.pushState` /
  `replaceState`, back/forward and hash changes by itself.
- **Anonymous visitors:** omit `visitor`, and the agent keeps a random per-browser id.
- **After login:** call `guideEngine.identify({ visitor: { id }, account: { id } })`. The agent
  clears what the previous user was shown and re-evaluates.
- The site's origin must be in the app's **Websites** list. Guides never load anywhere else.

### 2. Tag the elements guides point at

```html
<button data-guide-id="invite-button">Invite teammates</button>
```

Guides reference stable `data-guide-id` values, never CSS classes, so markup refactors don't
break them. Ids may use letters, digits, `-` and `_`. A step with no anchor shows as a
centered card.

### 3. (Recommended) Require signed identity

The key in the snippet is public, so by default anyone could claim to be any visitor. That's
fine for showing tips, but not if visitor identity matters to you.

1. In **Install & settings → Signed identity**, generate a **signing secret**. Keep it on your
   server only.
2. Have your server sign each user's identity:

   ```js
   import jwt from 'jsonwebtoken';
   const token = jwt.sign(
     { visitor: { id: user.id }, account: { id: user.companyId } },
     process.env.GUIDE_ENGINE_SECRET,
     { algorithm: 'HS256', expiresIn: '1h' },
   );
   ```

3. Pass it to the page: `guideEngine.initialize({ jwt: token })`.
4. Switch on **Require signed identity**. From then on, unsigned or invalid identities get no
   guides.

### Alternative: npm packages

For bundled apps that prefer a dependency over a script tag, build the packages
(`npm run build`) and use them from your registry or `npm link`:

```ts
// Angular
import { GuideService, GuideAnchorDirective } from '@guide-engine/angular';
inject(GuideService).init({ apiBaseUrl: 'https://guides.example.com', appKey: 'ge_pk_…', visitor: { id } });
// template: <button [guideAnchor]="'invite-button'">…</button>

// Vue 3
import { GuidePlugin, vGuideAnchor } from '@guide-engine/vue';
app.use(GuidePlugin, { router, apiBaseUrl: 'https://guides.example.com', appKey: 'ge_pk_…', visitor: { id } });
app.directive('guide-anchor', vGuideAnchor);   // <button v-guide-anchor="'invite-button'">

// Anything else
import { GuideEngine, createDomRenderer } from '@guide-engine/core';
const engine = new GuideEngine();
void engine.init({ apiBaseUrl, appKey, visitor, account, jwt },
  createDomRenderer({ advanceStep: (id) => engine.advanceStep(id), dismissGuide: (id) => engine.dismissGuide(id) }));
// call engine.onRouteChange(location.pathname) on navigation, engine.identify(...) after login
```

`provideAppInitializer` needs Angular 19+. On older versions, call `init` from an
`APP_INITIALIZER` or the root component's `ngOnInit`. The packages build to CommonJS; Angular
CLI may ask you to list `@guide-engine/core` in `allowedCommonJsDependencies`.

---

## Using the Studio

Full guide: [`apps/studio/README.md`](apps/studio/README.md).

- **Organizations and apps.** Use the org switcher, then the app switcher, in the top bar. Org
  admins create apps (name + websites) on **Apps**.
- **Members.**
  - Invite people with a link (7 days, single use). If you enter an email, only that verified
    email can accept.
  - Owners and admins manage every app. Members get a per-app role:

    | App role | Can |
    |---|---|
    | viewer | read guides, pages, versions and analytics |
    | editor | + create guides, save drafts, make preview links; create pages, and edit or delete pages no live guide uses |
    | publisher | + publish, enable / disable, roll back; change the URL of a page live guides use |
    | app admin | + app settings: snippet, websites, signed identity, key rotation, app on / off |

  - Only owners can grant or remove ownership, and every org keeps at least one owner.
- **Guides.**
  - **Help center:** optionally list the guide, with a title, description, search keywords and a
    start page (required for pattern routes).
  - **Where:** a [saved page](#saved-pages) of the app, or a custom route (an exact path, or a
    pattern where `*` matches anything).
  - **Dates:** optional start and end.
  - **Audience:** all accounts, or only listed account ids.
  - **Steps:** each has a type, anchor, position, HTML content, and buttons (`next`, `dismiss`,
    `complete`).
  - **Workflow:** save a draft, preview, publish, enable. **Versions** lists the history, with
    rollback.
  - **Analytics:** event totals, plus a per-step funnel that carries across versions (step ids
    stay stable).

### Saved pages

Name the parts of your app once and reuse them in every guide, like Pendo's tagged pages.

- **Studio → Pages** lists the app's pages. Each page has a name ("Team settings"), a URL rule
  (exact `/settings/team`, or a pattern like `/projects/*`), and an optional **start page**.
  Patterns need a start page: it's the concrete URL the help center opens for guides on that page.
- **In a guide**, under *Where & when*, choose **A saved page** and pick one. You can still choose
  **A custom route** for one-off rules, and save that route as a page from there.
- **Guides follow their page.** Change a page's URL and every guide on it, live ones included,
  matches the new URL on the next page load. You don't need to republish. Because that changes
  what's live, only publishers can change the URL of a page that live guides use. Editors can
  still rename it.
- **Each version stores the page reference plus a snapshot of the page's route.** A page can't be
  deleted while a guide's live version or draft uses it; the Studio lists which guides do.
  After a page is deleted, older versions fall back to their snapshot, for example if you roll
  back to one.
- **Help start page.** The help center sends visitors to the guide's own start page if it has one,
  then the page's start page, then the page's exact URL.
- Pages belong to one application. Other apps, even in the same org, don't see them.

### Help center

A floating **Help** button sits at the bottom right and opens **"How can we help?"**, a
searchable list of guides.

**How the list is built**
- It lists the guides authors marked **List in the help center**, filtered like everything else:
  published, enabled, inside their dates, and the visitor's account allowed.
- Guides a visitor already finished stay listed: help is on demand, so they can replay any time.
- The button only appears when the visitor has at least one topic.

**Searching and choosing**
- Search matches every word in the title, description or keywords, with title matches first.
- **↑/↓** move, **Enter** starts a topic, **Esc** closes. Focus stays inside the dialog, and
  clicking outside closes it.

**Starting a guide**
- **On the guide's own page:** it starts right away.
- **Anywhere else:** the visitor gets a normal page load to the guide's **start page** with
  `?guideEngine=help:<guide id>`. The agent starts the guide on arrival and removes the
  parameter. This is the same approach as Pendo's guide permalinks.
- A plain `?guideEngine=<guide id>` link (for example from support staff) does the same for any
  help-center guide.

**Your own button.** Hide ours and call the same action from yours:

```js
guideEngine.initialize({ visitor: { id: 'USER_ID' }, helpButton: false });
document.querySelector('#my-help').addEventListener('click', () => guideEngine.openHelp());
// also: guideEngine.closeHelp(), guideEngine.toggleHelp()
```

The calls are queued like `initialize`, so they work even before the agent has loaded. In the npm
packages they're `GuideService.openHelp()` (Angular), `useGuideEngine().openHelp()` (Vue), and
`engine.openHelp()` (core).

**Settings and analytics**
- **Studio → Install & settings → Help center:** switch it on or off for the app, and set the
  button label and color.
- Guides started from the help center are tagged `source: help` on their events. The guide's
  Analytics panel shows how often that happened.

---

## How a guide is chosen and shown

1. **Startup.** The agent finds its key and API host from its own `<script src>`, then replays
   any queued `initialize` / `identify` calls.
2. **Preview links.** If the URL has `?guidePreview=<token>`, the agent asks the backend to
   verify it. If valid, it renders **only** that version, with a "Preview" badge and no
   analytics. If invalid, it carries on normally.
3. **One request** returns everything needed: `POST /v1/agent/<key>/guides` with the visitor's
   identity returns `{ enabled, guides }`. The server checks:
   - the global kill switch and the app's own switch;
   - published, enabled and in the date window;
   - the account allowlist;
   - that this visitor hasn't already dismissed or completed this version or a newer one.

   `enabled: false` stops the agent for the rest of the page's life. Any other failure shows
   nothing for that navigation (fail closed).
4. **Route matching** uses the URL **path** only: `exact` compares the whole path, and in
   `pattern` each `*` matches anything.
5. **Finding the target.** If the anchor isn't in the DOM yet, the agent retries with backoff (10
   attempts, about 16.5 s), then records `guide_error` with `target_not_found`.
6. **Rendering** happens in a Shadow DOM card, so your styles don't leak in. It follows the
   target as the page changes, including when your framework re-creates the element.
7. **Events** are batched every 5 s or 20 events, sent as `text/plain` JSON (no CORS preflight),
   and flushed on `pagehide`. Dismiss and complete are sent immediately.

---

## Identity, roles and security

| Who | Authenticates with | Gets access to |
|---|---|---|
| **Studio users** | an OIDC access token from your identity provider (identity only: `sub`, `email`, `name`), verified against its JWKS. Dev/test only: HS256 tokens from `mint-token`. | what their **memberships in our DB** allow: org role + per-app roles |
| **End users (visitors)** | the app's **public key** + the visitor/account ids the page passes in; optionally a **JWT signed with the app's secret** (required when the app enables it) | that app's active guides; writing their own events |

- **Isolation, enforced twice.**
  - Every query filters by app or org in the application.
  - **Postgres Row-Level Security** is `FORCE`d on every table. Policies read only session
    variables that the backend sets from verified credentials: the Studio user's memberships,
    or the app resolved from its key.
  - Tests check the database layer independently, including that weakening a policy makes them
    fail.
- **The database role can't bypass RLS.** The backend refuses to start if `DATABASE_URL` is a
  superuser or `BYPASSRLS` role.
- **Hard-to-probe ids.** Other organizations' ids get the same 404 as ids that don't exist.
  Unknown, malformed and rotated app keys all get one identical 404.
- **The public agent API is fenced in:**
  - CORS only for the app's own websites (fail closed when none are listed);
  - an in-process rate limit per key and client IP;
  - payload caps;
  - credentials are never sent (`credentials: 'omit'`).
- **No algorithm confusion.** Each token type is checked against its own pinned algorithms and
  key material: Studio OIDC tokens (RS/PS/ES), dev tokens (HS256 + dev secret), visitor
  identities (HS256 + per-app secret), preview links (HS256 + preview secret + audience). Every
  token must have an `exp`.
- **Content is sanitized when saved** (`sanitize-html`):
  - no scripts, styles, event handlers, iframes or SVG;
  - links must be `http`, `https` or `mailto`, and get `rel="noopener noreferrer"`;
  - images must be `http` or `https`.

  Button labels are rendered as text.
- **Published versions are immutable**, enforced by RLS.
- **Secrets at rest.** Invitation tokens are stored hashed. App signing secrets are shown once
  and stored for verification; encrypting them at rest with a KMS is a roadmap item.

---

## Configuration reference

The backend reads `packages/backend/.env` (see `.env.example`). Misconfiguration stops the
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
| `TRUST_PROXY` | `false` | Set `true` behind a reverse proxy so rate limiting sees real client IPs. |
| `AGENT_BUNDLE_PATH` | `packages/agent/dist/guide-engine.js` | Where the backend reads the agent script from. |

The Studio has no runtime config. It calls `/api/*` on its own origin: the dev server proxies
that to `localhost:3000` (`apps/studio/proxy.conf.json`), and in production a reverse proxy
must do the same.

---

## API reference

JSON throughout. Studio responses that are database rows use snake_case.

### Public

| Method & path | Notes |
|---|---|
| `GET /health` | `{ ok: true }` |
| `GET /auth/config` | `{ oidc: { issuer, clientId, scope } \| null, tokenPaste }`: how the Studio signs in. |
| `GET /agent/v1/:key/guides.js` | The agent script. The same static file for every key. |

### Agent API (public app key; CORS for the app's websites)

Bodies may be `text/plain` or `application/json`. Each one carries an identity:
`{ visitor?: { id }, account?: { id } | null, jwt? }`.

| Method & path | Body → response |
|---|---|
| `POST /v1/agent/:key/guides` | identity → `{ enabled, guides: [{ id, versionId, name, type, steps, routeMatch }] }` |
| `POST /v1/agent/:key/events` | identity + `{ events: [{ guideId, guideVersionId, stepId?, sessionId, eventType, occurredAt, metadata? }] }` (1–100) → `202 { accepted }` |
| `POST /v1/agent/:key/preview` | `{ token }` → the previewed guide with `preview: true` |
| `POST /v1/agent/:key/help` | identity → `{ enabled, button: { label, color }, guides: [{ …guide, help: { title, description, keywords, startPath } }] }`. The help-center list; not route-filtered, and includes guides the visitor already finished. |

`eventType` is one of `guide_shown`, `guide_step_viewed`, `guide_step_completed`,
`guide_dismissed`, `guide_completed`, `guide_error`, `survey_response`.

### Studio API (`/v1`, bearer token from OIDC, or a dev token)

| Method & path | Who | Notes |
|---|---|---|
| `GET /me` | anyone signed in | `{ user, orgs: [{ id, name, role, apps: [{ id, name, role }] }] }`. Creates the user on first sign-in. |
| `POST /orgs` | anyone | `{ name, app: { name, websites[] } }` → you become owner. |
| `GET` / `PATCH /orgs/:orgId` | member / admin | `PATCH` takes `{ name }`. |
| `GET` / `POST /orgs/:orgId/apps` | member / admin | members see only the apps they can access. |
| `GET` / `PATCH /apps/:appId` | viewer / app_admin | `GET` includes `snippet`. `PATCH` takes `{ name?, websites?, identityMode?, enabled?, helpEnabled?, helpButtonLabel?, helpButtonColor? }`; the color must be hex. |
| `POST /apps/:appId/rotate-key` | app_admin | New public key; old snippets stop working. |
| `POST /apps/:appId/signing-secret` | app_admin | `{ secret }`, shown once. |
| `GET /orgs/:orgId/members` | member | `[{ userId, email, name, orgRole, appRoles }]` |
| `PATCH` / `DELETE /orgs/:orgId/members/:userId` | admin (or yourself, to leave) | `PATCH` takes `{ orgRole?, appRoles?: { appId: role \| null } }`. |
| `GET` / `POST /orgs/:orgId/invitations` | admin | `POST` takes `{ email?, orgRole: admin\|member, appRoles }` → `{ …, token }`. |
| `DELETE /orgs/:orgId/invitations/:id` | admin | revoke |
| `GET /invitations/:token`, `POST /invitations/:token/accept` | the link holder | |
| `GET` / `POST /apps/:appId/guides` | viewer / editor | |
| `GET /apps/:appId/guides/:id` | viewer | Guide + `versions[]`. The version with `published_at: null` is the draft. |
| `PUT /apps/:appId/guides/:id/draft` | editor | `VersionBody` |
| `POST /apps/:appId/guides/:id/publish` | publisher | `VersionBody`, or empty to publish the draft as-is. |
| `PATCH /apps/:appId/guides/:id/flag` | publisher | `{ enabled }` |
| `POST /apps/:appId/guides/:id/rollback/:n` | publisher | Published versions only. |
| `POST /apps/:appId/guides/:id/preview-token` | editor | `{ versionId }` → `{ token, url, expiresAt }` |
| `GET /apps/:appId/guides/:id/analytics` | viewer | `{ counts[], steps[], startedFromHelp }` |
| `GET` / `POST /apps/:appId/pages` | viewer / editor | List (by name, with `usage: { guides, live }`) or create `{ name, routeMatch: { type, value }, startPath? }`. A pattern needs `startPath`. Names are unique per app, ignoring case. |
| `GET /apps/:appId/pages/:pageId` | viewer | The page + `guides: [{ id, name, live, draft }]` (live versions and drafts on it). |
| `PUT /apps/:appId/pages/:pageId` | editor; publisher if it moves live guides | Same body as `POST`. Guides on the page follow at once. |
| `DELETE /apps/:appId/pages/:pageId` | editor | `409 page_in_use` (with `details.guides`) while a live version or draft uses it. |

A `VersionBody` is:

```
{ steps: [{ id?, order, type, targetSelector?, content, position?, actions: [{ label, action }] }],
  pageId? | routeMatch?: { type, value },   // exactly one
  startAt?, endAt?, accountIds?: string[] | null,
  help?: { title, description?, keywords?: string[], startPath? } | null }
```

- `pageId` is one of the app's saved pages (`400 unknown_page` otherwise); the version then follows
  the page's URL. `routeMatch` is a custom route.
- `targetSelector` must be `[data-guide-id="…"]`.
- `content` is at most 20,000 characters and is sanitized.
- `accountIds` is null for everyone, or 1–500 ids.
- `help` is null when the guide isn't in the help center. Its text is plain, and `startPath` must
  be a path on your own site. It defaults to the page's start page, then to an exact route; custom
  pattern routes require one.

**Errors** are `{ error, details? }`:

| Status | Codes |
|---|---|
| 400 | `invalid_body`, `empty_content_after_sanitize`, `no_draft_to_publish`, `signing_secret_required`, `unknown_app`, `unknown_page` |
| 401 | `missing_auth`, `invalid_token`, `visitor_required`, `signed_identity_required`, `identity_invalid` |
| 403 | `forbidden`, `origin_not_allowed`, `invalid_preview_token`, `invitation_email_mismatch` |
| 404 | `not_found`, including other organizations' resources and unknown keys |
| 409 | `last_owner`, `already_member`, `page_name_taken`, `page_in_use` |
| 410 | `invitation_used`, `invitation_expired` |
| 413 | `payload_too_large` |
| 429 | `rate_limited` |
| 503 | `preview_not_configured` |

---

## Data model and migrations

| Table | Purpose |
|---|---|
| `organization` | A customer workspace (`created_by`). |
| `application` | `public_key`, `allowed_origins`, `identity_mode`, `signing_secret`, `enabled` (the app switch), and the help center: `help_enabled`, `help_button_label`, `help_button_color`. |
| `studio_user` | People who use the Studio, keyed by (`oidc_issuer`, `oidc_sub`); created on first sign-in. |
| `org_member` / `app_member` | Org role (owner / admin / member) and per-app role (viewer → app_admin). |
| `invitation` | Invite links: hashed token, org role, app roles, expiry, single use. |
| `app_page` | Saved pages per app: `name`, `match_type`, `match_value`, `start_path`. |
| `guide` / `guide_version` | Guides per app. Numbered versions hold steps (JSONB), `page_id` (a saved page) and/or `route_match` (a custom route, or the page's route snapshot), dates, `account_ids` and `help` (the help-center listing). `published_at IS NULL` means the draft, at most one per guide. Published rows are immutable. |
| `guide_event` | Analytics: app, guide, version, step, `visitor_id`, `account_id`. |
| `user_guide_state` | Per (app, visitor, guide): dismissed or completed, plus `last_seen_version`. |
| `system_config` | The global kill switch (`guide_engine_enabled`). |
| `active_guide` (view) | Published, enabled guides inside their date window, with `route_match` resolved through the saved page when there is one (`security_invoker`). |

| Migration | What it does |
|---|---|
| `001`–`004` | The original OCLC-era tenant schema and its RLS hardening, drafts and platform admins (kept, never edited). |
| `005_organizations_apps.sql` | Converts that schema into orgs and apps. Each former tenant becomes an org with a "Default app"; its events keep the old tenant as their `account_id`. Global guides move to a "Migrated global guides" org. Then every RLS policy is rebuilt on session variables. |
| `006_help_center.sql` | Adds `guide_version.help` and the per-app help-center settings (the button color is CHECK-limited to a hex value). |
| `007_app_pages.sql` | Adds saved pages (`app_page`, with RLS), `guide_version.page_id`, and makes `active_guide` resolve routes through pages. |

---

## Testing

```bash
npm run db:up && npm test                 # every workspace
npm test --workspace=packages/backend     # real Postgres (DB guide_engine_test, rebuilt each run)
npm test --workspace=packages/core        # engine: vitest + jsdom
npm test --workspace=packages/agent       # snippet agent: queue replay, SPA navigation, double-load
npm test --workspace=apps/studio          # Studio components and services
```

| Suite | Tests | Covers |
|---|---|---|
| **Backend** | 143 | self-serve orgs; apps and settings; the role matrix; invitations; members; org/app isolation through the API **and directly in RLS** (including replaying the owner bootstrap and forging memberships); the agent API (origins, keys, identity modes, account targeting, kill switches, events and per-visitor state, preview); the guide lifecycle; sanitization; stable step ids; analytics; OIDC (a local JWKS server, algorithm confusion); and migration 005's data conversion |
| **Core** | 53 | includes the help widget (search, keyboard, safe rendering) and help launches (same page, other page, arrival, shared links) |
| **Agent** | 6 | includes `openHelp` queued before load |
| **Studio** | 12 | |

Type-checking is part of every `test` script, with strict TypeScript throughout.

---

## Deploying

There's no pipeline in this repo. This is the checklist:

**Database**

- [ ] Postgres **15+**, with an app role that is `NOSUPERUSER NOBYPASSRLS` and owns the database
  (see `docker/init.sql`).
- [ ] Run migrations as that role.

**Backend**

- [ ] `NODE_ENV=production`, with no `JWT_SECRET` needed. Set `PUBLIC_API_URL` to the public
  https URL, and a strong `PREVIEW_TOKEN_SECRET`.
- [ ] Behind HTTPS, with `TRUST_PROXY=true` if there's a proxy in front.
- [ ] Run it with `npm run build && node packages/backend/dist/index.js`, giving settings as
  environment variables.
- [ ] The **agent script** is served at `/agent/v1/<key>/guides.js`. It's a static, cacheable
  file, so a CDN in front of that path is a drop-in.

**Identity provider**

- [ ] A public SPA client (`OIDC_STUDIO_CLIENT_ID`).
- [ ] Redirect URI `https://<studio>/auth/callback`; post-logout URI `https://<studio>/login`.
- [ ] JWT access tokens with `aud` = `OIDC_AUDIENCE`.

**Studio**

- [ ] Build it with `npm run build --workspace=apps/studio`, which outputs
  `apps/studio/dist/studio/browser`.
- [ ] Serve it statically with an SPA fallback, and proxy `/api/*` to the backend, removing the
  `/api` prefix.

**Scale**

- [ ] The rate limiter and the app lookup cache are per process. That's fine for one instance;
  a shared store is needed before running several (see the roadmap).

Never run the mock OIDC provider (`docker compose --profile sso`) in a real environment.

---

## Operations

- **Turn an app off:** use the **Guides on/off** switch in that app's settings.
- **Turn guides off everywhere** (global kill switch, as a database operator):
  ```sql
  UPDATE system_config SET value = 'false', updated_at = now() WHERE key = 'guide_engine_enabled';
  ```
- **A key leaked somewhere unexpected:** **Rotate public key** in the app's settings, then
  update the snippet.
- **Reset a visitor's dismissal**, as a database operator:
  ```sql
  DELETE FROM user_guide_state WHERE app_id = '<app>' AND visitor_id = '<visitor>' AND guide_id = '<guide>';
  ```
- **Scripts** (in `packages/backend`, after `npm run build`; development only unless noted):

  | Command | Purpose |
  |---|---|
  | `npm run migrate` | Apply pending migrations (any environment). |
  | `npm run seed` | Dev org + app, `apps/demo/.env.local`, and a Studio token. |
  | `npm run mint-token -- --sub <id> [--email <e>] [--name <n>] [--ttl 8h]` | A dev Studio sign-in token. |
  | `npm run sign-identity -- --secret <ge_sk_…> --visitor <id> [--account <id>]` | Sign a visitor identity, as a customer's server would. |

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
| Demo shows "No app key yet" | Run `npm run seed --workspace=packages/backend` and restart the demo dev server. |

**If a guide doesn't appear**, check in order:

1. Is it **published** (Versions shows `live`) **and Enabled**? Is the app switched on?
2. Does the **route** match the URL path?
3. Is now inside the start and end dates?
4. Is the visitor's **account** in the audience, if one is set?
5. Has this visitor already dismissed or completed this version? Publish a newer one, or reset
   their state.
6. Is the element on the page with exactly that `data-guide-id`? A missing one shows up as
   `guide_error` in Analytics after about 16 s.
7. In the browser's Network tab, what did `POST /v1/agent/<key>/guides` return?

---

## Known gaps and roadmap

- **"back" buttons do nothing yet.** The Studio offers the action, but the renderer doesn't handle
  it.
- **Hash-based routers** (`/#/route`) aren't matched. Route matching uses `location.pathname`.
- **Rate limiting and the app cache are per process.** They need a shared store (e.g. Postgres or
  Redis) before horizontal scaling.
- **Signing secrets are stored in plaintext**, for HS256 verification. Encrypting them at rest
  with a KMS, or supporting customer JWKS (RS256), is on the roadmap.
- **Invites are links you copy.** There's no email sending.
- **Analytics have no per-account or per-visitor breakdown** in the Studio yet.
- **The global kill switch has no UI.** It's changed with SQL.
- **Shared `?guideEngine=` links** work for help-center guides only.
- **Help-center opens and searches aren't tracked** yet. Only guides started from it are.
- **Deferred:** metadata segments, surveys, i18n, rollout percentages, cross-app guides, staging
  environments, and a visual point-and-click designer.
