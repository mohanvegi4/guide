---
title: Using the Studio
nav_order: 2.4
---

# Using the Studio

How authors work in the Studio: guides, environments and releases, saved pages and the help
center. The [Studio reference](../apps/studio/README.md) covers every screen.

## Using the Studio

Full guide: [`apps/studio/README.md`](../apps/studio/README.md).

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
    [Guide Engine administration](security.md#guide-engine-administration).
- **Guides.**
  - **Help center:** optionally list the guide, with a title, description, search keywords and a
    start page (required for pattern routes).
  - **Where:** a [saved page](#saved-pages) of the app, or a custom route (an exact path, or a
    pattern where `*` matches anything).
  - **Dates:** optional start and end.
  - **Audience:** all accounts, or only listed account ids; and all visitors, or only visitors
    carrying any of the listed [visitor tags](install.md#1-add-the-snippet). Both rules apply.
  - **Steps:** each has an anchor, position, HTML content, and buttons (`next`, `dismiss`,
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
