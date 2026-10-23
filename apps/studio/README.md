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
- **Keycloak** (`npm run idp:up`): sign in as `olivia`, `eddie` or `root` (password = username).
  The same provider is used in staging and production. See "Studio login details" in the root
  README.

Either way, the Studio asks the backend who you are (`GET /api/v1/me`). It shows only what your
memberships allow, and the backend enforces the same rules on every request. If your session
expires, a 401 sends you back to the login page.

**First sign-in:** you land on **Welcome**. Create your organization and its first app
(name + website), and you go straight to that app's **Install & settings** page to copy the
snippet.

## Organizations, apps and roles

The top bar has the **organization switcher**, the **app switcher**, and links for the current
app: Guides, Pages, Install & settings, Apps and Members. Platform admins (Guide Engine's own
staff) also see **Administration**; see below.

| Role | What you can do |
|---|---|
| **viewer** | read guides, pages, versions and analytics in every app; the **Install** page (snippet and anchor instructions, read-only) |
| **editor** | + create guides, save drafts, make preview links, publish, enable / disable, roll back, delete guides; create, edit and move pages; **Install & settings** (websites, routing, require signed identity, help center, app on / off) |
| **manager** | + create apps; rotate the public key, generate or rotate the signing secret, delete apps, export or forget visitors; manage members and invitations |
| **owner** | + grant or remove ownership (an org always keeps one owner); support access; export or delete the organization; create new organizations |
| **platform admin** (Guide Engine staff, not a customer role) | the Administration page: every organization's usage, suspension, the kill switch, other admins; a customer's content only under support access, read-only |

One role per person, for every app of the organization. The UI adapts to it: viewers get
read-only screens and the Install page only. The backend enforces every rule regardless. One gap:
editors still see the manager-only buttons (generate signing secret, rotate public key, forget
visitor, delete app), and the backend answers them with "Your role doesn't allow this."

**Members → Invite someone** creates a link. It's valid for 7 days and works once. If you enter
an email, only that verified email can accept it. Choose the role (manager, editor or viewer;
owners are promoted from the member list). Send the link however you like; when the backend has
mail configured the invitation is also emailed. Pending invitations can be revoked.

## Guide Engine support access (org owners)

**Members** ends with a **Guide Engine support access** card. Guide Engine's own staff can't see
an organization unless an **owner** opens a window here (1, 7, 30 or 90 days). While it's open,
platform admins can view the organization's guides, pages, analytics and members **read-only**,
and every page they open is listed in the card's access log, which managers can also see. **Close
now** ends it early; otherwise it closes by itself.

## Your data (org owners)

Below it, **Members** ends with a **Danger zone** card for owners:

- **Export organization data** downloads one JSON file with everything the organization
  authored: apps (settings and public keys, never signing secrets), saved pages, guides with every
  version, members and roles, pending invitations, and lifetime totals per guide. Raw visitor
  events are not included.
- **Delete organization** removes the organization with all its apps, guides, pages, analytics,
  members and invitations. Type the organization's name to enable the button; the backend checks
  it again. Afterwards the Studio re-reads your organizations and takes you to your next one (or
  onboarding). Studio accounts stay.

## Administration (platform admins)

People with the platform-admin flag get an **Administration** link in the top bar (`/operator`):

- every organization with its owners, member/app/guide counts, events in the last 30 days,
  status, and whether support access is granted;
- **Suspend** / **Lift suspension** (a suspended organization's apps serve no guides, and its
  members see a banner);
- **Open (read-only)**, enabled only while the organization has granted support access: the
  Studio enters *support mode*, shows a banner naming the organization and the expiry, and the
  ordinary Guides / Pages / Analytics / Members pages work as a viewer. **Exit** in the banner
  leaves it. Support mode survives a reload in the same tab (sessionStorage).
- **Delete**: for a customer's deletion request when no owner can do it themselves. Opens a
  type-the-name confirmation; the deletion is the same as the owner's, and the backend logs it;
- the global kill switch (every guide for every customer);
- the list of platform admins, with grant-by-email and remove (never yourself).

The first platform admin is created with SQL by the database owner (see the root README);
after that, grants happen here.

## Install & settings (editors; the danger zone needs a manager)

- **Install:** the exact `<head>` snippet for this app, with a copy button. Replace `USER_ID` /
  `ACCOUNT_ID` with your signed-in user's ids. SPAs need nothing else. After a later login, call
  `guideEngine.identify(...)`.
- **Websites:** the only origins where guides load. Include your development URL if you test
  locally.
- **Routing:** how your app addresses pages: **Path** (`/settings/team`, the default) or
  **Hash** (`/#/settings/team`). It decides which part of the URL guides are matched on; page
  URLs are written the same way in both cases. Saved on change.
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
  - **Help center analytics** (same card, last 30 days): how often the panel was opened, how
    many searches were made, how many guides were started from it, and the top 20 search
    queries with the average number of topics each found. A query that finds nothing is marked
    in red: a topic worth adding.
- **Guides on/off** for the whole app, and the **Danger zone**: **Rotate public key**, which
  breaks old snippets until they're updated, and **Delete app** (type the app's name), which
  removes the app with its guides, pages and analytics and returns you to the apps list. Both are
  for managers and owners.

