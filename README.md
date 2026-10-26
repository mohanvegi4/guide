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
- Everyone in the organization has one role, for all of its apps: viewer, editor, manager or owner.

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
   - [Environments and releases](#environments-and-releases)
   - [Saved pages](#saved-pages)
   - [Help center](#help-center)
6. [How a guide is chosen and shown](#how-a-guide-is-chosen-and-shown)
7. [Identity, roles and security](#identity-roles-and-security)
   - [Guide Engine administration](#guide-engine-administration)
8. [Configuration reference](#configuration-reference)
9. [API reference](#api-reference)
10. [Data model and migrations](#data-model-and-migrations)
11. [Testing](#testing)
12. [Go-live checklist](#go-live-checklist)
13. [Deploying](#deploying)
14. [Operations](#operations)
15. [Troubleshooting](#troubleshooting)
16. [Known gaps and roadmap](#known-gaps-and-roadmap)

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
   **One guide at a time:** when several match a page, walkthroughs (tours, multi-step guides)
   go first, then single-step tips in the order they were created. The next one shows when the
   current one completes; a dismissal ("Maybe later") ends the pop-ups for that page view, and
   the rest return on the next navigation. A guide the visitor opens from the help center takes
   over, and the automatic one comes back afterwards.
6. **Record.** Events are batched to the backend. An automatic guide shows **once per visitor**:
   being shown, dismissed or completed is remembered, so a reload never starts it over and they
   don't see it again until a **newer version** is published. The help center ignores that state,
   so any listed guide can be replayed on demand.

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
e2e/                 Playwright smoke test: Keycloak sign-in → org, app, guide → the snippet on a page
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
- **Anonymous visitors:** omit `visitor`, and the agent keeps a random per-browser id. To give them
  tags, pass `visitor: { tags: ['anonymous'] }` without an id.
- **After login:** call `guideEngine.identify({ visitor: { id }, account: { id } })`. The agent
  clears what the previous user was shown and re-evaluates.
- **After logout** (when the page doesn't reload): call `guideEngine.identify(null)`. The previous
  user's guides and help list go away, and nothing is fetched or shown until the next `identify`.
- **Visitor tags (optional):** `visitor: { id, tags: ['POINT_OF_SALE', 'CUSTOMERS:edit'] }`. Tags
  are short strings you choose, usually what the person may do in your app. A guide limited to
  tags shows only to visitors carrying at least one of them. Letters, digits and `_ . : / -`, up
  to 100 characters each and 1000 per visitor; malformed ones are ignored. When the visitor's
  permissions change, call `identify` with the same `id` and account and the new tags: the guide
  on screen stays and the page's guides are refreshed. `identify({ visitor: { tags } })` without an
  `id` keeps the current one; pass `id: undefined` to make the visitor anonymous.
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
     { visitor: { id: user.id, tags: user.guideTags }, account: { id: user.companyId } },
     process.env.GUIDE_ENGINE_SECRET,
     { algorithm: 'HS256', expiresIn: '1h' },
   );
   ```

3. Pass it to the page: `guideEngine.initialize({ jwt: token })`. Ids and tags then come from
   the token only; anything sent beside it is ignored.
4. Switch on **Require signed identity**. From then on, unsigned or invalid identities get no
   guides.

The full contract for your backend team — claims, algorithm, the endpoint pattern, a Java
example, rotation and acceptance checks — is in
[docs/integration/signed-identity.md](docs/integration/signed-identity.md).

### Alternative: npm packages

For bundled apps that prefer a dependency over a script tag, three packages are published to
npm, always together at one version (currently **0.3.0**; see [CHANGELOG.md](CHANGELOG.md)):

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

- **Organizations and apps.** Use the org switcher, then the app switcher, in the top bar.
  Managers and owners create apps (name + websites) on **Apps**.
- **Members.**
  - Invite people with a link (7 days, single use). If you enter an email, only that verified
    email can accept, and when the backend has mail configured (`SMTP_URL`, `MAIL_FROM`,
    `STUDIO_URL`) the invitation is emailed to them; the link is still shown as a fallback.
  - One role per person, for every app of the organization:

    | Role | Can |
    |---|---|
    | viewer | read guides, pages, versions and analytics on every app; see the install snippet |
    | editor | + create, publish, enable / disable, promote, revert and roll back guides; create, edit and move pages; app settings (environments and their websites, signed identity, help center, app on / off) |
    | manager | + create apps; delete environments; rotate keys, delete apps, forget visitors; manage members and invitations |
    | owner | + grant or remove ownership; support access; export or delete the organization |

  - Managers and owners manage members; only owners can grant or remove ownership, and every org
    keeps at least one owner. Only owners create new organizations.
  - Owners can open time-boxed, read-only **support access** for Guide Engine staff; see
    [Guide Engine administration](#guide-engine-administration).
- **Guides.**
  - **Help center:** optionally list the guide, with a title, description, search keywords and a
    start page (required for pattern routes).
  - **Where:** a [saved page](#saved-pages) of the app, or a custom route (an exact path, or a
    pattern where `*` matches anything).
  - **Dates:** optional start and end.
  - **Audience:** all accounts, or only listed account ids; and all visitors, or only visitors
    carrying any of the listed [visitor tags](#1-add-the-snippet). Both rules apply.
  - **Steps:** each has a type, anchor, position, HTML content, and buttons (`next`, `dismiss`,
    `complete`).
  - **Workflow:** save a draft, preview, publish, enable. Publishing releases the version to the
    app's first [environment](#environments-and-releases); **Environments** promotes it stage by
    stage, reverts or withdraws it. **Versions** lists the history, with rollback (in production).
  - **Analytics:** per [environment](#environments-and-releases) (production unless you pick
    another), never mixed: event totals, plus a per-step funnel that carries across versions (step ids
    stay stable). **By account** adds the 50 accounts shown the guide most (shown, done,
    dismissed, distinct visitors; "No account" is unidentified visitors). The **Guides** page
    starts with an overview: shown, completed and completion rate per guide, and distinct
    visitors and accounts over the last 30 days.

### Environments and releases

An app's **environments** are its release stages in promotion order, for example
Dev → Test → Accept → Production. The last one is production. Every app starts with one,
*Production*, holding the websites it was created with; add the others in **Install & settings →
Environments & websites** (they go in front of production; reorder with the arrows).

- **Each environment owns its websites.** The agent tells which environment a page belongs to
  from the page's `Origin` (which CORS already checks), so every environment uses the same
  snippet and key. A website belongs to one environment only (`409 website_in_use`). A request
  without an `Origin` (not a browser) counts as production.
- **Releases.** A guide runs at most one published version per environment. **Publish** releases
  the new version to the first environment; in the guide editor's **Environments** panel,
  **Promote to …** gives the next stage what this one runs, **Release** puts any published
  version in one environment directly, and **Withdraw** takes the guide out of one environment.
  Drafts are never released anywhere. Changes to production ask for confirmation.
- **Revert** undoes an environment's latest release change and restores what it ran before (a
  version, or nothing). Reverting again keeps walking back that environment's release log, which
  the panel shows under **History**.
- **Production is what "live" means elsewhere.** The guide list's *Live versions* column shows
  every stage; the guide's `current_version_id`, page usage, the export and **Roll back** all
  refer to production.
- **Show-once state is per environment**, so a tester finishing a tour in Accept still gets it in
  production.
- **Analytics are per environment and can be switched off per environment** (*Record
  analytics*). With it off, no events are stored for that environment at all; show-once state
  still is, since it is what keeps an automatic guide from showing twice. Every analytics view
  (the guide's, the guide list's overview, the help center's) reads one environment, production
  by default, with a picker when the app has several.
- The guide's **enabled** switch, dates and audience apply in every environment; a release
  decides *which version* each environment runs.

### Saved pages

Name the parts of your app once and reuse them in every guide, like Pendo's tagged pages.

- **Studio → Pages** lists the app's pages. Each page has a name ("Team settings"), a URL rule
  (exact `/settings/team`, or a pattern like `/projects/*`), and an optional **start page**.
  Patterns need a start page: it's the concrete URL the help center opens for guides on that page.
- **In a guide**, under *Where & when*, choose **A saved page** and pick one. You can still choose
  **A custom route** for one-off rules, and save that route as a page from there.
- **Guides follow their page.** Change a page's URL and every guide on it, live ones included,
  matches the new URL on the next page load. You don't need to republish. Because that changes
  what's live, the Studio asks for a confirmation before moving a page that live guides use.
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

**How it looks.** With **Match the website's theme** on (the default, in the app's settings), guide
cards and the help center take the page's own Bootstrap 5 theme: `--bs-primary` for buttons, the
spotlight ring and focus rings, `--bs-body-font-family`, `--bs-body-color`, `--bs-body-bg` and
`--bs-border-radius`. They are read live through the shadow DOM, page by page, so a site whose
theme differs per tenant (the WISE OPAC's library themes) shows each tenant's colors. The app's
color is the fallback for pages without a Bootstrap theme. With it off, the app's color styles
the help button and the cards' main buttons, with Guide Engine's own font and corners.

**How the list is built**
- It lists the guides authors marked **List in the help center**, filtered like everything else:
  published, enabled, inside their dates, and the visitor's account allowed. Guides set to start
  **only from the help center** are always listed, and are the only place they appear: they never
  pop up on their own.
- Guides a visitor already finished stay listed: help is on demand, so they can replay any time.
- The button only appears when the visitor has at least one topic.

**Searching and choosing**
- Search matches every word in the title, description or keywords, with title matches first.
- **↑/↓** move, **Enter** starts a topic, **Esc** closes. Focus stays inside the dialog, and
  clicking outside closes it.

**Starting a guide**
- **On the guide's own page** — or when its start page is the page the visitor is on — it
  starts right away.
- **Anywhere else:** the list says so ("Opens on `/team`"), and choosing the topic first asks
  **"Go to another page?"** with *Take me there* / *Stay here*, since leaving is a page load that
  can drop unsaved work. *Stay here* (or Esc) returns to the list. On *Take me there* the visitor
  gets a normal page load to the guide's **start page**, and the agent starts the guide on
  arrival. Which guide to start travels in the tab's session storage (`guideEngine.launch`, for
  this app key, valid for a minute), never in the URL: nothing shows in the address bar, and a
  router that rewrites the URL as it boots can't bring it back. If the visitor lands elsewhere
  first (a sign-in redirect), the guide starts once a route change brings them to its page. Only
  a browser with session storage blocked falls back to `?guideEngine=help:<guide id>`.
- **Hash-routed apps** (Routing set to *Hash* in the app's settings) show the start page as
  `/#/team`, and the visitor is sent to `#/team` on the same document: no page load, so the guide
  starts on the route change.
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
   - the [environment](#environments-and-releases) the page's `Origin` belongs to, and the
     version released there (a guide with no release in it isn't served);
   - published, enabled and in the date window;
   - the account allowlist and the visitor tags;
   - that this visitor hasn't already seen, dismissed or completed this version or a newer one
     in this environment (automatic guides show once; the help center lets them be replayed).

   `enabled: false` stops the agent for the rest of the page's life. Any other failure shows
   nothing for that navigation (fail closed).
4. **Route matching** uses the URL **path** only (query strings and fragments are ignored):
   `exact` compares the whole path, and in `pattern` each `*` matches anything. For an app whose
   **Routing** setting is *Hash* (`/#/settings/team`), the path inside the fragment is matched
   instead (`/settings/team`; a fragment-less page is `/`), the agent re-evaluates on every
   `hashchange`, and page URLs are written the same way as for path routing. The server says
   which mode applies in every `/guides` and `/help` response (`routeMode`).
5. **Finding the target.** A **first** step whose anchor isn't in the DOM yet waits quietly: the
   agent retries with backoff (10 attempts, about 16.5 s), then records `guide_error` with
   `target_not_found` and shows nothing — the page may still be rendering, or the feature may not
   be there for this visitor. A **later** step (the visitor clicked Next or Back) shows its card
   centered straight away, so the click visibly did something and the buttons keep working, and
   the card moves onto the element the moment it appears — for anchors that only exist after the
   visitor acts, such as a field that appears once a record is selected.
6. **Rendering** happens in a Shadow DOM card, so your styles don't leak in. A targeted step
   puts the focus on its element: it's scrolled into view if off-screen, and **spotlighted** with
   a ring in the theme's color (the element stays clickable; the page is never dimmed). Card and
   spotlight follow the element when the page scrolls, the window resizes or your framework
   re-creates the element; the card's DOM is built once per step (re-renders only move it, so
   a click never lands on a replaced button). Cards are kept inside the viewport, and if your
   page scrolls the anchor away within moments of the step appearing (restoring a scroll
   position, bringing a table into view) it's scrolled back once — later scrolling is the
   visitor's. Every card has a **×** and closes on **Escape**, whatever buttons the author chose.

   The guide **never hides what the element shows the visitor**, such as a dropdown's options. A
   card for a control that opens a list below itself (text fields, selects, comboboxes,
   `aria-haspopup` buttons) goes above it, or beside it when there's no room above, unless the
   author chose a side other than below, so it stays readable while the list is open. Only when
   it would still cover an open list (`aria-expanded="true"`, the list named by `aria-controls` /
   `aria-owns`, such as options rendered at the end of `<body>`) does the card fade and let clicks
   through, until the list closes.
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
| **Studio users** | an OIDC access token from your identity provider (identity only: `sub`, `email`, `name`), verified against its JWKS. Dev/test only: HS256 tokens from `mint-token`. | what their **memberships in our DB** allow: one organization role, applying to every app |
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
- **Keys are generated by the backend, never derived.** All three come from Node's CSPRNG
  (`packages/backend/src/keys.ts`); nothing in the Studio or the agent generates keys.
  - The **public app key** `ge_pk_` + 32 hex characters (16 random bytes) is created when an
    application is created and replaced by **Rotate public key** (manager+). It identifies the
    app and authenticates nobody, so it is stored in plain text.
  - The **signing secret** `ge_sk_` + 43 base64url characters (32 random bytes) is created by
    **Generate signing secret** (manager+), returned once, and stored encrypted with
    `SECRETS_KEY` (AES-256-GCM). Generating again rotates it.
  - **Invitation tokens** (32 random bytes) are stored hashed, so a database leak doesn't leak
    working links.
- **Secrets at rest.** Signing secrets are encrypted with `SECRETS_KEY`; holding that key in a
  KMS instead of the environment is a roadmap item.
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
    the support access log, in one transaction. Managers can delete a single app the same way
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
| `RUN_MIGRATIONS` | `true` | Container only: apply pending migrations before starting. `false` when a release step runs `node packages/backend/dist/migrate.js`. Either way the backend checks at boot that no migration is pending: in production it refuses to start and lists the files; elsewhere it logs a warning. |
| `AGENT_BUNDLE_PATH` | `packages/agent/dist/guide-engine.js` | Where the backend reads the agent script from. |
| `SMTP_URL` | — | Invitation emails: `smtp://user:pass@host:587` or `smtps://…`. Unset: invitations are links to copy. `json://` logs messages instead of sending (development/tests). |
| `MAIL_FROM` | — | Required with `SMTP_URL`: the From header, e.g. `Guide Engine <no-reply@example.com>`. |
| `STUDIO_URL` | — | The Studio's public origin (`https://studio.example.com`), for links in emails. Invitations are only emailed when it is set. |

The Studio has no runtime config. It calls `/api/*` on its own origin: the dev server proxies
that to `localhost:3000` (`apps/studio/proxy.conf.json`), and in production a reverse proxy
must do the same.

The `deploy/` stack reads `deploy/.env` instead (`deploy/.env.example` lists everything): the
three hostnames, the Postgres and Keycloak passwords, the two backend secrets above, and the
backup settings `BACKUP_AT` (daily run time, `03:00` UTC), `BACKUP_KEEP_DAYS` (`14`) and
`BACKUP_COPY_CMD` (off-host copy, unset) — see [Backups and restore](#backups-and-restore).

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
| `POST /v1/agent/:key/guides` | identity → `{ enabled, routeMode, theme: { color, matchSite }, guides: [{ id, versionId, name, type, steps, routeMatch }] }`. `routeMode` is `path` or `hash`; `theme` is the app's color and whether to match the website's Bootstrap theme ([Help center](#help-center)). |
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
| `GET` / `POST /apps/:appId/guides` | viewer / editor | Each listed guide carries `releases: [{ environmentId, versionNumber }]` in environment order. |
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
{ steps: [{ id?, order, type, targetSelector?, content, position?, actions: [{ label, action }] }],
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

## Data model and migrations

| Table | Purpose |
|---|---|
| `organization` | A customer workspace (`created_by`), plus `suspended_at` and the support window (`support_access_until`, `support_access_granted_by`). |
| `application` | `public_key`, `allowed_origins` (the union of its environments' websites, kept in sync by the API; the CORS check reads it), `identity_mode`, `signing_secret`, `enabled` (the app switch), `route_mode` (`path` or `hash`), and the help center: `help_enabled`, `help_button_label`, `help_button_color`, `help_position`; `match_site_theme` (style guides with the website's Bootstrap theme, the color being the fallback). |
| `studio_user` | People who use the Studio, keyed by (`oidc_issuer`, `oidc_sub`); created on first sign-in. `platform_admin` marks Guide Engine staff. |
| `support_access_log` | Every request a platform admin made under an organization's support access (who, when, method, path). |
| `org_member` | One role per person per organization (viewer / editor / manager / owner), applying to every app. |
| `invitation` | Invite links: hashed token, role, expiry, single use. |
| `app_page` | Saved pages per app: `name`, `match_type`, `match_value`, `start_path`. |
| `app_environment` | An app's release stages: `name`, `position` (promotion order; the highest is production), `origins` (its websites) and `analytics_enabled`. |
| `guide_release` | What each environment runs: one published `version_id` per (guide, environment). `guide.current_version_id` mirrors the production row. |
| `guide_release_event` | The release log per (guide, environment): `release` (a version) or `withdraw`, who and when, and `reverted_at` / `reverted_by` once undone. Revert walks it back. |
| `guide` / `guide_version` | Guides per app. Numbered versions hold steps (JSONB), `page_id` (a saved page) and/or `route_match` (a custom route, or the page's route snapshot), dates, `account_ids`, `visitor_tags`, `help` (the help-center listing) and `activation` (`auto`: pops up on its page; `manual`: help center only). `published_at IS NULL` means the draft, at most one per guide. Published rows are immutable. |
| `guide_event` | Analytics: app, `environment_id`, guide, version, step, `visitor_id`, `account_id`. Help-center events (`help_opened`, `help_searched`) have no guide; a CHECK ties a NULL `guide_id` to exactly those two types. |
| `agent_error` | Exceptions the agent reported from an app's pages: `message`, `stack`, `agent_version`, `url`, `occurred_at`. Written by the agent, read by the app's members and platform admins, deleted by retention. Free text: only ever rendered as text. |
| `user_guide_state` | Per (app, environment, visitor, guide): shown, dismissed or completed, plus `last_seen_version`. A later `shown` never downgrades dismissed / completed at the same version. |
| `system_config` | The global kill switch (`guide_engine_enabled`). |
| `active_guide` (view) | One row per guide per environment it is released to (`environment_id`): the released version, enabled and inside its date window, with `route_match` resolved through the saved page when there is one (`security_invoker`). |

Every table under an organization references its parent with `ON DELETE CASCADE`, so deleting
an `organization` (or one `application`) removes everything beneath it in one statement.
Referential actions bypass Row-Level Security, which is what lets a deletion take published
versions and events with it without any session being allowed to delete those directly.

Migration runs are serialized with a Postgres advisory lock (held for the whole run, released
when it ends), so replicas that all run `migrate.js` at start can boot together: one applies the
pending files and the others wait, then find nothing to do.

| Migration | What it does |
|---|---|
| `001_schema.sql` | The whole schema: types, the session-variable helpers RLS reads, every table with its constraints and indexes, the `application_guard_keys` trigger, the `active_guide` view, every RLS policy (enabled and forced), and the kill-switch row. |
| `002_drop_leftovers.sql` | Drops what the code no longer used: `app_member` and `app_role` (per-app roles), `invitation.app_roles`, the never-used `step` table, the retired `admin` / `member` roles (`org_role` now has only owner, manager, editor, viewer) and the unused `snoozed` visitor status. The two enums are rebuilt, with the policy and CHECK constraints that embed them. |
| `003_match_site_theme.sql` | `application.match_site_theme` (default on, existing apps included): guide cards and the help center follow the website's Bootstrap theme, with `help_button_color` as the fallback. |

The 21 migrations written during development were squashed into `001_schema.sql` before the first
deployment (they had only run on development databases); [How the schema got
here](docs/architecture.md#53-how-the-schema-got-here) keeps their design history. From here on,
a schema change is a new numbered file, and an applied file is never edited.

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
| **Backend** | 274 | self-serve orgs; apps and settings; the role matrix; invitations; members; saved pages; platform admins and support access (consent, read-only, logging, RLS); secrets at rest, the shared rate limiter, retention (events and agent errors), production boot checks; the agent script's ETag / 304 / cache headers and the version endpoint; the security headers (and that the agent surface keeps only nosniff); agent error reports (validation, the hourly cap, the Studio list, RLS isolation, platform counts); org/app isolation through the API **and directly in RLS** (including replaying the owner bootstrap and forging memberships); the agent API (origins, keys, identity modes, account targeting, kill switches, events and per-visitor state, preview); the guide lifecycle; sanitization; stable step ids; analytics; OIDC (a local JWKS server, algorithm confusion); environments, releases, promote / revert and per-environment analytics; concurrent migration runs (the advisory lock); and the pending-migrations boot check |
| **Core** | 102 | includes the help widget (search, keyboard, safe rendering), help launches (same page, other page, arrival, shared links) and error reporting (sampling, the per-page cap, never throwing) |
| **Agent** | 8 | includes `openHelp` queued before load and the build-time version |
| **Studio** | 45 | guide list and editor (saved pages), Pages, app settings (including the agent-error list), the Administration page |

Type-checking is part of every `test` script, with strict TypeScript throughout.

**End-to-end smoke test** (`e2e/`, Playwright, Chromium). One browser flow proves the whole
product works together: sign in to the Studio through Keycloak (`olivia` / `olivia`), create an
organization with a first app, read the public key from the install snippet, create, publish
and enable a guide, then open a page that installs the snippet with that key and see the guide.
The page is served from a Playwright route at `http://e2e.localhost` (the origin the app's
websites list gets), so no extra server is needed; the agent script and API are the real
backend's. It runs against an already-running stack: Postgres (`npm run db:up`), Keycloak
(`npm run idp:up`, with `OIDC_ISSUER` set in `packages/backend/.env`), the backend on :3000 and
the Studio on :4300. Then:

```bash
npx playwright install chromium          # once
npm run e2e                              # STUDIO_URL / API_URL / KEYCLOAK_USER / KEYCLOAK_PASSWORD override the defaults
```

Each run creates a new organization (`E2E <timestamp>`) for `olivia` and deletes it at the end
through the Studio's danger zone, even when an earlier step failed, so it can be repeated against
the same database without leaving anything behind. On failure, `e2e/playwright-report/` holds the report with a trace
(`npx playwright show-trace e2e/test-results/<run>/trace.zip`). CI runs it in the `e2e` job
after the unit tests, starting the same services from `docker-compose.yml`.

---

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
   ([Guide Engine administration](#guide-engine-administration)).
5. **Invitation emails.** `SMTP_URL` and `MAIL_FROM` in `deploy/.env` (compose derives
   `STUDIO_URL` from `STUDIO_HOST`), or accept that invitations are links the inviter copies
   ([Configuration reference](#configuration-reference)).
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
    ([Require signed identity](#3-recommended-require-signed-identity)).

---

## Deploying

Everything needed to run Guide Engine for real is in the repo:

- **CI** (`.github/workflows/ci.yml`): on every push and pull request, installs, builds every
  package, migrates a throwaway Postgres, runs all four test suites, runs the browser smoke test
  against Keycloak, the backend and the Studio (job `e2e`), and builds both images.
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
   Keycloak admin password, `ADMIN_ALLOW_CIDRS` (the networks that may open the Keycloak admin
   console: office, VPN or bastion CIDRs, space-separated; empty means nobody, see step 5), and
   two secrets from `openssl rand -hex 32` (`PREVIEW_TOKEN_SECRET`, `SECRETS_KEY`).
3. `./render-realm.sh` (needs `jq`) writes `keycloak-import/guide-engine-realm.json` from the
   development realm, made safe for a real deployment: **no users** (the development realm's
   `olivia` / `eddie` / `root` are stripped), brute-force detection on (temporary lockouts:
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
   [Guide Engine administration](#guide-engine-administration). From then on platform admins
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
  start (in production) while any file in `packages/backend/migrations/` is missing from
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
- **Express** (`packages/backend/src/securityHeaders.ts`): `X-Content-Type-Options: nosniff` on
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
- **Backups:** see [Backups and restore](#backups-and-restore) below.
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
| Demo shows "No app key yet" | Run `npm run seed --workspace=packages/backend` and restart the demo dev server. |

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
