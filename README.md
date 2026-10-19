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

**Docs site:** https://mohanvegi4.github.io/guide/ is built from this README and
[`apps/studio/README.md`](apps/studio/README.md). Legal templates for running Guide Engine as a
hosted service (terms, privacy policy, DPA, subprocessors) are in [`docs/legal/`](docs/legal/).

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
   - [Guide Engine administration](#guide-engine-administration)
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
docker/              init.sql (non-superuser app role), keycloak/ (the realm Keycloak imports)
docker-compose.yml   Postgres 16 (:5433); Keycloak (:8081, profile "sso")
deploy/              single-host staging/production: compose, Caddyfile, Keycloak realm rendering
.github/workflows/   CI: build, migrate, test, Docker images
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

1. **Demo site:** open `/dashboard`. The seeded five-step **Welcome tour** starts (a welcome
   card, then tooltips on Projects, Invite teammates, the sign-in box and Help). Finish or skip
   it and it won't show again for that visitor; replay it any time from **? Help**. Use the
   "Sign in as" box to switch visitor and account, which exercises `guideEngine.identify()`.
2. **Studio:** paste the token `seed` printed (see [Studio login details](#studio-login-details)). Open **Demo site → Guides → Welcome tour** to see
   how it's built: it lives on the saved page **Dashboard** (see **Pages**), each step points
   at a `data-guide-id` anchor in `apps/demo/index.html`, and **Analytics** shows the funnel.
   Create your own guide the same way, then **Publish** and **Enable**.

### Studio login details

The Studio runs at **http://localhost:4300**. In development you either paste a token, or sign
in through the local Keycloak with one of its test users.

| | Developer sign-in (paste a token) | Sign in with SSO (Keycloak) |
|---|---|---|
| When | Default; no extra setup | After `npm run idp:up` and `OIDC_ISSUER=http://localhost:8081/realms/guide-engine` in `packages/backend/.env` (restart the backend) |
| User | **Dev Admin** (`dev-admin@example.com`), owner of **Demo Org** / **Demo site** | `olivia` (Olivia Owner, `olivia@acme.test`), `eddie` (Eddie Editor) or `root` (Guide Engine Admin) |
| Credentials | The token `npm run seed` prints (valid 8 h) | Password = username (`olivia` / `olivia`, …). Admin console at http://localhost:8081, `admin` / `admin` |
| Where | Login page → **Developer sign-in (paste a token)** → paste → **Sign in** | Login page → **Sign in with SSO** → Keycloak's form |

Notes:
- A new token for Dev Admin, or for any other dev user (new users start with no organization):
  ```bash
  npm run mint-token --workspace=packages/backend -- --sub dev-admin --email dev-admin@example.com --name "Dev Admin"
  ```
- Each Keycloak user is one Studio user, so `olivia` keeps her organizations across sign-ins.
  Add more people in the Keycloak admin console (realm **guide-engine → Users**) to try the
  roles, and invite them from **Members**. `root` is meant to become the platform admin.
- SSO users are *not* members of the seeded Demo Org (identity comes from the provider,
  memberships from our database). A new SSO user lands on **Welcome** to create their own
  organization, or accepts an invitation link from Dev Admin.
- Production: set `OIDC_ISSUER` to your real provider; the token login is disabled outside
  development and test.
- To administer Guide Engine itself, give your own user the platform-admin flag: see
  [Guide Engine administration](#guide-engine-administration).

```bash
npm run idp:up      # Keycloak on http://localhost:8081 with the guide-engine realm imported
```

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

For bundled apps that prefer a dependency over a script tag, three packages are published to
npm, always together at one version (currently **0.2.0**; see [CHANGELOG.md](CHANGELOG.md)):

| Package | For |
|---|---|
| [`@guide-engine/core`](packages/core/README.md) | any framework: the engine, DOM renderer and help center |
| [`@guide-engine/angular`](packages/angular-wrapper/README.md) | Angular 17–21: `GuideService`, `GuideAnchorDirective`, `GuideModule` |
| [`@guide-engine/vue`](packages/vue-wrapper/README.md) | Vue 3: `GuidePlugin`, `useGuideEngine()`, `vGuideAnchor` |

```sh
npm install @guide-engine/core            # plus @guide-engine/angular or @guide-engine/vue
```

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
  createDomRenderer({
    advanceStep: (id) => engine.advanceStep(id),
    previousStep: (id) => engine.previousStep(id),
    dismissGuide: (id) => engine.dismissGuide(id),
  }));
// call engine.onRouteChange() on navigation (or pass the route, e.g. engine.onRouteChange('/team')),
// engine.identify(...) after login
```

`provideAppInitializer` needs Angular 19+. On older versions, call `init` from an
`APP_INITIALIZER` or the root component's `ngOnInit`. The packages build to CommonJS; Angular
CLI may ask you to list `@guide-engine/core` in `allowedCommonJsDependencies`.

**Angular packaging limitation.** `@guide-engine/angular` is compiled with plain `tsc`, not
ng-packagr, so it carries no Ivy partial-compilation metadata and Angular's AOT compiler (the
default build) can't compile its service and directive from the published output. Either copy
the three files of [`packages/angular-wrapper/src`](packages/angular-wrapper/src) into your app
and let its compiler build them (recommended, they're about 100 lines over `@guide-engine/core`),
or add `import '@angular/compiler'` to `main.ts` for JIT. Details in the
[package README](packages/angular-wrapper/README.md#packaging-limitation).

**Releasing.** A pushed tag `vX.Y.Z` publishes the three packages and creates the GitHub Release
([`.github/workflows/release.yml`](.github/workflows/release.yml)); `npm run version:set X.Y.Z`
bumps them together. See [RELEASING.md](RELEASING.md).

---

## Using the Studio

Full guide: [`apps/studio/README.md`](apps/studio/README.md).

- **Organizations and apps.** Use the org switcher, then the app switcher, in the top bar. Org
  admins create apps (name + websites) on **Apps**.
- **Members.**
  - Invite people with a link (7 days, single use). If you enter an email, only that verified
    email can accept, and when the backend has mail configured (`SMTP_URL`, `MAIL_FROM`,
    `STUDIO_URL`) the invitation is emailed to them; the link is still shown as a fallback.
  - Owners and admins manage every app. Members get a per-app role:

    | App role | Can |
    |---|---|
    | viewer | read guides, pages, versions and analytics |
    | editor | + create guides, save drafts, make preview links; create pages, and edit or delete pages no live guide uses |
    | publisher | + publish, enable / disable, roll back; change the URL of a page live guides use |
    | app admin | + app settings: snippet, websites, signed identity, key rotation, app on / off |

  - Only owners can grant or remove ownership, and every org keeps at least one owner.
  - Owners can open time-boxed, read-only **support access** for Guide Engine staff; see
    [Guide Engine administration](#guide-engine-administration).
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
    stay stable). **By account** adds the 50 accounts shown the guide most (shown, done,
    dismissed, distinct visitors; "No account" is unidentified visitors). The **Guides** page
    starts with an overview: shown, completed and completion rate per guide, and distinct
    visitors and accounts over the last 30 days.

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

A floating **Help** button (bottom right by default; the corner is an app setting) opens
**"How can we help?"**, a searchable list of guides.

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
- **Anywhere else:** the list says so ("Opens on `/team`"), and choosing the topic first asks
  **"Go to another page?"** with *Take me there* / *Stay here*, since leaving is a page load that
  can drop unsaved work. *Stay here* (or Esc) returns to the list. On *Take me there* the visitor
  gets a normal page load to the guide's **start page** with `?guideEngine=help:<guide id>`; the
  agent starts the guide on arrival and removes the parameter. This is the same approach as
  Pendo's guide permalinks, plus the confirmation.
- **Hash-routed apps** (Routing set to *Hash* in the app's settings) show the start page as
  `/#/team`, and the visitor is sent to `/?guideEngine=help:<guide id>#/team`: the route goes in
  the fragment and the launch parameter stays in the real query string, where the agent reads it.
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
- **Studio → Install & settings → Help center:** switch it on or off for the app; set the
  button label and color; and pick where the topic list opens: a **corner** (bottom right by
  default, or bottom left, top right, top left) or the **center of the screen**. The
  **"Go to another page?"** dialog always appears in the same place as the list, and the button
  sits in the chosen corner (bottom right when the list is centered).
- Guides started from the help center are tagged `source: help` on their events. The guide's
  Analytics panel shows how often that happened.
- **Help center analytics** (the card under the help-center settings; viewers can read it):
  over the last 30 days, how often the panel was opened (`help_opened`), how many searches were
  made (`help_searched`, recorded once typing pauses for 500 ms on a query of at least two
  characters, with the query and how many topics it matched), the 20 most common queries with
  the average number of topics each found (a query that finds nothing is a topic worth adding),
  and how many guides were started from the help center. Opening the list again after
  *Stay here* doesn't count as a new open. These events belong to no guide, so they're an
  app-level view rather than part of a guide's analytics.

---

## How a guide is chosen and shown

1. **Startup.** The agent finds its key and API host from its own `<script src>`, then replays
   any queued `initialize` / `identify` calls. The script is the same file for every key, served
   with a content-hash `ETag` so browsers and a CDN revalidate cheaply (see
   [Deploying](#the-agent-script-caching-and-rollbacks)); `guideEngine.version` says which build
   is on the page.
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
4. **Route matching** uses the URL **path** only (query strings and fragments are ignored):
   `exact` compares the whole path, and in `pattern` each `*` matches anything. For an app whose
   **Routing** setting is *Hash* (`/#/settings/team`), the path inside the fragment is matched
   instead (`/settings/team`; a fragment-less page is `/`), the agent re-evaluates on every
   `hashchange`, and page URLs are written the same way as for path routing. The server says
   which mode applies in every `/guides` and `/help` response (`routeMode`).
5. **Finding the target.** If the anchor isn't in the DOM yet, the agent retries with backoff (10
   attempts, about 16.5 s), then records `guide_error` with `target_not_found`.
6. **Rendering** happens in a Shadow DOM card, so your styles don't leak in. A targeted step
   puts the focus on its element: it's scrolled into view if off-screen, and **spotlighted**: a
   ring around it with the rest of the page dimmed (the element stays clickable). The card and
   the ring follow the target as the page changes, including when your framework re-creates
   the element.
7. **Events** are batched every 5 s or 20 events, sent as `text/plain` JSON (no CORS preflight),
   and flushed on `pagehide`. Dismiss and complete are sent immediately.
8. **Errors.** Fail silent also means the agent reports what it swallowed: an exception in
   startup, route evaluation, rendering or a click handler goes to
   `POST /v1/agent/<key>/errors` with its message, stack, the page URL and the agent version.
   Sampled client-side (10 %, at most 5 per page load, `keepalive`) and capped server-side
   (1000 per app per hour, beyond which reports are acknowledged and dropped), so a page that
   throws in a loop can't flood anything. The newest show up under **Recent agent errors** in the
   app's settings; the visitor never sees any of it.

---

## Identity, roles and security

| Who | Authenticates with | Gets access to |
|---|---|---|
| **Studio users** | an OIDC access token from your identity provider (identity only: `sub`, `email`, `name`), verified against its JWKS. Dev/test only: HS256 tokens from `mint-token`. | what their **memberships in our DB** allow: org role + per-app roles |
| **End users (visitors)** | the app's **public key** + the visitor/account ids the page passes in; optionally a **JWT signed with the app's secret** (required when the app enables it) | that app's active guides; writing their own events |
| **Platform admins** (you, running Guide Engine) | a Studio sign-in whose `studio_user` row carries `platform_admin` | service administration across all customers, never their guide content; a customer's organization read-only, only while that customer has granted **support access** |

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
- **Customers' content stays closed to Guide Engine staff** unless the customer opens it: see
  [Guide Engine administration](#guide-engine-administration).
- **Secrets at rest.** Invitation tokens are stored hashed. App signing secrets are shown once
  and stored for verification; encrypting them at rest with a KMS is a roadmap item.
- **Your data.** An organization **owner** can take everything out and delete it, from
  **Members → Danger zone** (or `GET /v1/orgs/:orgId/export` and `DELETE /v1/orgs/:orgId`):
  - **Export** is one JSON file: the organization, its apps (every setting, never a signing
    secret), saved pages, guides with every version, members and their roles, pending
    invitations (without their link tokens), and lifetime shown / completed / dismissed totals per
    guide. Raw `guide_event` rows are **not** included because they carry your end users' visitor
    and account ids; a platform operator can extract them from the database if a data-subject
    request needs them.
  - **Delete** (type the organization's name to confirm) removes the organization with its apps,
    guides and versions, pages, events, visitor state, agent errors, memberships, invitations and
    the support access log, in one transaction. App admins can delete a single app the same way
    (`DELETE /v1/apps/:appId`). What is kept: nothing but the Studio user accounts, which may
    belong to other organizations. Platform admins can perform the deletion on a customer's
    request (`DELETE /v1/platform/orgs/:orgId`, logged).
  - **Retention:** events and agent errors older than `EVENT_RETENTION_DAYS` are deleted daily
    anyway (see [Operations](#operations)); everything else is kept until the customer deletes it.

### Guide Engine administration

Modelled on how Pendo separates its own staff from its customers' admins.

**Platform admins** are the people who run this Guide Engine. The flag lives on `studio_user`
and is never self-granted. The first one is set by the database owner:

```sql
UPDATE studio_user SET platform_admin = TRUE WHERE email = 'you@your-company.com';
```

(The person must have signed in once.) From then on, admins grant and revoke each other on the
Studio's **Administration** page; nobody can remove themselves.

**What a platform admin can do without any customer's consent** (service administration):
list every organization with its owners, member/app/guide counts and events in the last 30
days; **suspend** an organization (its apps serve no guides; members see a banner) and lift it;
disable one app; flip the **global kill switch**; manage platform admins. The database policies
behind this (`*_platform_select`) expose organizations, apps, members, guide names and event rows
for counting. They do **not** expose `guide_version`, `app_page` or `user_guide_state`: an admin
can see *that* a customer has 12 guides, not what they say.

**Support access** is how a customer lets support look inside, like Pendo's *Pendo Support
Access* setting:
- An organization **owner** opens it from **Members → Guide Engine support access**, for 1, 7,
  30 or at most 90 days. It's off by default and closes by itself on the date chosen, or
  earlier with **Close now**.
- While it's open, a platform admin can **Open (read-only)** the organization from the
  Administration page. The Studio enters *support mode*: the ordinary pages work as a viewer,
  with a banner naming the organization and the expiry.
- Enforcement is in the backend and the database, not the UI. The `X-Support-Org` header
  selects a support session (`withSupportSession`), which is shaped like a viewer of that
  organization, runs in a **READ ONLY** transaction (Postgres refuses any write), and answers
  404 when the window isn't open or the organization is suspended.
- **Every request** under support access is written to `support_access_log` with who, when and
  what, before the read happens. The organization's admins see the log in the same card.

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
| `RATE_LIMIT_STORE` | `memory` (`postgres` in production) | Where that budget is counted: in the process, or in Postgres so every replica shares it. **Must be `postgres` in production.** |
| `TRUST_PROXY` | `false` | Set `true` behind a reverse proxy so rate limiting sees real client IPs. |
| `SECRETS_KEY` | — | 32 bytes (hex or base64) that encrypt apps' signing secrets at rest (AES-256-GCM). **Required in production.** After turning it on, `npm run encrypt-secrets` re-writes secrets stored earlier. |
| `EVENT_RETENTION_DAYS` | `400` in production, off elsewhere | The daily job deletes `guide_event` rows older than this. `0` turns it off. |
| `LOG_LEVEL` | `info` (`silent` in test) | Lowest level written to the JSON log on stdout: `trace`, `debug`, `info`, `warn`, `error`, `fatal`. |
| `METRICS_TOKEN` | — | Bearer token that `GET /metrics` requires. Unset: the endpoint is open in development/test and absent (404) elsewhere. |
| `SENTRY_DSN` | — | Optional. Set to report 5xx errors to Sentry (tagged with the request id, route and status; `environment` = `NODE_ENV`, `release` = the backend version). |
| `RUN_MIGRATIONS` | `true` | Container only: apply pending migrations before starting. `false` when a release step runs `node packages/backend/dist/migrate.js`. |
| `AGENT_BUNDLE_PATH` | `packages/agent/dist/guide-engine.js` | Where the backend reads the agent script from. |
| `SMTP_URL` | — | Invitation emails: `smtp://user:pass@host:587` or `smtps://…`. Unset: invitations are links to copy. `json://` logs messages instead of sending (development/tests). |
| `MAIL_FROM` | — | Required with `SMTP_URL`: the From header, e.g. `Guide Engine <no-reply@example.com>`. |
| `STUDIO_URL` | — | The Studio's public origin (`https://studio.example.com`), for links in emails. Invitations are only emailed when it is set. |

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
| `GET /auth/config` | `{ oidc: { issuer, clientId, scope } \| null, tokenPaste, mailEnabled }`: how the Studio signs in, and whether invitations are emailed. |
| `GET /agent/v1/:key/guides.js` | The agent script. The same static file for every key, with a strong `ETag` (its content hash), `Cache-Control: public, max-age=300, s-maxage=3600, stale-while-revalidate=86400` and `Cross-Origin-Resource-Policy: cross-origin`; `If-None-Match` is answered with `304`. |
| `GET /agent/v1/version` | `{ version, hash }` of the script this backend serves (no key): a cheap uptime and deploy check. `Cache-Control: no-store`. |

### Agent API (public app key; CORS for the app's websites)

Bodies may be `text/plain` or `application/json`. Each one carries an identity:
`{ visitor?: { id }, account?: { id } | null, jwt? }`.

| Method & path | Body → response |
|---|---|
| `POST /v1/agent/:key/guides` | identity → `{ enabled, routeMode, guides: [{ id, versionId, name, type, steps, routeMatch }] }`. `routeMode` is `path` or `hash`. |
| `POST /v1/agent/:key/events` | identity + `{ events: [{ guideId, guideVersionId, stepId?, sessionId, eventType, occurredAt, metadata? }] }` (1–100) → `202 { accepted }`. Help-center events (`help_opened`, `help_searched`) carry no `guideId` / `guideVersionId`; a `help_searched` event's `metadata` is `{ query, results }` (the query is cut to 200 characters; other keys are dropped). |
| `POST /v1/agent/:key/preview` | `{ token }` → the previewed guide with `preview: true` |
| `POST /v1/agent/:key/errors` | `{ message (1–500 chars), stack? (≤ 4000), url? (≤ 2000), agentVersion? }` → `202 { accepted }`. `accepted: false` once the app already has 1000 reports in the last hour. |
| `POST /v1/agent/:key/help` | identity → `{ enabled, routeMode, button: { label, color, position }, guides: [{ …guide, help: { title, description, keywords, startPath } }] }`. The help-center list; not route-filtered, and includes guides the visitor already finished. |

`eventType` is one of `guide_shown`, `guide_step_viewed`, `guide_step_completed`,
`guide_dismissed`, `guide_completed`, `guide_error`, `survey_response`, `help_opened`,
`help_searched`.

### Studio API (`/v1`, bearer token from OIDC, or a dev token)

| Method & path | Who | Notes |
|---|---|---|
| `GET /me` | anyone signed in | `{ user: { id, email, name, platformAdmin }, orgs: [{ id, name, role, suspendedAt, apps: [{ id, name, role }] }] }`. Creates the user on first sign-in. |
| `GET` / `PUT` / `DELETE /orgs/:orgId/support-access` | admin / owner / owner | `PUT` takes `{ days }` (1–90) → `{ active, until, grantedBy, maxDays, log[] }`. |
| `GET /support-context` | platform admin, with `X-Support-Org: <orgId>` | The organization as a viewer sees it, if support access is open; otherwise 404. Any `/v1` org/app read works the same way under that header (read-only, logged). |
| `GET /platform/orgs`, `GET /platform/orgs/:orgId` | platform admin | Organizations with owners and usage; one with its apps (each with `usage: { guides, events30d, errors24h }`). 403 for everyone else. |
| `PUT /platform/orgs/:orgId/suspension` | platform admin | `{ suspended }` |
| `DELETE /platform/orgs/:orgId` | platform admin | `{ confirmName }`: the same deletion an owner can do, for a customer's deletion request; logged at `warn` with the admin's user id. |
| `PATCH /platform/apps/:appId` | platform admin | `{ enabled }` |
| `GET` / `PUT /platform/kill-switch` | platform admin | `{ enabled }` |
| `GET` / `PUT /platform/admins` | platform admin | `PUT` takes `{ email, platformAdmin }`; `400 unknown_user` / `cannot_revoke_self`. |
| `POST /orgs` | anyone | `{ name, app: { name, websites[] } }` → you become owner. |
| `GET` / `PATCH /orgs/:orgId` | member / admin | `PATCH` takes `{ name }`. |
| `GET /orgs/:orgId/export` | owner | The organization's data as a JSON download (`Content-Disposition: attachment; filename="guide-engine-<org-slug>-<date>.json"`): `{ format, formatVersion, exportedAt, organization, members[], invitations[], apps: [{ …, pages[], guides: [{ …, analytics: { shown, completed, dismissed }, versions[] }] }], notes[] }`. Never signing secrets, invitation tokens or raw events. |
| `DELETE /orgs/:orgId` | owner | `{ confirmName }` must equal the organization's name (`400 confirmation_mismatch`). Deletes the organization and everything in it; `204`. |
| `GET` / `POST /orgs/:orgId/apps` | member / admin | members see only the apps they can access. |
| `GET` / `PATCH /apps/:appId` | viewer / app_admin | `GET` includes `snippet`. `PATCH` takes `{ name?, websites?, identityMode?, enabled?, helpEnabled?, helpButtonLabel?, helpButtonColor?, helpPosition?, routeMode? }`; the color must be hex, the position one of `bottom-right`, `bottom-left`, `top-right`, `top-left`, `center`, the route mode `path` or `hash` (returned as `route_mode`). |
| `GET /apps/:appId/help-analytics` | viewer | Help-center usage over the last 30 days: `{ days, opens, searches, guidesStarted, topQueries: [{ query, count, avgResults }] }` (top 20 queries, normalized to lower case). |
| `POST /apps/:appId/rotate-key` | app_admin | New public key; old snippets stop working. |
| `DELETE /apps/:appId` | app_admin | `{ confirmName }` must equal the app's name. Deletes the app with its guides, pages, events, visitor state, agent errors and grants; `204`. |
| `POST /apps/:appId/signing-secret` | app_admin | `{ secret }`, shown once. |
| `GET /apps/:appId/errors?limit=50` | viewer | The newest agent errors (1–200): `[{ id, message, stack, agentVersion, url, occurredAt }]`. |
| `GET /orgs/:orgId/members` | member | `[{ userId, email, name, orgRole, appRoles }]` |
| `PATCH` / `DELETE /orgs/:orgId/members/:userId` | admin (or yourself, to leave) | `PATCH` takes `{ orgRole?, appRoles?: { appId: role \| null } }`. |
| `GET` / `POST /orgs/:orgId/invitations` | admin | `POST` takes `{ email?, orgRole: admin\|member, appRoles }` → `{ …, token, emailSent }`. With an `email` and mail configured, the link is emailed; `emailSent` is false when it wasn't (no mail set up, or sending failed — the request still succeeds). |
| `DELETE /orgs/:orgId/invitations/:id` | admin | revoke |
| `GET /invitations/:token`, `POST /invitations/:token/accept` | the link holder | |
| `GET` / `POST /apps/:appId/guides` | viewer / editor | |
| `GET /apps/:appId/guides/:id` | viewer | Guide + `versions[]`. The version with `published_at: null` is the draft. |
| `PUT /apps/:appId/guides/:id/draft` | editor | `VersionBody` |
| `POST /apps/:appId/guides/:id/publish` | publisher | `VersionBody`, or empty to publish the draft as-is. |
| `PATCH /apps/:appId/guides/:id/flag` | publisher | `{ enabled }` |
| `POST /apps/:appId/guides/:id/rollback/:n` | publisher | Published versions only. |
| `POST /apps/:appId/guides/:id/preview-token` | editor | `{ versionId }` → `{ token, url, expiresAt }` |
| `GET /apps/:appId/guides/:id/analytics` | viewer | `{ counts[], steps[], startedFromHelp, accounts? }`. `?from=` / `?to=` (ISO date or timestamp; `from` inclusive, a date `to` covers that whole day, a timestamp `to` is exclusive; `400` when `to` isn't after `from`). `?by=account` adds `accounts: [{ accountId \| null, shown, completed, dismissed, visitors }]`: the 50 accounts shown the guide most, most first. |
| `GET /apps/:appId/analytics` | viewer | `{ guides: [{ guideId, name, shown, completed, dismissed, completionRate }], visitors, accounts, windowDays }`. Lifetime totals per guide (`completionRate` is `completed / shown`, 0–1), ordered by `shown`; `visitors` / `accounts` are distinct over the last `windowDays` (30). |
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
| 400 | `invalid_body`, `empty_content_after_sanitize`, `no_draft_to_publish`, `signing_secret_required`, `unknown_app`, `unknown_page`, `unknown_user`, `cannot_revoke_self`, `confirmation_mismatch` |
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
| `organization` | A customer workspace (`created_by`), plus `suspended_at` and the support window (`support_access_until`, `support_access_granted_by`). |
| `application` | `public_key`, `allowed_origins`, `identity_mode`, `signing_secret`, `enabled` (the app switch), `route_mode` (`path` or `hash`), and the help center: `help_enabled`, `help_button_label`, `help_button_color`, `help_position`. |
| `studio_user` | People who use the Studio, keyed by (`oidc_issuer`, `oidc_sub`); created on first sign-in. `platform_admin` marks Guide Engine staff. |
| `support_access_log` | Every request a platform admin made under an organization's support access (who, when, method, path). |
| `org_member` / `app_member` | Org role (owner / admin / member) and per-app role (viewer → app_admin). |
| `invitation` | Invite links: hashed token, org role, app roles, expiry, single use. |
| `app_page` | Saved pages per app: `name`, `match_type`, `match_value`, `start_path`. |
| `guide` / `guide_version` | Guides per app. Numbered versions hold steps (JSONB), `page_id` (a saved page) and/or `route_match` (a custom route, or the page's route snapshot), dates, `account_ids` and `help` (the help-center listing). `published_at IS NULL` means the draft, at most one per guide. Published rows are immutable. |
| `guide_event` | Analytics: app, guide, version, step, `visitor_id`, `account_id`. Help-center events (`help_opened`, `help_searched`) have no guide; a CHECK ties a NULL `guide_id` to exactly those two types. |
| `agent_error` | Exceptions the agent reported from an app's pages: `message`, `stack`, `agent_version`, `url`, `occurred_at`. Written by the agent, read by the app's members and platform admins, deleted by retention. Free text: only ever rendered as text. |
| `user_guide_state` | Per (app, visitor, guide): dismissed or completed, plus `last_seen_version`. |
| `system_config` | The global kill switch (`guide_engine_enabled`). |
| `active_guide` (view) | Published, enabled guides inside their date window, with `route_match` resolved through the saved page when there is one (`security_invoker`). |

Every table under an organization references its parent with `ON DELETE CASCADE`, so deleting
an `organization` (or one `application`) removes everything beneath it in one statement.
Referential actions bypass Row-Level Security, which is what lets a deletion take published
versions and events with it without any session being allowed to delete those directly.

| Migration | What it does |
|---|---|
| `001`–`004` | The original OCLC-era tenant schema and its RLS hardening, drafts and platform admins (kept, never edited). |
| `005_organizations_apps.sql` | Converts that schema into orgs and apps. Each former tenant becomes an org with a "Default app"; its events keep the old tenant as their `account_id`. Global guides move to a "Migrated global guides" org. Then every RLS policy is rebuilt on session variables. |
| `006_help_center.sql` | Adds `guide_version.help` and the per-app help-center settings (the button color is CHECK-limited to a hex value). |
| `007_app_pages.sql` | Adds saved pages (`app_page`, with RLS), `guide_version.page_id`, and makes `active_guide` resolve routes through pages. |
| `008_help_position.sql` | Adds `help_position`: where the help list and its confirmation open (a corner or `center`, CHECK-limited). |
| `009_platform_admin.sql` | Platform admins, organization suspension, support access and its log, the `*_platform_select` policies, and a stricter `guide_version` select policy. |
| `010_production.sql` | `agent_rate_limit` (the shared agent-API budget), the `app_retention()` function and the retention policies on `guide_event`, an index on `occurred_at`. |
| `011_agent_delivery.sql` | `agent_error` with its RLS: agent insert/select for its own app (the hourly cap counts in the same session), Studio and platform select, retention select/delete. |
| `012_engine_gaps.sql` | Adds `application.route_mode` (CHECK-limited to `path` / `hash`), the `help_opened` / `help_searched` event types, and makes `guide_event.guide_id` nullable for those two types only (a CHECK constraint; the foreign keys stay). |
| `013_data_lifecycle.sql` | Deletion policies: `app_owner_org_ids()` (a new session variable, owners only) with `organization_owner_delete`, `organization_platform_delete`, and `application_app_admin_delete`. Nothing new is readable. |

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
| **Backend** | 222 | self-serve orgs; apps and settings; the role matrix; invitations; members; saved pages; platform admins and support access (consent, read-only, logging, RLS); secrets at rest, the shared rate limiter, retention (events and agent errors), production boot checks; the agent script's ETag / 304 / cache headers and the version endpoint; agent error reports (validation, the hourly cap, the Studio list, RLS isolation, platform counts); org/app isolation through the API **and directly in RLS** (including replaying the owner bootstrap and forging memberships); the agent API (origins, keys, identity modes, account targeting, kill switches, events and per-visitor state, preview); the guide lifecycle; sanitization; stable step ids; analytics; OIDC (a local JWKS server, algorithm confusion); and migration 005's data conversion |
| **Core** | 89 | includes the help widget (search, keyboard, safe rendering), help launches (same page, other page, arrival, shared links) and error reporting (sampling, the per-page cap, never throwing) |
| **Agent** | 8 | includes `openHelp` queued before load and the build-time version |
| **Studio** | 35 | guide list and editor (saved pages), Pages, app settings (including the agent-error list), the Administration page |

Type-checking is part of every `test` script, with strict TypeScript throughout.

---

## Deploying

Everything needed to run Guide Engine for real is in the repo:

- **CI** (`.github/workflows/ci.yml`): on every push and pull request, installs, builds every
  package, migrates a throwaway Postgres, runs all four test suites, and builds both images.
  On `main` the images are pushed to GitHub Container Registry as
  `ghcr.io/<owner>/<repo>/backend` and `/studio`, tagged with the commit and `latest`.
- **Images:** `packages/backend/Dockerfile` (the API plus the agent script; runs pending
  migrations at start unless `RUN_MIGRATIONS=false`) and `apps/studio/Dockerfile` (the Angular
  build behind nginx, which also proxies `/api/*` to `BACKEND_URL`).
- **`deploy/`:** a single-host staging/production stack — Postgres, **Keycloak**, the backend,
  the Studio and Caddy (automatic HTTPS) — on three hostnames.

### Staging or production on one host

1. Point three DNS names at the host: the Studio, the API, and Keycloak (for example
   `studio.`, `api.` and `auth.example.com`).
2. `cd deploy && cp .env.example .env` and fill it in: the hostnames, Postgres passwords, the
   Keycloak admin password, and two secrets from `openssl rand -hex 32`
   (`PREVIEW_TOKEN_SECRET`, `SECRETS_KEY`).
3. `./render-realm.sh` writes the Keycloak realm with your Studio URL in the client's redirect
   URIs. The realm carries three **test users** (`olivia`, `eddie`, `root`, password = username)
   for staging; delete them in the admin console on a real deployment and create your own.
4. `docker compose up -d --wait`. Postgres creates the two application roles on first start
   (`init.sh`); Keycloak imports the realm; the backend migrates; Caddy fetches certificates.
5. Sign in to the Studio, then grant yourself the platform-admin flag (see
   [Guide Engine administration](#guide-engine-administration)).

More than one backend replica: set `BACKEND_REPLICAS`. The rate limiter is already shared
through Postgres (`RATE_LIMIT_STORE=postgres`); the app-key cache is per process with a 10 s
TTL, which is the most a rotated key can linger.

### Any other platform

Use the two images with these guarantees in place:

- Postgres **15+**, an app role that is `NOSUPERUSER NOBYPASSRLS` and owns the database (the
  backend refuses to start otherwise), automated backups.
- `NODE_ENV=production`, which makes the backend **refuse to start** unless `SECRETS_KEY`,
  `PREVIEW_TOKEN_SECRET`, an `https://` `PUBLIC_API_URL` and `RATE_LIMIT_STORE=postgres` are
  set; `TRUST_PROXY=true` behind a proxy.
- Any OpenID Connect provider for `OIDC_ISSUER` / `OIDC_AUDIENCE` / `OIDC_STUDIO_CLIENT_ID`:
  a public (PKCE) client with `https://<studio>/auth/callback` as redirect URI and
  `https://<studio>/login` for logout, issuing JWT access tokens whose `aud` is
  `OIDC_AUDIENCE`. `docker/keycloak/guide-engine-realm.json` shows the exact Keycloak setup
  (an audience mapper on a client scope).
- Serve the Studio statically with an SPA fallback and proxy `/api/*` to the backend with the
  prefix removed (`apps/studio/nginx.conf.template` does both).
- A CDN in front of `/agent/v1/*` is a drop-in (next section).

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
`OIDC_ISSUER=http://localhost:8081/realms/guide-engine` in `packages/backend/.env`, restart the
backend, and sign in as `olivia` / `olivia` (see [Studio login details](#studio-login-details)).

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
  `npm run retention --workspace=packages/backend -- --days 400`.
- **Turning on `SECRETS_KEY` on an existing database:** set it, restart, then run
  `npm run encrypt-secrets --workspace=packages/backend` once. Losing the key means every app
  must generate a new signing secret (visitor identities signed with the old one stop verifying).
- **Backups:** `deploy/` mounts `./backups`; `docker compose exec postgres pg_dump -U postgres guide_engine > backups/$(date +%F).sql`
  works for a single host, and a managed Postgres should have point-in-time recovery on.
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
app, an organization or a guide id. A Prometheus job for it:

```yaml
scrape_configs:
  - job_name: guide-engine
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

**What to alert on:**

- 5xx rate: `sum(rate(http_requests_total{status=~"5.."}[5m])) / sum(rate(http_requests_total[5m]))`
  above ~1% for 5 minutes.
- Agent failures by endpoint: `sum by (endpoint) (rate(agent_requests_total{status=~"4..|5.."}[5m]))`
  rising on `guides` or `events` means customers' pages are silently showing nothing (the agent
  fails closed). A burst of `404` usually means a stale snippet; `403`, a website missing from an
  app's list; `429`, a runaway page.
- p95 latency: `histogram_quantile(0.95, sum by (le, route) (rate(http_request_duration_seconds_bucket[5m])))`
  above 250 ms on `/v1/agent/:key/guides`.
- `db_pool_waiting > 0` for more than a minute: the pool is saturated (slow queries or too few
  connections for the replica count).
- Retention job not running: `increase(retention_deleted_total{table="guide_event"}[2d]) == 0`
  on a production instance with traffic, or no `retention:` log line in 25 hours.
- Backend restarts: `changes(process_start_time_seconds[1h]) > 0`, or the orchestrator's own
  restart counter. A restart loop at boot means a configuration or database-role check failed:
  the reason is in the first log line.

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

- **The app-key cache is per process** (10 s TTL): a rotated key can keep working on another
  replica for up to 10 s.
- **Signing secrets are encrypted with one key from the environment.** A KMS-held key, or
  customer JWKS (RS256) so we never hold a verification secret at all, is on the roadmap.
- **`guide_event` isn't partitioned.** Retention deletes in batches, which is fine for years of
  normal volume; monthly partitions would make it instant at very high volume.
- **Invitation emails are plain SMTP.** One template, no provider API or bounce handling; set
  `SMTP_URL` or keep copying links.
- **Analytics have no per-visitor breakdown**, and the per-account one is a top-50 list, not
  a searchable one.
- **Shared `?guideEngine=` links** work for help-center guides only.
- **Deferred:** metadata segments, surveys, i18n, rollout percentages, cross-app guides, staging
  environments, and a visual point-and-click designer.
