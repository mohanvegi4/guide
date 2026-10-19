# CLAUDE.md

This file gives Claude Code project-level context. Read this before making any changes.

## What this repo is
A multi-tenant in-app guide/tour engine (in-house Pendo/WalkMe alternative). See
`README.md` for setup and `GUIDE_ENGINE_IMPLEMENTATION_PROMPT.md` for the full
task list and design rationale — read both before starting work.

## Repo layout
```
packages/
  core/              framework-agnostic engine (state machine + DOM renderer)
  backend/           Express + Postgres API
  angular-wrapper/   @guide-engine/angular
  vue-wrapper/       @guide-engine/vue
```
This is an npm workspaces monorepo. Run commands from the repo root unless a
task is scoped to one package (`npm run build --workspace=packages/backend`).

## Non-negotiable design decisions
Do not relitigate or "improve" these without being asked — they were chosen
deliberately for this project's scale and constraints:
- **Multi-tenant**, enforced twice: app-level (`WHERE tenant_id = ...`) and
  DB-level (Postgres RLS via `current_setting('app.current_tenant_id')`).
  Never trust a tenant id from client input — only from the authenticated session.
- **Flag-driven enablement**, not segment/audience targeting. A boolean
  `enabled` per guide + global/per-tenant kill switches are the whole v1
  targeting story. Don't build segment rules unless explicitly asked.
- **No external analytics integration.** Events live in this repo's own
  Postgres tables. No webhook/export requirement.
- **`data-guide-id` selector convention**, not raw CSS classes/selectors.
- **Fail closed, fail silent**: SDK disables itself on any backend/kill-switch
  check failure rather than risk showing something unverified; never throws
  into or blocks the host app.
- **No new infrastructure** (queues, caches, search, analytics warehouses)
  unless a task explicitly calls for it. Single Postgres instance is the v1 target.

## Conventions to follow
- TypeScript strict mode everywhere (extend `tsconfig.base.json`, don't loosen it)
- Every new backend route touching a tenant-scoped table uses the existing
  `withTenant()` helper in `packages/backend/src/db.ts` — never a raw `pool.query()`
  against `guide`, `guide_event`, or `user_guide_state`
- New migrations are new numbered files in `packages/backend/migrations/` —
  never edit `001_init.sql` after the fact
- Comments explain *why*, not just *what*; prefer explicit error handling and
  fail-closed defaults over optimistic assumptions
- Match existing code style rather than introducing a new pattern for the same problem

## Required workflow for every task
1. Read the relevant existing files fully before editing
2. Make the change
3. Run the build/typecheck for every package you touched:
   - `npm run build --workspace=packages/<name>`
   - or `npx tsc --noEmit -p packages/<name>/tsconfig.json`
4. Run/add tests where the task calls for them (see implementation prompt for
   which tasks require tests)
5. Report: what changed, why, the build/test output, and anything left TODO
   or any assumption made that should be confirmed with the user
6. Do not proceed to the next task in the implementation prompt if the
   current one has unresolved build errors

## Things to stop and ask about, rather than guess
- Any architectural choice not already covered by an existing pattern in this repo
- Which frontend stack to use for the Authoring Studio (see implementation prompt, Task 3)
- Whether to integrate with an existing auth/user system vs. a standalone JWT scheme
- Anything that would require adding new infrastructure

## Common commands
```bash
npm install                                    # from repo root, installs all workspaces
npm run build                                  # builds all packages
cd packages/backend && npm run migrate         # applies pending migrations
cd packages/backend && npm run dev             # starts backend on :3000 with hot reload
```
