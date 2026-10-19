# Guide Studio

The authoring UI for Guide Engine. Product people use it to manage their organization's
applications, create, preview, publish and measure in-app guides, and invite teammates, all
without touching code. It's built with Angular 21 standalone components, signals
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

- **Sign in with SSO** appears when the backend has `OIDC_STUDIO_CLIENT_ID` set.
  - It uses OpenID Connect Authorization Code + PKCE, via `oidc-client-ts`.
  - The provider supplies **identity only**: who you are. Which organizations and apps you can
    manage is stored in Guide Engine's database.
  - Register `/auth/callback` as the redirect URI, and `/login` for logout.
  - The session lives in `sessionStorage`. It renews silently if the provider issues refresh
    tokens.
- **Paste a token** is for local development only. Get one from `npm run seed` (Dev Admin, the
  owner of the seeded Demo Org) or:
  ```bash
  npm run mint-token --workspace=packages/backend -- --sub you --email you@example.com
  ```
- **Mock SSO** (`npm run idp:up`): any username, no password; optional claims JSON for email
  and name. The same username is the same user every time. See "Studio login details" in the
  root README.

Either way, the Studio asks the backend who you are (`GET /api/v1/me`). It shows only what your
memberships allow, and the backend enforces the same rules on every request. If your session
expires, a 401 sends you back to the login page.

**First sign-in:** you land on **Welcome**. Create your organization and its first app
(name + website), and you go straight to that app's **Install & settings** page to copy the
snippet.

## Organizations, apps and roles

The top bar has the **organization switcher**, the **app switcher**, and links for the current
app: Guides, Install & settings, Apps and Members.

| Role | What you can do |
|---|---|
| org **owner** / **admin** | everything in every app of the org; create apps; manage members and invitations. Only owners can grant or remove ownership, and an org always keeps one owner. |
| app **viewer** | read guides, versions and analytics |
| app **editor** | + create guides, save drafts, make preview links |
| app **publisher** | + publish, enable / disable, roll back |
| app **app_admin** | + Install & settings: snippet, websites, signed identity, key rotation, app on / off |

The UI adapts to your role: viewers get read-only screens, editors see no Publish button, and so
on. The backend enforces the same rules regardless.

**Members → Invite someone** creates a link. It's valid for 7 days and works once. If you enter
an email, only that verified email can accept it. Choose the org role, plus a role per app for
members. Send the link however you like; Guide Engine doesn't send email. Pending invitations can
be revoked.

## Install & settings (app admins)

- **Install:** the exact `<head>` snippet for this app, with a copy button. Replace `USER_ID` /
  `ACCOUNT_ID` with your signed-in user's ids. SPAs need nothing else. After a later login, call
  `guideEngine.identify(...)`.
- **Websites:** the only origins where guides load. Include your development URL if you test
  locally.
- **Signed identity:**
  - Generate a secret (shown once; keep it on your server). Your server signs
    `{ visitor: { id }, account: { id } }` with it (HS256, with an expiry) and the page passes
    `jwt`.
  - Then switch on **Require signed identity**. That toggle is locked until a secret exists.
- **Help center:** on or off, plus the floating button's label and color (with a preview) and
  where the topic list opens (a corner, or the center of the screen; the "Go to another page?"
  dialog follows it). It
  also shows the code for using your own button: `initialize({ helpButton: false })` +
  `guideEngine.openHelp()`.
- **Guides on/off** for the whole app, and **Rotate public key**, which breaks old snippets
  until they're updated.

## Working with a guide