**Danger zone → Forget a visitor** (managers and owners): for an end user's data request, enter the
visitor id your site passed to `guideEngine.initialize`; **Export visitor** downloads their
events and guide state as JSON, **Forget visitor** deletes them (guides they finished show again
for that id).

## Working with a guide

1. **Create** a guide on the app's Guides page. It starts disabled, with nothing published.
2. **Where and when:**
   - **Show on:** *A saved page* (pick one from the app's **Pages**), or *A custom route*: an
     exact path (`/dashboard`) or a pattern where `*` matches anything (`/projects/*`). A custom
     route can be saved as a page in place (**Save as page**), so other guides can reuse it.
     Guides on a saved page follow it when its URL changes, even live ones.
   - **Dates:** optional start and end.
   - **How it starts:** *Automatically, when a visitor opens the page* (once per published
     version — being shown counts, so a reload never restarts it; publish again to show it to
     everyone once more — welcome tours, "what's new"), or
     *Only from the help center* (never pops up; visitors pick it from the help list or open a
     help link, so it's always listed there). When several automatic guides match a page, the
     agent shows them one at a time, walkthroughs first.
   - **Audience:** *All accounts*, or *Only these accounts*, one id per line. Use the account ids
     your site passes to `guideEngine.initialize({ account: { id } })`. Separately, *All
     visitors*, or *Only visitors with any of these tags*: the tags your site passes as
     `visitor.tags` (or in the signed identity), usually what the person may do, such as
     `POINT_OF_SALE`. Both rules apply, so a visitor needs a listed account and one of the tags.
3. **Steps:** add, reorder (↑ / ↓) and remove them. Each has:
   - **Anchor:** the element's `data-guide-id`. Leave it blank for a centered card.
   - **Position.**
   - **Content:** HTML. Scripts, styles, event handlers and unsafe URLs are removed on save.
   - **Buttons:** `next`, `back`, `complete`, `dismiss`. Whatever you choose, every card also
     gets a **×** and closes on Escape, so nobody is ever stuck. A step whose anchor only
     appears after the visitor does something (a field shown once a record is selected) still
     works: the card shows centered and moves onto the element when it appears.
4. **Help center** (optional): tick **List in the help center**, then give a title (it defaults
   to the guide name), a short description, search keywords and a **start page**: where people
   are sent if they pick it on another page. The start page defaults to the saved page's start
   page, or to an exact route. It's required for custom pattern routes. Visitors can then search for it in the help list and start it
   any time, even if they've done it before.
5. **Save draft** stores one working draft per guide. **Preview** saves it and gives a 15-minute
   link to the app's first website. That version renders with a "Preview" badge and no
   analytics.
6. **Publish new version** makes it live as the next version. Published versions never change.
7. **Delete guide** (editors; the red button at the bottom of the editor, and on the guide list) removes the guide with
   all its versions, analytics and visitor state after a confirmation. There is no undo; to pause
   a guide instead, switch it off.
8. **Enabled** is the guide's on/off switch. Nothing shows until a version is published **and**
   the guide is enabled.
9. **Versions:** **Roll back to this** makes an older version live; **Load into editor** starts
   from any version.

When a visitor dismisses or completes a guide, they don't see it again until you publish a
**newer** version. Rolling back doesn't re-show it.

### Pages

**Pages** (top bar, per app) is the app's library of named URL rules: a name, an exact path or
pattern, and a start page (required for patterns: the concrete URL the help center opens). The
table shows how many guides use each page and how many of those are live. Click the count to list
them.

- **Edit** renames a page or changes its URL. Every guide on the page follows immediately, and
  live guides are moved after a confirmation.
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
    auth.service.ts        sign-in (SSO + paste), session restore, /v1/me (orgs, apps, roles), support mode
    auth.interceptor.ts    adds the bearer token; 401 -> login
    auth.guard.ts          signedIn / orgMember / appRole(min) guards (UX only; the backend enforces)
    api.service.ts         typed client for /api/v1 (orgs, apps, members, invitations, pages, guides)
    download.ts            saves an API download (Blob) under the name the backend gives it
    models.ts              request/response types and the role ladder
  pages/
    login, auth-callback   sign-in
    onboarding             first org + first app
    apps                   an org's applications; create app
    app-settings           install snippet, websites, signed identity, key rotation, app switch, delete app
    members                members and roles, invite links, support access, export / delete org (owners)
    operator               Guide Engine administration: organizations, suspension, deletion, kill switch, admins
    invite                 accept an invitation
    guide-list             an app's guides, create, enable toggle (optimistic)
    guide-editor           form editor: saved page or custom route, audience, help, draft / preview / publish
    pages                  an app's saved pages: create, edit (guides follow), delete when unused
  components/
    version-history        versions, rollback, preview, load into editor
    analytics              totals + per-step funnel (CSS bars, no chart library)
  app.ts / app.html        top bar: org + app switchers, section links
  app.routes.ts            /welcome, /invite/:token, /o/:orgId/{apps,members}, /o/:orgId/apps/:appId/{guides,guides/:id,pages,settings}
                           (every page except login / auth callback is `loadComponent`, so each is its own lazy chunk)
```

Route params are bound to component inputs, so switching orgs, apps or guides reloads the data
in place. Data-loading `effect()`s call the API inside `untracked()`. The interceptor reads the
auth token signal, so without it every token renewal would trigger re-fetches.
