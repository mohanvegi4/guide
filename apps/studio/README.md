# Guide Studio

The authoring UI for Guide Engine. Product people use it to create, preview, publish and measure
in-app guides without touching code. It's built with Angular 21 standalone components, signals
and reactive forms. For the overall system, see the [root README](../../README.md).

## Running it

The backend must be running on `:3000` first (see the root README's quick start).

```bash
npm run start --workspace=apps/studio -- --port 4300   # http://localhost:4300
```

The dev server proxies `/api/*` to `http://localhost:3000` and strips the `/api` prefix
([`proxy.conf.json`](proxy.conf.json)), so the Studio never needs CORS. In production, a reverse
proxy in front of the static build must do the same.

```bash
npm run build --workspace=apps/studio   # -> dist/studio/browser (static files; needs an SPA fallback)
npm test --workspace=apps/studio        # unit tests (vitest via the Angular builder)
```

## Signing in

The login page asks the backend how to sign in (`GET /api/auth/config`):

- **Sign in with SSO.** Shown when the backend has `OIDC_STUDIO_CLIENT_ID` set.
  - Uses OpenID Connect Authorization Code + PKCE, via `oidc-client-ts`.
  - The provider redirects back to `/auth/callback`; register that URI, plus `/login` for logout.
  - The session lives in `sessionStorage`, so it ends when the tab closes. It renews silently if
    the provider issues refresh tokens.
- **Paste a token.** For local development, or when no SSO is configured. Mint one with:
  ```bash
  npm run mint-token --workspace=packages/backend -- --tenant <tenant-id> --user you --role guide_admin
  ```

Either way, the Studio asks the backend who you are (`GET /api/auth/me`) and shows only what your
roles allow. It never decodes tokens itself. The backend enforces roles on every request anyway.

| Role | What you see |
|---|---|
| `guide_admin` | **Guides**: your tenant's own guides. |
| `platform_admin` | **Global guides**: guides shown to *every* tenant. Analytics are totals across all tenants. |

If your session expires, any request returning 401 sends you back to the login page.

## Working with a guide

1. **Create.** On the list page, enter a name and type. New guides are disabled and have nothing
   published.
2. **Where and when.**
   - **Route match:** *Exact path* (`/dashboard`), or *Pattern*, where `*` matches anything
     (`/projects/*`). Query strings are ignored.
   - **Start / End** (optional): the guide only shows between these times.
3. **Steps.** Use **+ Add step**, **↑ / ↓** to reorder and **Remove**. For each step:
   - **Anchor (data-guide-id):** the element to point at. Engineers set it with
     `[guideAnchor]="'invite-button'"` (Angular) or `v-guide-anchor="'invite-button'"` (Vue).
     Leave it blank for a centered card.
   - **Position:** top / bottom / left / right / center.
   - **Content:** HTML. Scripts, styles, event handlers, iframes and `javascript:` / `data:` URLs
     are removed when you save. If nothing is left, saving fails with a message.
   - **Buttons:** `next` (go to the next step), `complete` (finish), `dismiss` (close). `back` is
     accepted but the default renderer doesn't handle it yet.
4. **Save draft.** Stores your work without going live. There is one draft per guide; saving again
   updates it.
5. **Preview.** Saves the draft and gives you a **15-minute link** into the product (copy it or
   **Open preview**). It shows exactly this version, even if the guide is disabled or unpublished,
   with a "Preview" badge. It sends no analytics. You must be signed in to the product as a user of
   the same tenant. **Preview** in the Versions panel previews any older version.
6. **Publish new version.** Makes what's in the editor live as the next version number. Published
   versions can never be changed.
7. **Enabled.** The on/off switch, at the top right of the editor or in the list. Nothing shows to
   end users until a version is published **and** the guide is enabled.
8. **Versions.**
   - **Roll back to this:** makes an older published version live again.
   - **Load into editor:** starts a new edit from any version.

### End users and versions

When someone dismisses or completes a guide, they won't see it again until you **publish a newer
version**. Use this for important updates. Rolling back to an older version does *not* show it to
them again.

### Analytics

- **Totals per event:**
  - `guide_shown`: first step displayed;
  - `guide_step_viewed`: later steps displayed;
  - `guide_step_completed`;
  - `guide_completed`;
  - `guide_dismissed`;
  - `guide_error`: usually the anchor element wasn't found on the page.
- **Per step:** views, done and dismissed for each step of the live version. Steps keep their
  identity across edits, so their numbers carry over between versions. Events for steps you've since
  deleted are grouped under **Removed steps**.
- Click **Refresh** to reload. Counts are your tenant's own; for global guides, platform admins see
  totals across all tenants.

## Code map

```
src/app/
  core/
    auth.service.ts        sign-in (SSO + paste), session restore, roles (from /auth/me)
    auth.interceptor.ts    adds the bearer token; 401 -> login
    auth.guard.ts          roleGuard(role) for routes (UX only; the backend enforces)
    api.service.ts         typed client; scope 'tenant' -> /api/guides, 'global' -> /api/platform/guides
    models.ts              request/response types (mirror packages/backend routes)
  pages/
    login.component.ts         SSO button and/or paste-a-token
    auth-callback.component.ts finishes the OIDC redirect
    guide-list.component.ts    list, create, enable toggle (optimistic, reverts on error)
    guide-editor.component.*   form editor, draft/preview/publish, preview link panel
  components/
    version-history.component.ts  versions, rollback, preview, load-into-editor
    analytics.component.ts        totals + per-step funnel (CSS bars, no chart library)
  app.routes.ts            /guides, /guides/:id (tenant) · /global, /global/:id (global) · /login · /auth/callback
```

List and editor are shared by both scopes. The route's `data.scope` picks the API.
