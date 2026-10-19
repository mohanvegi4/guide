# Guide Engine — Implementation Starter

A working scaffold for the custom in-app guide engine we scoped: multi-tenant,
flag-driven enablement, Angular + Vue support. Everything here compiles
(`tsc` verified for all four packages) but has **not** been run against a
live database — see "What's real vs. stubbed" below before you rely on it.

## Structure

```
guide-engine/
  packages/
    core/              framework-agnostic engine (state machine + DOM renderer)
    backend/           Express + Postgres API
    angular-wrapper/   @guide-engine/angular — service + directive
    vue-wrapper/       @guide-engine/vue — plugin + directive
```

## Getting it running locally

1. **Postgres**: spin up a local instance, then create the DB:
   ```bash
   createdb guide_engine
   ```
2. **Backend**:
   ```bash
   cd packages/backend
   cp .env.example .env      # edit DATABASE_URL if needed
   npm install
   npm run migrate           # applies migrations/001_init.sql
   npm run dev                # starts on :3000
   ```
3. **Smoke test** (dev auth is on via `.env`, using `tenantId:userId` as the bearer token):
   ```bash
   curl -X POST http://localhost:3000/guides \
     -H "Authorization: Bearer <tenant-uuid>:dev-user" \
     -H "Content-Type: application/json" \
     -d '{"name":"Welcome tour","type":"tooltip"}'
   ```
   You'll need a real row in the `tenant` table first — insert one manually
   (`INSERT INTO tenant (name) VALUES ('Acme') RETURNING id;`) and use that id.

4. **Frontend wrappers**: build with `npm run build` from the repo root, then
   `npm link` (or point your app's `package.json` at the local `packages/*`
   paths) to consume `@guide-engine/core`, `@guide-engine/angular`, or
   `@guide-engine/vue` from your Angular/Vue app.

## What's real vs. stubbed — read this before using it anywhere near production

**Solid / implemented:**
- Core engine state machine (matching → showing → step progression → completed/dismissed), route re-evaluation, target-not-found backoff, event batching
- Default Shadow-DOM renderer (tooltip/modal/banner visual, wired to Next/Dismiss)
- Full multi-tenant Postgres schema with Row-Level Security policies
- Express routes for guide CRUD, publish/rollback, flag toggle, active-guide fetch, batched event ingestion, global+per-tenant kill switch
- Angular and Vue wrappers: router-driven route re-evaluation, anchor directives

**Deliberately stubbed — you must finish these before shipping:**
- **Auth** (`packages/backend/src/middleware/tenant.ts`): the real `verifyAndDecodeToken` throws by default. There's a `GUIDE_ENGINE_DEV_AUTH=true` escape hatch for local testing only — wire up real JWT/session verification before deploying anywhere.
- **Authoring Studio UI**: not built yet — right now you author guides via raw API calls (`POST /guides`, `POST /guides/:id/publish`). A form-based admin UI is the natural next piece.
- **HTML sanitization**: `step.content` is rendered as-is by the DOM renderer. The scope doc calls for sanitizing on save (author side) — add that (e.g. `DOMPurify`) in whatever authoring path you build, before content ever reaches this renderer.
- **`useGuideEngine()` in Vue** relies on `app.provide`, so it only works for components rendered under that app instance — fine for typical SPAs, just don't call it outside a `setup()` context.

## Not yet ported into this repo (from the scope doc)
Segment/audience targeting, surveys, i18n, rollout percentages, cross-tenant
super-admin reporting — all intentionally deferred to Phase 2/3 per the
phased plan.
