---
title: Installing Guide Engine
nav_order: 2.2
---

# Installing Guide Engine

Putting Guide Engine on a website: the snippet, tagging elements, signed identity, and how
the agent picks and shows a guide.

## Installing Guide Engine on a website

### 1. Add the snippet

Copy the snippet from **Studio → your app → Install & settings**. It contains the app's
**public key** and your Guide Engine host:

```html
<script>
(function(w,d,k){var g=w.guideEngine=w.guideEngine||{_q:[]};
['initialize','identify','openHelp','closeHelp','toggleHelp'].forEach(function(m){g[m]=g[m]||function(){g._q.push([m].concat([].slice.call(arguments)))}});
var s=d.createElement('script');s.async=1;s.src='https://guides.example.com/agent/v1/'+k+'/guides.js';d.head.appendChild(s);
})(window,document,'ge_pk_0123456789abcdef0123456789abcdef');
guideEngine.initialize({
  visitor: { id: 'USER_ID' },      // your signed-in user's id
  account: { id: 'ACCOUNT_ID' }    // optional: their company / customer id
  // helpButton: false             // hide the floating help button (use your own, see Help center)
});
</script>
```

- It loads asynchronously and queues calls until the agent arrives, so it never delays your page.
- **Single-page apps need nothing else.** The agent follows `history.pushState` /
  `replaceState`, back/forward and hash changes by itself.
- **Anonymous visitors:** omit `visitor`, and the agent keeps a random per-browser id. To give them
  tags, pass `visitor: { tags: ['anonymous'] }` without an id.
- **After login:** call `guideEngine.identify({ visitor: { id }, account: { id } })`. The agent
  clears what the previous user was shown and re-evaluates.
