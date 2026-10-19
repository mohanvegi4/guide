# Implementation Prompt: Custom In-App Guide Engine

Copy everything below into your LLM/agent session (e.g. Claude Code) along with the attached `guide-engine.zip` starter repo, or use it standalone to build from scratch.

**If running in Claude Code**: this repo includes a `CLAUDE.md` at its root with the same design decisions and conventions repeated in Claude Code's expected format — it will be picked up automatically. This prompt is the fuller task list; `CLAUDE.md` is the always-on reference. Keep them in sync if either changes.

---

## Role & Objective

You are implementing a **multi-tenant, in-app guide/tour engine** (a lightweight in-house alternative to Pendo/WalkMe) for a web application built with **Angular and Vue** frontends. Non-engineers author guides (tooltips, modals, banners, tours, checklists) via an admin UI; a runtime SDK embedded in the product renders them to end users. There is a starter repo attached — **read it fully before writing any code**, understand what's already implemented vs. stubbed, and extend it rather than rewriting from scratch.

Work incrementally: implement one numbered task at a time, run builds/tests after each, and report status before moving to the next. Do not skip ahead to later tasks if an earlier one has unresolved errors.

---

## System Overview

Four components:
1. **Runtime SDK** (`packages/core`) — framework-agnostic TS engine + DOM renderer, embedded in the product
2. **Framework wrappers** (`packages/angular-wrapper`, `packages/vue-wrapper`) — thin adapters exposing the engine idiomatically to each framework
3. **Backend** (`packages/backend`) — Express + Postgres API: guide CRUD, publish/rollback, flag toggles, event ingestion
4. **Authoring Studio** — admin UI for creating/editing/publishing guides (not yet built — this is a primary task below)

## Core Design Decisions (do not relitigate these — they were made deliberately)

- **Multi-tenant**: every guide belongs to a tenant, or is `is_global` (visible to all tenants). Tenant isolation is enforced twice — application-level (`WHERE tenant_id = ...` on every query) and database-level (Postgres Row-Level Security policies keyed on a `current_setting('app.current_tenant_id')` session variable). Never trust a client-supplied tenant id; it must come from the authenticated session only.
- **Flag-driven enablement, not segment targeting**: the primary control is a boolean `enabled` flag per guide, plus a global kill switch and a per-tenant kill switch. Audience/segment rules (by user attribute) are explicitly deferred — do not build them unless a task below asks for it.
- **No external analytics integration**: guide events (`guide_shown`, `guide_step_viewed`, etc.) are stored in the engine's own Postgres tables. There is no webhook/export requirement.
- **Selector convention**: guides target elements via `data-guide-id="..."` attributes (set by framework directives), not raw CSS classes — this is intentional for resilience against markup refactors.
- **Fail closed, fail silent**: if the backend is unreachable or a kill switch check fails, the SDK disables itself rather than risk showing something unverified, and never throws into or blocks the host app.
- **Scale is intentionally unoptimized for v1**: single Postgres instance, no message queue, no analytics warehouse. Do not introduce Kafka/Kinesis/Redis/etc. unless a task explicitly calls for it — resist over-engineering.

---

## Current State of the Starter Repo (read `README.md` in the zip for full detail)

**Implemented and type-checks clean (`tsc` passes for all 4 packages):**
- `packages/core`: `GuideEngine` state machine (matching → showing → step progression → completed/dismissed/error), route re-evaluation on SPA navigation, target-not-found retry with backoff, batched fire-and-forget event queue, a default Shadow-DOM renderer
- `packages/backend`: Express routes for guide CRUD, `/guides/:id/publish`, `/guides/:id/rollback/:version`, `PATCH /guides/:id/flag`, `GET /guides/active`, `POST /events` (batched via `UNNEST`), `GET /system/flag` (global + tenant kill switch)
- `packages/backend/migrations/001_init.sql`: full multi-tenant schema with RLS policies, an `active_guide` view, and appropriate indexes
- `packages/angular-wrapper`: `GuideService` (hooks `Router` `NavigationEnd`), `GuideAnchorDirective` (`[guideAnchor]="'id'"` → `data-guide-id`)
- `packages/vue-wrapper`: `GuidePlugin` (hooks `vue-router` `afterEach`), `vGuideAnchor` directive, `useGuideEngine()` composable

**Explicitly stubbed — these are your first tasks:**
- `packages/backend/src/middleware/tenant.ts`: `verifyAndDecodeToken()` throws by default; only a `GUIDE_ENGINE_DEV_AUTH=true` dev bypass exists (parses `tenantId:userId` from the bearer token — insecure, dev-only)
- No HTML sanitization anywhere on the guide-content write path
- No Authoring Studio UI exists at all — guides are currently authored via raw `curl`/API calls

---