1. **Create** a guide on the app's Guides page. It starts disabled, with nothing published.
2. **Where and when:**
   - **Show on:** *A saved page* (pick one from the app's **Pages**), or *A custom route*: an
     exact path (`/dashboard`) or a pattern where `*` matches anything (`/projects/*`). A custom
     route can be saved as a page in place (**Save as page**), so other guides can reuse it.
     Guides on a saved page follow it when its URL changes, even live ones.
   - **Dates:** optional start and end.
   - **Audience:** *All accounts*, or *Only these accounts*, one id per line. Use the account ids
     your site passes to `guideEngine.initialize({ account: { id } })`.
3. **Steps:** add, reorder (↑ / ↓) and remove them. Each has:
   - **Anchor:** the element's `data-guide-id`. Leave it blank for a centered card.
   - **Position.**
   - **Content:** HTML. Scripts, styles, event handlers and unsafe URLs are removed on save.
   - **Buttons:** `next`, `complete`, `dismiss`. `back` is accepted but not handled by the
     renderer yet.
4. **Help center** (optional): tick **List in the help center**, then give a title (it defaults
   to the guide name), a short description, search keywords and a **start page**: where people
   are sent if they pick it on another page. The start page defaults to the saved page's start
   page, or to an exact route. It's required for custom pattern routes. Visitors can then search for it in the help list and start it
   any time, even if they've done it before.
5. **Save draft** stores one working draft per guide. **Preview** saves it and gives a 15-minute
   link to the app's first website. That version renders with a "Preview" badge and no
   analytics.
6. **Publish new version** makes it live as the next version. Published versions never change.
7. **Enabled** is the guide's on/off switch. Nothing shows until a version is published **and**
   the guide is enabled.
8. **Versions:** **Roll back to this** makes an older version live; **Load into editor** starts
   from any version.

When a visitor dismisses or completes a guide, they don't see it again until you publish a
**newer** version. Rolling back doesn't re-show it.

### Pages

**Pages** (top bar, per app) is the app's library of named URL rules: a name, an exact path or
pattern, and a start page (required for patterns: the concrete URL the help center opens). The
table shows how many guides use each page and how many of those are live. Click the count to list
them.

- **Edit** renames a page or changes its URL. Every guide on the page follows immediately, and
  live guides are moved after a confirmation. Only publishers can change the URL of a page live
  guides use; editors can still rename it.
- **Delete** is disabled while any guide's live version or draft uses the page. Move those guides
  to another page or a custom route first.

### Analytics

Event totals (shown, step viewed, step completed, completed, dismissed, errors), plus a
**per-step** table: views, done and dismissed. Step ids survive edits, so their numbers carry
over between versions, and deleted steps are grouped as **Removed steps**. If a guide is in the
help center, the panel also shows how many times it was started from there. `guide_error` usually
means the anchor element wasn't on the page.

## Code map

```
src/app/
  core/
    auth.service.ts        sign-in (SSO + paste), session restore, /v1/me (orgs, apps, roles)
    auth.interceptor.ts    adds the bearer token; 401 -> login
    auth.guard.ts          signedIn / orgMember / appRole(min) guards (UX only; the backend enforces)
    api.service.ts         typed client for /api/v1 (orgs, apps, members, invitations, pages, guides)
    models.ts              request/response types and the role ladder
  pages/
    login, auth-callback   sign-in
    onboarding             first org + first app
    apps                   an org's applications; create app
    app-settings           install snippet, websites, signed identity, key rotation, app switch
    members                members, org and app roles, invite links
    invite                 accept an invitation
    guide-list             an app's guides, create, enable toggle (optimistic)
    guide-editor           form editor: saved page or custom route, audience, help, draft / preview / publish
    pages                  an app's saved pages: create, edit (guides follow), delete when unused
  components/
    version-history        versions, rollback, preview, load into editor
    analytics              totals + per-step funnel (CSS bars, no chart library)
  app.ts / app.html        top bar: org + app switchers, section links
  app.routes.ts            /welcome, /invite/:token, /o/:orgId/{apps,members}, /o/:orgId/apps/:appId/{guides,guides/:id,pages,settings}
```

Route params are bound to component inputs, so switching orgs, apps or guides reloads the data
in place. Data-loading `effect()`s call the API inside `untracked()`. The interceptor reads the
auth token signal, so without it every token renewal would trigger re-fetches.
