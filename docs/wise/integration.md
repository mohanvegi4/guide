---
title: Integration and production TODO
parent: WISE integration
nav_order: 1
---

# Guide Engine × WISE — integration and production TODO

**Date:** 2026-10-20 · **Status:** POC complete, green light for production · **Owner:** WISE / Guide Engine integration

Guide Engine is the in-app guide product (a lightweight Pendo/WalkMe) built in the
[`guide` repository](https://github.com/mohanvegi4/guide). This page says what was built, how the
WISE staff console and the patron OPAC are wired to it, and what remains to be done before
production. Where each project and file lives is in the [project handbook](handbook.md).

## Contents

1. [What exists today](#1-what-exists-today)
2. [How the integration works](#2-how-the-integration-works)
3. [Running it locally](#3-running-it-locally)
4. [Signed identity (specified, not built)](#4-signed-identity-specified-not-built)
5. [TODO: productionalization](#5-todo-productionalization)

---

## 1. What exists today

### 1.1 Guide Engine

Repository [`mohanvegi4/guide`](https://github.com/mohanvegi4/guide), branch `main`.

| Part | What it is |
|---|---|
| `packages/backend` | Express + Postgres 16 API: the Studio API (`/v1/…`, OIDC-authenticated) and the public agent API (`/v1/agent/<key>/…`, `/agent/v1/<key>/guides.js`). Row-level security on every tenant table. 20 migrations, applied by the backend on boot (advisory-locked) and refused in production if pending. |
| `packages/core` + `packages/agent` | The engine and the install-snippet agent (one IIFE served by the backend, cached 5 min / ETag). Version **0.3.0** prepared (changelog, package versions), not yet tagged. |
| `apps/studio` | The authoring Studio (Angular 21), signed in through Keycloak. Organizations → applications → guides, pages, help center, members, analytics, platform administration. |
| `deploy/` | Single-host production stack: Caddy (TLS, HSTS, security headers, Keycloak admin allowlist), Keycloak, Postgres, backend, Studio, nightly backups + restore script, optional Prometheus + Alertmanager profile. |
| `docs/` | This docs site: the reference, the Studio reference, architecture, DevOps, the [signed identity contract](../integration/signed-identity.md), legal templates, and these WISE pages. |
| CI | Build + tests (backend 265, core 105, Studio 47, agent 8), Docker images to GHCR, Playwright end-to-end smoke test (Keycloak sign-in → org → publish → snippet shows the guide), docs site. Green on `main`. |

**Engine behaviour that matters for WISE** (all added during the POC, from watching real users):
one automatic guide at a time per page (walkthroughs before tips); automatic guides show **once per
visitor per published version** (a reload never restarts one; republish to show it again); a step whose
anchor appears only after the user acts shows centered and moves onto the element; cards follow their
element on scroll and resize and are kept inside the viewport; every card has a **×** and closes on
Escape; a help-center guide whose start page is the current page starts in place.

### 1.2 The two WISE applications

Both live on the branch `poc/guide-engine` in their repository, pushed to Bitbucket.

| | Staff console (`application-ng-staff`) | OPAC (`application-ng-patron`) |
|---|---|---|
| Commits | `cd4c5d2` install · `6cddf49` env config · `ec805b1` anchors · `cb802a8` permission tags | `2ec35bd` install · `c2bb01b` env config · `02cfae1` anchors · `1a83b43` visitor tags |
| Agent install | `GuideEngineService` (`src/app/services/guide-engine/`) creates the `window.guideEngine` queue and injects `<script async src="<apiUrl>/agent/v1/<appKey>/guides.js">` at startup, **from `environment.guideEngine`** (`{ apiUrl, appKey } | null`). `index.html` is untouched. | Same, in `projects/opac/src/app/services/guide-engine/`. Loading from code (not `index.html`) also keeps `opac-create-filelist.js` from copying the script into `integration.json` for embedded mode. |
| Identity passed | `visitor.id` = staff actor UUID (`patronSystemId` in the auth store, Keycloak `wiseUuid`); `visitor.tags` = the user's branch-level permissions from `GET /authorities` (`SERVICE_CASH_REGISTER`, `SERVICE_CASH_REGISTER:edit`, …); `account.id` = library id (`libraryId`). Called once the user **and** their authorizations have loaded (without tags if authorizations fail); `identify()` when either changes. | `account.id` = `branch.instance`; `visitor.id` = patron system id when signed in, otherwise none (the agent uses an anonymous per-browser id); `visitor.tags` = `anonymous` until a patron signs in, then `signed-in` plus every active authority (`MA_RENEW`, `MA_VIEW_WISHLIST`, …), the authorities the My account menu and hold buttons check. |
| Environment files | `environment.template.ts` (dev values; `environment.ts` is git-ignored and copied from it), `environment.prod.ts` → **`null`** (guides off until filled), `environment.cypress.ts` → `null`. | `environment.default.ts` (dev values; `environment.dev.ts` is git-ignored and spreads it), `environment.prod.ts` → **`null`**, `environment.cypress.ts` → `null`. |
| Anchors | ~85 `data-guide-id` attributes across landing, navigation, catalog search/results/title drawer, hold dialog, check in/out, on-the-fly dialog, picklist, holds shelf, customer search/record (summary, tabs, checked out, financial, holds), item request manager, point of sale, peripherals, profile menu. The design-system table component gained `guideId` / `selectAllGuideId` inputs for row actions and select-all. | ~90 across search bar/results/filters/sorting, title detail, hold and add-to-list modals, top bar and menu, new arrivals, recommendations, community, and every My account screen (checkouts, holds, financial, personal data, notifications, lost card, requests, lists, wishlist). |
| Local development | The local WISE development stack, path `/staff/console` (the container mounts the checkout) | The local WISE development stack, path `/wise-apps/opac/branch/1400/home` |
| Tests | `guide-engine.service.spec.ts` (12) + app component spec; `ng build` green | `guide-engine.service.spec.ts` (16); full suite 6964 specs at 100 % coverage; `ng build` green |

The **signed identity** work (backend-minted JWT per user) is specified but not built — see
[section 4](#4-signed-identity-specified-not-built).

### 1.3 Studio content and the guide catalogue

The guides live in two applications of a local development organization in the Studio:

| Application | Websites (CORS) | Identity mode | Guides |
|---|---|---|---|
| WISE Staff console | the local WISE development stack, `http://localhost:4200` | optional | 22 |
| WISE OPAC (patron) | same | optional | 21 |

App keys are public by design; the development keys are committed in the apps' dev environment
files. The guides were authored through the Studio API by a script running as a manager of that
organization with a development token.

**Console guides (22)**, with the permission tag each needs (the tag scheme is under "Identity
passed" in [section 1.2](#12-the-two-wise-applications)):

| Guide | Starts | Visitor tag | Where the console checks it |
|---|---|---|---|
| Welcome to Wise Console | automatic | none (everyone) | landing page |
| Catalog search tip | automatic | none | catalogue: system option only |
| Refine catalog results | help only | none | same |
| Place a hold for a customer | help only | `SERVICE_CUSTOMER_HOLDS:edit` | title page Place hold button |
| Check in items | automatic | `CUSTOMER_SERVICES` | Circulation in the navigation |
| Backdate a check-in | help only | `CUSTOMER_SERVICES` | same (plus system option CIRCDAT) |
| Check out items | help only | `CUSTOMER_SERVICES` | same |
| Create an item on the fly | help only | `CUSTOMER_SERVICES` | same |
| Print receipts at End session | help only | `CUSTOMER_SERVICES` | same |
| Work the picklist | automatic | `CUSTOMER_SERVICES` | same (plus system option PICKLST) |
| Clear the holds shelf | automatic | `CUSTOMER_SERVICES` | same (plus system option HLDSHLF) |
| Customer search tip | automatic | `SERVICE_CUSTOMERS` | Customers in the navigation |
| Find a customer the right way | help only | `SERVICE_CUSTOMERS` | same |
| Register a new customer | automatic | `SERVICE_CUSTOMERS` | same; the New customer button has no stricter check |
| Reading a customer record | automatic | `SERVICE_CUSTOMERS` | same |
| Recently viewed customers | help only | `SERVICE_CUSTOMERS` | record history has no check; the guide is about customers |
| Renew items from the account | automatic | `SERVICE_CUSTOMERS:edit` | Renew needs this **and** `CUSTOMER_SERVICES` |
| Cancel a customer's hold | help only | `SERVICE_CUSTOMER_HOLDS:edit` | holds table |
| Pay or waive a charge | help only | `SERVICE_CASH_REGISTER:edit` | charges table; reaching it also needs `SERVICE_CUSTOMERS` |
| Set up receipt printing | help only | `CLIENT_CONFIGURATION:edit` | Save on Peripherals |
| Process an item request | automatic | `ITEM_REQUEST_MANAGEMENT` | Item request manager in the navigation |
| Sell at Point of sale | automatic | `SERVICE_CASH_REGISTER:edit` | Point of sale in the navigation (edit level) |

Three staff profiles checked against the agent API: catalogue-only staff get 3 guides, a circulation
desk user (circulation, customers edit, holds edit) gets 18, a cashier (cash register edit) gets 5.
A tag list matches **any** tag, so a screen that needs two permissions at once is tagged with the
stricter one; a cashier without customer access still sees "Pay or waive a charge" in Help.

**OPAC guides (21)**, with the tags each needs. A guide matches any of its tags; untagged guides show to everyone:

| Guide | Starts | Visitor tags | Where the OPAC checks it |
|---|---|---|---|
| Welcome to the catalogue | automatic | none | home page |
| Search tip | automatic | none | search |
| Search tips | help only | none | search |
| Refine results with filters | automatic | none | search results |
| What the availability means | help only | none | search results |
| Search in a different catalogue | help only | none | search |
| Browse new arrivals | automatic | none | new arrivals page |
| Recommendations by author | automatic | none | recommendations page |
| Sign in to do more | help only | `anonymous` | the Log in button shows only when signed out |
| Place a hold | help only | `anonymous`, `MA_PLACE_HOLDS` | the hold button: holds permitted **or** not signed in |
| Save a title to your wish list | help only | `anonymous`, `MA_VIEW_WISHLIST` | add-to-list: anyone signed out; the lists need wish-list access |
| My account tour | automatic | `signed-in` | My account |
| Renew a loan | automatic | `MA_RENEW` | renew on My checkouts |
| Manage your holds | automatic | `MA_VIEW_HOLDS` | My holds in the My account menu |
| Pay fines and fees | automatic | `MA_VIEW_FINANCIAL_DATA` | Financial details in the menu |
| Update your details and pickup branch | automatic | `MA_PERSONAL_DATA` | Personal data route guard |
| Choose how the library contacts you | automatic | `MA_CHANGE_MESSAGE_DELIVERY_PREFERENCES`, `MA_SUBSCRIBE_NEWSLETTER_CLASSIC`, `MA_SUBSCRIBE_NEW_TITLES_NOTIFICATION` | the menu needs any one of these three |
| Report a lost card | automatic | `MA_REPORT_PATRONCARD_LOSS` | menu item |
| Request a title we don't have | automatic | `MA_SUBMIT_ITEM_REQUEST` | Requests route guard |
| Create a Community list | automatic | `MA_VIEW_WISHLIST` | My lists route guard |
| Your inbox | help only | `MA_VIEW_INBOX` | Inbox in the menu |

Three profiles checked against the agent API: an anonymous visitor gets 11 guides, a typical adult
patron 20, a patron who may only view loans 9.

Every guide has a help-center entry (title, description, keywords; start pages on branch 1400 for the
OPAC) and is grounded in the public help sites
([Wise console](https://help.wise.oclc.org/Wise_console), [OPAC](https://help.wise.oclc.org/OPAC)).
Copy uses the product's vocabulary (Customer, hold, Check in, Picklist, Holds shelf; My checkouts,
wish list, Community list).

---

## 2. How the integration works

```
WISE page (console / OPAC)                     Guide Engine backend
┌──────────────────────────────┐   script      ┌─────────────────────────────┐
│ GuideEngineService           │ ───────────▶  │ GET /agent/v1/<key>/guides.js│
│  window.guideEngine = {_q}   │               │                             │
│  <script src=…/guides.js>    │   JSON/text   │ POST /v1/agent/<key>/guides │  ← kill switches, app switch,
│  initialize({visitor,account})│ ───────────▶ │ POST /v1/agent/<key>/help   │    date window, account
│  identify(...) on user change│               │ POST /v1/agent/<key>/events │    allowlist, shown/finished
│  [data-guide-id="…"] anchors │               │ (per-app CORS, rate limit)  │    state per visitor
└──────────────────────────────┘               └─────────────────────────────┘
          ▲ authors                                        ▲
          │                                                │ Studio API (OIDC → org roles, RLS)
     Guide Studio (Angular) ────────────────────────────────┘
```

- **Routes.** Guides are matched on the URL path: exact (`/staff/console/circulation/check-in`) or
  pattern (`*` matches anything: `/wise-apps/opac/*/*/my-account/checkouts/*`,
  `/staff/console/customers/customer-record/*/activity`). Query strings are ignored.
- **Anchors.** A step targets `[data-guide-id="…"]`. The attribute is the integration contract between
  the apps and the content: renaming or removing one silently breaks a step (the engine fails closed —
  nothing shows, a `target_not_found` event is recorded). Put it on the clickable element itself; for
  shared components use an input (as the console's table does). Conditional elements (feature flags,
  permissions, "after the user acts") are fine for later steps (the card waits centered) but a *first*
  step whose anchor never appears means the guide never shows.
- **Help center.** The floating button appears when the app has at least one listed guide. A guide
  launched elsewhere than its page gets a "Go to another page?" confirmation and a normal page load to
  its start page with `?guideEngine=help:<id>`.
- **Analytics.** `guide_shown / step viewed / completed / dismissed / error`, help opens and searches,
  per guide and per account, in the Studio.

---

## 3. Running it locally

| What | Command / URL |
|---|---|
| Guide Engine DB + Keycloak | `npm run db:up` and `npm run idp:up` in the Guide Engine repository (Postgres :5433, Keycloak :8081, realm `guide-engine`; the test users are in [Studio login details](../../README.md#studio-login-details)) |
| Backend | `npm run dev:backend` (:3000) — the Studio's login needs it: `GET /api/auth/config` must answer or SSO has nowhere to go |
| Studio | `npm run start --workspace=apps/studio -- --port 4300` → http://localhost:4300 |
| Demo site | `npm run dev --workspace=apps/demo` (:5174) |
| WISE apps | the local WISE development stack (its proxy on port 10000; the console and OPAC containers mount the checkouts on `poc/guide-engine`) |
| Agent cache | the browser caches `guides.js` for 5 minutes; after a backend change, hard-reload |
| Seeing a guide again | automatic guides show once per visitor; open it from Help, or publish a new version |
| Authoring in bulk | the API: create guide → publish version body → enable (the POC used a script with a development token from `npm run mint-token`) |

The [project handbook](handbook.md#5-devops-in-short) has the full start and stop commands.

---

## 4. Signed identity (specified, not built)

The app key is public, so ids are spoofable until the WISE backend signs them. The generic contract
is [Signed identity](../integration/signed-identity.md); what the WISE API has to build is in
[Signed identity for the WISE API](signed-identity.md): two endpoints
(`GET /restapi/guide-engine/identity` for staff, `GET /restapi/opac/guide-engine/identity` for
patrons, 204 when anonymous), HS256 over the app's `ge_sk_…` secret, claims `visitor.id` /
`visitor.tags` (staff permission tags, same rule as the console; patron authorities, same rule as
the OPAC) / `account.id` / `exp`, 12 h lifetime; the console goes to **required** mode, the OPAC
stays **optional**. The frontend change afterwards is small (`initialize({ jwt })`).

---

## 5. TODO: productionalization

Ordered by dependency. ☐ = open. Items marked **(you)** need information or a decision only the WISE
side has.

### A. Guide Engine service

1. ☐ **(you)** Decide hosting (the `deploy/` single-host stack, or your platform) and provide the three
   hostnames (Studio, API, auth), an ACME email, and office/VPN CIDRs for `ADMIN_ALLOW_CIDRS`.
   The [DevOps handoff](../handoff-devops.md) lists the servers and decisions.
2. ☐ Fill `deploy/.env` from `.env.example` (DB passwords, Keycloak admin, `SECRETS_KEY`,
   `PREVIEW_TOKEN_SECRET`, `METRICS_TOKEN`, `ALERT_WEBHOOK_URL`, SMTP + `MAIL_FROM`, `SENTRY_DSN`).
   Work through the reference's [Go-live checklist](../../README.md#go-live-checklist) (13 items).
3. ☐ `deploy/render-realm.sh` for the production Keycloak realm (no demo users, brute-force protection);
   create the first Studio user and the first platform admin (`UPDATE studio_user SET platform_admin`).
4. ☐ **(you)** Add the `NPM_TOKEN` repository secret, then `git tag v0.3.0 && git push origin main v0.3.0`
   (publishes `@guide-engine/core` and the wrappers; the agent script itself is served by the backend).
5. ☐ Rehearse `deploy/restore.sh` once on a scratch host; set `BACKUP_COPY_CMD` for off-host copies.
6. ☐ Point Alertmanager at a real receiver and watch the rules for a week; adjust thresholds.
7. ☐ Run the Playwright smoke test against the deployed stack (`STUDIO_URL`, `API_URL`,
   `KEYCLOAK_USER/PASSWORD`, `SITE_ORIGIN`).
8. ☐ Fill the `[date]` placeholders in the [legal templates](../legal/index.md) if the Studio is
   offered to other organizations; otherwise skip.
9. ☐ Small product follow-ups noticed during the POC: a visible "can't reach the API" message on the
   Studio login page when `/auth/config` fails; a Studio UI for explicit guide priority (today:
   walkthroughs first, then server order).

### B. WISE applications

10. ☐ **(you)** Create the two applications in the production Studio, one per product, each with
    the [environments](../../README.md#environments-and-releases) **Dev → Test → Accept → Production**
    holding that stage's WISE site origins (a website belongs to one stage). Every WISE environment
    then uses the same key and signing secret per product: the page's origin tells Guide Engine
    the stage, guides are published to Dev and promoted towards Production (with revert), and
    analytics stay per stage (switch **Record analytics** off for Dev and Test if their numbers
    aren't wanted). Set `identityMode: required` on the console once
    [section 4](#4-signed-identity-specified-not-built) is live.
11. ☐ Fill `environment.prod.ts` (and the other WISE environment files) in both apps with the
    production API origin and that product's key (today `null` = guides off). Both apps are build-time configured; if you want per-deployment config,
    add a field to `/restapi/opac/configuration` (OPAC) / an app-config endpoint (console) and read it in
    `GuideEngineService` — the natural runtime alternative.
12. ☐ Implement the two [signed-identity endpoints](signed-identity.md) in the WISE REST API; wire the two
    `GuideEngineService`s to fetch the token and call `initialize({ jwt })` / `identify({ jwt })`.
13. ☐ Raise the `poc/guide-engine` branches as pull requests through the normal WISE process. Review
    points: the anchors are a public contract — consider an ESLint/template rule or a unit test that
    fails when a `data-guide-id` disappears; the design-system table inputs; `environment.*` changes;
    the git-ignored `environment.ts`/`environment.dev.ts` need the `guideEngine` field on every
    developer's machine (or a TS error).
14. ☐ Decide the **privacy wording** for patrons: the OPAC now sends an anonymous per-browser id and,
    when signed in, the patron system id plus guide events to Guide Engine. Mention it in the OPAC
    privacy notice; set the Studio's event retention (`EVENT_RETENTION_DAYS`) to match.
15. ☐ Cypress/e2e: both apps load no agent under the cypress configuration; confirm the WISE pipelines
    use it (otherwise the agent script would be fetched during e2e runs).

### C. Content

16. ☐ **(you)** Review the 43 guides' copy with product/UX and the support team; the help articles they
    were derived from are listed in the research notes (ask for the two candidate tables). Decide
    per guide: automatic vs help-only, and whether it belongs to every library (some anchors depend on
    library configuration: custom OPAC menus, feature flags on the console's Customers/Point of sale tabs).
17. ☐ Walk the OPAC's signed-in guides in a signed-in session (renew, holds, fines, details,
    notifications, lost card, requests, lists) — authored from source, not yet watched live.
18. ☐ Finish the help-center start pages: the OPAC entries point at branch **1400**; in production the
    start page needs the library's real branch id (or a branch-less route if the OPAC can resolve one).
19. ☐ Translations: the console runs in en, en_US, de_DE, nl_NL, nl_BE; the OPAC is multilingual. Guide
    copy is English only today; Guide Engine has no i18n yet (one guide per language, with an account or
    route split, is the workaround; proper i18n is on the Guide Engine roadmap).
20. ☐ Accessibility pass on the cards (focus order, screen-reader text for × and the spotlight) with
    the same accessibility bar the WISE apps already meet.
21. ☑ Console guides tagged with the permission each needs (table in
    [section 1.3](#13-studio-content-and-the-guide-catalogue)). Re-check the tags when screens'
    permission checks change, and tag new guides the same way.

### D. Known limitations to be aware of

- Anchors that exist only under a condition (End session only during a session, the on-the-fly
  dialog, Customers tab behind a feature flag, OPAC custom menus) make a *first* step wait and give up
  silently; those guides are help-only or start with a lead-in step for that reason.
- The app-key cache is per backend process (10 s); signing secrets are encrypted with one
  `SECRETS_KEY`; `guide_event` is unpartitioned; invitation mail is plain SMTP — all documented under
  [Known gaps and roadmap](../../README.md#known-gaps-and-roadmap) in the reference.
- The local WISE development containers watch bind mounts; after large template changes, a container
  restart is sometimes needed for the dev server to pick them up.