## Tasks (implement in order; treat each as a checkpoint)

### Task 1 — Real authentication
Replace the stub in `middleware/tenant.ts` with real JWT verification:
- Use the `jsonwebtoken` package (or your existing auth provider's SDK if this connects to an existing user system — ask if unspecified)
- Token should carry `tenantId` and `userId` claims; verify signature against an env-configured secret/JWKS
- Keep the `GUIDE_ENGINE_DEV_AUTH` escape hatch for local dev, but make it impossible to enable accidentally in a non-local environment (e.g. also require `NODE_ENV !== 'production'`)
- Add a basic integration test proving a request with an invalid/missing token gets 401, and a valid token populates `req.tenantId`/`req.userId` correctly

### Task 2 — Content sanitization
- Add `DOMPurify` (or `sanitize-html` for server-side use, since `DOMPurify` needs a DOM environment — use `jsdom` + `DOMPurify`, or `sanitize-html` directly) on the backend
- Sanitize `step.content` in the `POST /guides/:id/publish` handler before it's persisted to `guide_version.steps`
- Add a test: submit a step with a `<script>` tag in `content`, assert it's stripped on the stored/returned version

### Task 3 — Authoring Studio (admin UI)
Build a minimal but functional admin UI. Ask the user which frontend stack to use for this internal tool if unspecified (Angular and Vue are both already in play for the main product — reusing one is simplest, but this is a separate app and doesn't have to match).

Minimum feature set:
- List guides for the current tenant (name, type, status, enabled toggle)
- Create guide (name + type)
- Edit steps (add/remove/reorder steps; per step: type, target selector, content via a simple textarea — rich WYSIWYG is out of scope for v1), route match config, start/end dates
- Publish button (calls `/guides/:id/publish`), with version history + rollback
- Enabled/disabled toggle wired to `PATCH /guides/:id/flag`
- Basic analytics view: call `/guides/:id/analytics` and render the counts as a simple table/bar chart

Do not build a drag-and-drop visual DOM-overlay editor — the scope doc explicitly calls this out as unnecessary engineering cost for v1. Form-based editing is sufficient.

### Task 4 — Preview mode
- Add a signed preview token mechanism: Authoring Studio generates a link like `https://app.example.com/dashboard?guidePreview=<signed-token>`
- SDK checks for this query param at init; if present and the signature is valid, it fetches and force-renders that specific guide/version regardless of `enabled` status or publish state
- Token should encode `guideId` + `versionId` + short expiry (e.g. 15 minutes), signed server-side

### Task 5 — Tests
- Backend: integration tests (e.g. with `supertest` + a test Postgres database, or `pg-mem` if a real DB isn't available in the test environment) covering the full guide lifecycle: create → publish → fetch active → flag off → confirm it disappears from `/guides/active`
- Core engine: unit tests for the state machine — guide matches route, target-not-found retries then errors after max attempts, event queue batches and flushes correctly
- Explicitly test tenant isolation: tenant A cannot fetch, publish, or see analytics for tenant B's guide (expect 404, not a data leak)

### Task 6 (only if requested) — Segment/audience targeting
Not required for v1. Only build this if explicitly asked in a follow-up — otherwise stop after Task 5 and report what's done.

---

## Constraints & Conventions

- **Language/tooling**: TypeScript everywhere, strict mode on (see `tsconfig.base.json` in the starter repo — extend it, don't loosen it)
- **No new heavy infrastructure** (queues, caches, search indexes) unless a task explicitly requires it
- **Every new backend route must be tenant-scoped** using the existing `withTenant()` helper in `db.ts` — do not write raw `pool.query()` calls against tenant-scoped tables
- **Every migration** goes in `packages/backend/migrations/` as a new numbered `.sql` file — never edit `001_init.sql` after the fact
- **Match existing code style** in the starter repo (comments explaining *why*, not just *what*; explicit error handling; fail-closed defaults)
- Run `npx tsc --noEmit` (or the package's `build` script) after every task and fix all errors before moving on
- If a requirement is ambiguous or you're about to make an architectural choice not covered above, stop and ask rather than guessing

## Deliverables per task
For each task: the code changes, a one-paragraph summary of what changed and why, the test/build output proving it works, and an explicit list of anything left TODO or any assumption you made that the user should confirm.

## If you are Claude Code specifically
- Treat `CLAUDE.md` at the repo root as authoritative for conventions/workflow; this document is authoritative for the task list and rationale.
- Use TodoWrite (or equivalent task tracking) to track the six tasks above as a checklist across the session, checking each off only once its build/tests pass.
- Prefer running the package-scoped build/test commands listed in `CLAUDE.md` over ad-hoc commands, so output is consistent and easy to review.
- Don't use `git commit` without being asked — surface a diff/summary and let the user decide when to commit.
