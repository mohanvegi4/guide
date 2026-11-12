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

**Docs site:** https://mohanvegi4.github.io/guide/ is built from this README, the
[Studio README](apps/studio/README.md) and [`docs/`](docs/index.md). Legal templates for running
Guide Engine as a hosted service (terms, privacy policy, DPA, subprocessors) are in
[`docs/legal/`](docs/legal/).

---

## Contents

- [How it works](#how-it-works)
- [Repository layout](#repository-layout)
- [Quick start (local)](#quick-start-local)
- [Testing](#testing)
- [Known gaps and roadmap](#known-gaps-and-roadmap)

## Documentation

| Read | For |
|---|---|
| [Installing Guide Engine](docs/install.md) | the snippet, `data-guide-id`, signed identity, how a guide is chosen, the help center |
| [Studio reference](apps/studio/README.md) | signing in, roles, authoring, environments and releases, saved pages, analytics |
| [Identity, roles and security](docs/security.md) | roles, sign-in, signed identity, platform administration and support access |
| [Configuration and API reference](docs/reference.md) | environment variables, every endpoint, the data model |
| [Deploying and operating](docs/operations.md), [DevOps handoff](docs/handoff-devops.md) | first install, go-live checklist, everyday tasks, backups, monitoring, troubleshooting; the first deployment at OCLC |
| [Architecture overview](docs/architecture-overview.md), [How Guide Engine is built](docs/architecture.md) | how it fits together, in one page and in depth |
| [WISE integration](docs/wise/index.md) | Guide Engine in the WISE staff console and the OPAC |

---

## How it works

An install snippet on the customer's website loads the **agent** from the **backend** with the
app's public key. The agent asks which guides apply to this visitor, matches them to the current
URL, waits for the `data-guide-id` element, draws the step in a Shadow DOM card and reports what the
visitor did. Authors write and publish guides in the **Studio**, which talks to the same backend
through its `/api` proxy and signs in through an OIDC provider (Keycloak). Postgres is the only
store, with row-level security on every tenant table.

- A guide is saved as a draft, previewed on the real site with a signed 15-minute link, published
  as an immutable version, released stage by stage through the app's environments, and enabled.
- Visitors see one guide at a time. An automatic guide shows **once per visitor** until a newer
  version is published; the help center lets them replay any listed guide.
- Anything that can't be verified shows nothing, and the agent never throws into the host page.

The [Architecture overview](docs/architecture-overview.md) has the diagrams, and
[How a guide is chosen and shown](docs/install.md#how-a-guide-is-chosen-and-shown) the details.

---

## Repository layout

An npm workspaces monorepo; run commands from the repo root.

```
packages/
  embed-agent/       the browser side: the engine (src/engine) and the install-snippet runtime,
                     bundled into one ~10 KB IIFE served at /embed-agent/v1/<key>/guides.js
apps/
  backend/           @guide-engine/backend: Express + Postgres — Studio API, agent API, migrations, scripts
  studio/            Guide Studio (Angular 21) — see apps/studio/README.md
  demo/              a plain host page that installs Guide Engine via the snippet
e2e/                 Playwright smoke test: Keycloak sign-in → org, app, guide → the snippet on a page
docker/              local dev: docker-compose.yml (Postgres :5433, Keycloak :8081), init.sql, keycloak/ realm
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
cp apps/backend/.env.example apps/backend/.env
```

Edit `apps/backend/.env`. Set `JWT_SECRET` and `PREVIEW_TOKEN_SECRET` to two **different**
values, each from `openssl rand -hex 32`.

```bash
npm run build                                    # all packages, including the agent bundle
npm run migrate                                  # applies apps/backend/migrations/*.sql
npm run seed --workspace=apps/backend            # dev org + app + demo config + a Studio sign-in token
npm run dev:backend                              # API on http://localhost:3000
```

In two more terminals:

```bash
npm run dev:studio                               # Studio: http://localhost:4300
```

```bash
npm run dev:demo                                 # demo site: http://localhost:5174
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
| When | Default; no extra setup | After `npm run idp:up` and `OIDC_ISSUER=http://localhost:8081/realms/guide-engine` in `apps/backend/.env` (restart the backend) |
| User | **Mohan Vegi** (`vegim@oclc.org`), owner of **Demo Org** / **Demo site** | `vegim` (Mohan Vegi, `vegim@oclc.org`), `editor` (an org editor) or `root` (Guide Engine Admin) |
| Credentials | The token `npm run seed` prints (valid 8 h) | Password = username (`vegim` / `vegim`, …). Admin console at http://localhost:8081, `admin` / `admin` |
| Where | Login page → **Developer sign-in (paste a token)** → paste → **Sign in** | Login page → **Sign in with SSO** → Keycloak's form |

Notes:
- A new token for the seeded user, or for any other dev user (new users start with no organization):
  ```bash
  npm run mint-token --workspace=apps/backend -- --sub vegim --email vegim@oclc.org --name "Mohan Vegi"
  ```
- Each Keycloak user is one Studio user, so `vegim` keeps their organizations across sign-ins.
  Add more people in the Keycloak admin console (realm **guide-engine → Users**) to try the
  roles, and invite them from **Members**. `root` is meant to become the platform admin.
- SSO users are *not* members of the seeded Demo Org (identity comes from the provider,
  memberships from our database). A new SSO user lands on **Welcome** to create their own
  organization, or accepts an invitation link from the seeded user.
- Production: set `OIDC_ISSUER` to your real provider; the token login is disabled outside
  development and test.
- To administer Guide Engine itself, give your own user the platform-admin flag: see
  [Guide Engine administration](docs/security.md#guide-engine-administration).

```bash
npm run idp:up      # Keycloak on http://localhost:8081 with the guide-engine realm imported
```

---

## Testing

```bash
npm run db:up && npm test                 # every workspace
npm test --workspace=apps/backend         # real Postgres (DB guide_engine_test, rebuilt each run)
npm test --workspace=packages/embed-agent       # engine + snippet runtime: vitest + jsdom
npm test --workspace=apps/studio          # Studio components and services
```

| Suite | Tests | Covers |
|---|---|---|
| **Backend** | 277 | self-serve orgs; apps and settings; the role matrix; invitations; members; saved pages; platform admins and support access (consent, read-only, logging, RLS); secrets at rest, the shared rate limiter, retention (events and agent errors), production boot checks; the agent script's ETag / 304 / cache headers and the version endpoint; the security headers (and that the agent surface keeps only nosniff); agent error reports (validation, the hourly cap, the Studio list, RLS isolation, platform counts); org/app isolation through the API **and directly in RLS** (including replaying the owner bootstrap and forging memberships); the agent API (origins, keys, identity modes, account targeting, kill switches, events and per-visitor state, preview); the guide lifecycle; sanitization; stable step ids; analytics; OIDC (a local JWKS server, algorithm confusion); environments, releases, promote / revert and per-environment analytics; concurrent migration runs (the advisory lock); and the pending-migrations boot check |
| **Agent** | 142 | the engine (route matching, retries, events, preview) and the snippet runtime; includes the help widget (search, keyboard, safe rendering), help launches (same page, other page, arrival, shared links), error reporting (sampling, the per-page cap, never throwing), `openHelp` queued before load and the build-time version |
| **Studio** | 58 | guide list and editor (saved pages), Pages, app settings (including the agent-error list), the Administration page |

Type-checking is part of every `test` script, with strict TypeScript throughout.

**End-to-end smoke test** (`e2e/`, Playwright, Chromium). One browser flow proves the whole
product works together: sign in to the Studio through Keycloak (`vegim` / `vegim`), create an
organization with a first app, read the public key from the install snippet, create, publish
and enable a guide, then open a page that installs the snippet with that key and see the guide.
The page is served from a Playwright route at `http://e2e.localhost` (the origin the app's
websites list gets), so no extra server is needed; the agent script and API are the real
backend's. It runs against an already-running stack: Postgres (`npm run db:up`), Keycloak
(`npm run idp:up`, with `OIDC_ISSUER` set in `apps/backend/.env`), the backend on :3000 and
the Studio on :4300. Then:

```bash
npx playwright install chromium          # once
npm run e2e                              # STUDIO_URL / API_URL / KEYCLOAK_USER / KEYCLOAK_PASSWORD override the defaults
```

Each run creates a new organization (`E2E <timestamp>`) for `vegim` and deletes it at the end
through the Studio's danger zone, even when an earlier step failed, so it can be repeated against
the same database without leaving anything behind. On failure, `e2e/playwright-report/` holds the report with a trace
(`npx playwright show-trace e2e/test-results/<run>/trace.zip`). CI runs it in the `e2e` job
after the unit tests, starting the same services from `docker/docker-compose.yml`.

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
- **Deferred:** metadata segments, surveys, i18n, rollout percentages, cross-app guides and a
  visual point-and-click designer.