- **After logout** (when the page doesn't reload): call `guideEngine.identify(null)`. The previous
  user's guides and help list go away, and nothing is fetched or shown until the next `identify`.
- **Visitor tags (optional):** `visitor: { id, tags: ['POINT_OF_SALE', 'CUSTOMERS:edit'] }`. Tags
  are short strings you choose, usually what the person may do in your app. A guide limited to
  tags shows only to visitors carrying at least one of them. Letters, digits and `_ . : / -`, up
  to 100 characters each and 1000 per visitor; malformed ones are ignored. When the visitor's
  permissions change, call `identify` with the same `id` and account and the new tags: the guide
  on screen stays and the page's guides are refreshed. `identify({ visitor: { tags } })` without an
  `id` keeps the current one; pass `id: undefined` to make the visitor anonymous.
- The site's origin must be in the app's **Websites** list. Guides never load anywhere else.

### 2. Tag the elements guides point at

```html
<button data-guide-id="invite-button">Invite teammates</button>
```

Guides reference stable `data-guide-id` values, never CSS classes, so markup refactors don't
break them. Ids may use letters, digits, `-` and `_`. A step with no anchor shows as a
centered card.

### 3. (Recommended) Require signed identity

The key in the snippet is public, so by default anyone could claim to be any visitor. That's
fine for showing tips, but not if visitor identity matters to you.

1. In **Install & settings → Signed identity**, generate a **signing secret**. Keep it on your
   server only.
2. Have your server sign each user's identity:

   ```js
   import jwt from 'jsonwebtoken';
   const token = jwt.sign(
     { visitor: { id: user.id, tags: user.guideTags }, account: { id: user.companyId } },
     process.env.GUIDE_ENGINE_SECRET,
     { algorithm: 'HS256', expiresIn: '1h' },
   );
   ```

3. Pass it to the page: `guideEngine.initialize({ jwt: token })`. Ids and tags then come from
   the token only; anything sent beside it is ignored.
4. Switch on **Require signed identity**. From then on, unsigned or invalid identities get no
   guides.

The full contract for your backend team — claims, algorithm, the endpoint pattern, a Java
example, rotation and acceptance checks — is in
[docs/integration/signed-identity.md](integration/signed-identity.md).

---

## How a guide is chosen and shown

1. **Startup.** The agent finds its key and API host from its own `<script src>`, then replays
   any queued `initialize` / `identify` calls. The script is the same file for every key, served
   with a content-hash `ETag` so browsers and a CDN revalidate cheaply (see
   [Deploying](operations.md#the-agent-script-caching-and-rollbacks)); `guideEngine.version` says which build
   is on the page.
2. **Preview links.** If the URL has `?guidePreview=<token>`, the agent asks the backend to
   verify it. If valid, it renders **only** that version, with a "Preview" badge and no
   analytics. If invalid, it carries on normally.
3. **One request** returns everything needed: `POST /v1/agent/<key>/guides` with the visitor's
   identity returns `{ enabled, guides }`. The server checks:
   - the global kill switch and the app's own switch;
   - the [environment](using-the-studio.md#environments-and-releases) the page's `Origin` belongs to, and the
     version released there (a guide with no release in it isn't served);
   - published, enabled and in the date window;
   - the account allowlist and the visitor tags;
   - that this visitor hasn't already seen, dismissed or completed this version or a newer one
     in this environment (automatic guides show once; the help center lets them be replayed).

   `enabled: false` stops the agent for the rest of the page's life. Any other failure shows
   nothing for that navigation (fail closed).
4. **Route matching** uses the URL **path** only (query strings and fragments are ignored):
   `exact` compares the whole path, and in `pattern` each `*` matches anything. For an app whose
   **Routing** setting is *Hash* (`/#/settings/team`), the path inside the fragment is matched
   instead (`/settings/team`; a fragment-less page is `/`), the agent re-evaluates on every
   `hashchange`, and page URLs are written the same way as for path routing. The server says
   which mode applies in every `/guides` and `/help` response (`routeMode`).
5. **Finding the target.** A **first** step whose anchor isn't in the DOM yet waits quietly: the
   agent retries with backoff (10 attempts, about 16.5 s), then records `guide_error` with
   `target_not_found` and shows nothing — the page may still be rendering, or the feature may not
   be there for this visitor. A **later** step (the visitor clicked Next or Back) shows its card
   centered straight away, so the click visibly did something and the buttons keep working, and
   the card moves onto the element the moment it appears — for anchors that only exist after the
   visitor acts, such as a field that appears once a record is selected.
6. **Rendering** happens in a Shadow DOM card, so your styles don't leak in. A targeted step
   puts the focus on its element: it's scrolled into view if off-screen, and **spotlighted** with
   a ring in the theme's color (the element stays clickable; the page is never dimmed). Card and
   spotlight follow the element when the page scrolls, the window resizes or your framework
   re-creates the element; the card's DOM is built once per step (re-renders only move it, so
   a click never lands on a replaced button). Cards are kept inside the viewport, and if your
   page scrolls the anchor away within moments of the step appearing (restoring a scroll
   position, bringing a table into view) it's scrolled back once — later scrolling is the
   visitor's. Every card has a **×** and closes on **Escape**, whatever buttons the author chose.

   The guide **never hides what the element shows the visitor**, such as a dropdown's options. A
   card for a control that opens a list below itself (text fields, selects, comboboxes,
   `aria-haspopup` buttons) goes above it, or beside it when there's no room above, unless the
   author chose a side other than below, so it stays readable while the list is open. Only when
   it would still cover an open list (`aria-expanded="true"`, the list named by `aria-controls` /
   `aria-owns`, such as options rendered at the end of `<body>`) does the card fade and let clicks
   through, until the list closes.
7. **Events** are batched every 5 s or 20 events, sent as `text/plain` JSON (no CORS preflight),
   and flushed on `pagehide`. Dismiss and complete are sent immediately.
8. **Errors.** Fail silent also means the agent reports what it swallowed: an exception in
   startup, route evaluation, rendering or a click handler goes to
   `POST /v1/agent/<key>/errors` with its message, stack, the page URL and the agent version.
   Sampled client-side (10 %, at most 5 per page load, `keepalive`) and capped server-side
   (1000 per app per hour, beyond which reports are acknowledged and dropped), so a page that
   throws in a loop can't flood anything. The newest show up under **Recent agent errors** in the
   app's settings; the visitor never sees any of it.
