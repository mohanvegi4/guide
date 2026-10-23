# CLAUDE.md

This file gives Claude Code project-level context. Read this before making any changes.

## What this repo is
A public, multi-tenant in-app guide product, a lightweight alternative to Pendo or WalkMe.
- **Organizations** (customers of Guide Engine) own **applications**.
- Each application gets an **install snippet** with a **public app key**, which goes in the
  `<head>` of its website.
- Authors manage guides in the **Studio**.

See `README.md` for setup and the full reference. `GUIDE_ENGINE_IMPLEMENTATION_PROMPT.md` is
the original (OCLC-era) task list and rationale.

## Repo layout
```
packages/
  core/              framework-agnostic engine (state machine, transport, DOM renderer)
  agent/             the install-snippet agent: IIFE bundle served at /agent/v1/<key>/guides.js
  backend/           Express + Postgres API (Studio API + public agent API)
  angular-wrapper/   @guide-engine/angular (optional npm alternative to the snippet)
  vue-wrapper/       @guide-engine/vue (optional npm alternative to the snippet)
apps/
  studio/            Authoring Studio (Angular 21)
  demo/              a plain host page that installs Guide Engine via the snippet
```
This is an npm workspaces monorepo. Run commands from the repo root unless a
task is scoped to one package (`npm run build --workspace=packages/backend`).

## Non-negotiable design decisions
Do not relitigate or "improve" these without being asked. They were chosen
deliberately for this project's scale and constraints:
- **Organizations → applications, isolated twice.**
  - App level: every query filters by `app_id` / org.
  - Database level: Postgres RLS, with policies that read only **session variables**.
    `withStudioSession` sets them from the verified user's memberships; `withAgentSession`
    sets them from a public key.
  - Never trust an org, app or user id from request input.
- **Studio identity comes from OIDC (identity only).**
  - Organizations, memberships and roles live in our database.
  - One organization-wide role per person: viewer < editor < manager < owner. It applies to
    every app of the org; there are no per-app grants (the `app_member` table is empty and unused).
    Internally the backend derives an `AppRole` (viewer | app_admin) from it for the existing
    per-app route checks; destructive app actions (delete, key rotation, forget visitor) are
    gated by `requireAppManager` (manager+) and, in the database, by `app.manager_app_ids`
    (policies + the `application_guard_keys` trigger, migration 017).
  - HS256 dev tokens exist only in development/test.
- **Above organizations, Pendo-style (migration 009).**
  - `studio_user.platform_admin` (granted by SQL, then from the Administration page) runs the
    service through `withPlatformSession`: organizations, apps, members, counts — the
    `*_platform_select` policies never include guide_version / app_page / user_guide_state.
  - A customer's content is readable only under **support access**: the org OWNER sets
    `organization.support_access_until` (≤ 90 days). `withSupportSession` then shapes the
    session as a viewer of that org, in a READ ONLY transaction, and logs every request to
    `support_access_log`. The `X-Support-Org` header selects it (routes/studio/context.ts).
  - Never add a write path for platform admins into customer data, and never let the flag
    be self-granted.
- **The app key is public.** End users are identified by the visitor/account ids the host
  page passes in. Each app can require a server-signed identity JWT (per-app secret). Each
  app's websites list is enforced via CORS.
- **Flag-driven enablement + an account allowlist + visitor tags.** That means a guide `enabled`
  flag, an app switch, a global kill switch, an optional per-version `account_ids` list, and an
  optional per-version `visitor_tags` list (migration 020) matched by overlap against the opaque
  `visitor.tags` the host passes or signs. Don't build metadata segments (attributes, rules,
  operators) unless explicitly asked.
- **No external analytics integration.** Events live in this repo's own Postgres tables.
- **`data-guide-id` selector convention**, not raw CSS classes/selectors.
- **Fail closed, fail silent.** The agent shows nothing when anything can't be verified, and
  never throws into or blocks the host page.
- **No new infrastructure** (queues, caches, search, analytics warehouses) unless a task
  explicitly calls for it. Postgres is the only store: the agent rate limiter counts in
  Postgres in production (`RATE_LIMIT_STORE`), in memory in development. Keycloak is the
  identity provider in every environment (`docker/keycloak/`, `deploy/`).

## Conventions to follow
- TypeScript strict mode everywhere (extend `tsconfig.base.json`, don't loosen it)
- **Database access:** every query on a scoped table goes through `withStudioSession()` /
  `withAgentSession()` / `withIdentity()` in `packages/backend/src/db.ts`. Never use a raw
  `pool.query()` against guide / guide_version / guide_event / user_guide_state /
  organization / application / app_page / *_member / invitation / studio_user.
- **Saved pages** (`app_page`): guide versions reference them by `page_id`, and whatever
  serves a guide's route (the `active_guide` view, preview) must resolve it through the page.
  `route_match` on such a version is only a fallback snapshot.
- **Studio routes** resolve access with `requireOrgRole` / `requireAppRole`
  (`src/routes/studio/context.ts`). Unknown or other people's ids answer 404; insufficient
  role answers 403.
- **Migrations** are new numbered files in `packages/backend/migrations/`. Never edit one
  that has been applied anywhere.
- Comments explain *why*, not just *what*. Prefer explicit error handling (`HttpError`) and
  fail-closed defaults over optimistic assumptions.
- **Studio `effect()`s that load data** must call the API inside `untracked()`. The HTTP
  interceptor reads the auth token signal, which would otherwise re-run the effect on every
  token change.
- Match existing code style rather than introducing a new pattern for the same problem.

## Required workflow for every task
1. Read the relevant existing files fully before editing
2. Make the change
3. Run the build/typecheck for every package you touched (`npm run build --workspace=<name>`)
4. Run/add tests (`npm test --workspace=<name>`; backend needs `npm run db:up`)
5. Report: what changed, why, the build/test output, and anything left TODO
   or any assumption made that should be confirmed with the user
6. Don't move on while a task has unresolved build errors

## Things to stop and ask about, rather than guess
- Any architectural choice not already covered by an existing pattern in this repo
- Anything that would require adding new infrastructure
- Changes to the security model (RLS policies, identity verification, roles)

## Common commands
```bash
npm install                                    # from repo root, installs all workspaces
npm run db:up                                  # Postgres 16 in docker on :5433 (non-superuser app role)
npm run idp:up                                 # optional: Keycloak on :8081 (realm guide-engine) for Studio SSO
npm run retention --workspace=packages/backend -- --days 400   # delete old events now
npm run encrypt-secrets --workspace=packages/backend           # after turning on SECRETS_KEY
npm run build                                  # builds all packages (core first; agent bundle via esbuild)
npm run migrate                                # builds backend + applies pending migrations
npm test                                       # all workspace tests (backend needs db:up)
npm run dev:backend                            # backend on :3000 with hot reload
npm run seed --workspace=packages/backend      # dev org + app + demo .env.local + a Studio dev token
npm run mint-token --workspace=packages/backend -- --sub <id> [--email <e>]   # dev Studio token
npm run sign-identity --workspace=packages/backend -- --secret <ge_sk_…> --visitor <id> [--account <id>] [--tags a,b]
```
