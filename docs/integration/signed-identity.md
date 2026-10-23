---
title: Signed identity
nav_order: 5
---

# Signed identity

The app key in the install snippet is public, so by default the visitor and account ids are
whatever the page passes to `guideEngine.initialize()` — convenient, but spoofable. When identity
matters (per-account targeting, analytics you want to trust), have **your backend sign each user's
identity** with the application's signing secret and pass the token to the page. Guide Engine then
refuses anything it can't verify. This page is the contract for the team implementing the
backend side.

## What Guide Engine verifies

Every agent request (`POST /v1/agent/<app key>/guides`, `/help`, `/events`) carries the visitor's
identity in its JSON body. With signed identity, the body carries a `jwt` instead of plain ids:

```json
{ "jwt": "<token>" }
```

The backend accepts the token only if **all** of the following hold:

| Rule | Detail |
|---|---|
| Algorithm | **HS256 only.** `alg: none`, RS*/ES*, and any other algorithm are rejected. |
| Key | The HMAC key is the UTF-8 bytes of the application's **signing secret** exactly as the Studio shows it: `ge_sk_` followed by 43 base64url characters (49 characters, 392 bits). Do not decode or hash it. |
| `visitor.id` | Required. String, 1–256 characters after trimming. The stable id of the end user. |
| `account.id` | Optional (or `null`). String, 1–256 characters. The customer/tenant the user belongs to; used for the per-version account allowlist and analytics. |
| `exp` | **Required**, seconds since the epoch. Tokens without an expiry are rejected ("no eternal identities"). 5 seconds of clock tolerance. |
| `iat`, `nbf` | Optional. `nbf` is honoured (with the same tolerance). |
| Other claims | Ignored and never stored. Don't put names or emails in the token: the agent stores ids only. |
| Size | At most 8192 characters. |

How the two identity modes of an application behave (**Install & settings → Signed identity**):

| Request | `optional` (default) | `required` |
|---|---|---|
| `visitor.id` only, no `jwt` | accepted as-is (spoofable) | **401** `signed_identity_required` |
| no ids, no `jwt` | **401** `visitor_required` | **401** `signed_identity_required` |
| valid `jwt` | accepted; the claims win over any plain ids sent alongside | accepted |
| invalid / expired / wrong-secret `jwt` | **401** `identity_invalid` — a token that is sent must verify, even when it isn't required | **401** `identity_invalid` |

A 401 makes the agent show nothing and record nothing (fail closed, fail silent); the page itself
is never affected. Other agent-API errors: **400** `invalid_body`, **403** `origin_not_allowed`
(the page's origin isn't in the app's websites list), **404** for an unknown or disabled key,
**429** `rate_limited`.

## Signing a token

Node (`jsonwebtoken`, the reference implementation; this is exactly what `npm run sign-identity`
in the Guide Engine repo does):

```js
import jwt from 'jsonwebtoken';
const token = jwt.sign(
  { visitor: { id: userId }, account: { id: tenantId } },
  process.env.GUIDE_ENGINE_SIGNING_SECRET,          // "ge_sk_…"
  { algorithm: 'HS256', expiresIn: '12h' },
);
```

Java (jjwt 0.12):

```java
import io.jsonwebtoken.Jwts;
import io.jsonwebtoken.security.Keys;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.Date;
import java.util.Map;

String token = Jwts.builder()
    .claim("visitor", Map.of("id", userId))
    .claim("account", Map.of("id", tenantId))          // omit for users without one
    .issuedAt(new Date())
    .expiration(Date.from(Instant.now().plus(12, ChronoUnit.HOURS)))
    .signWith(Keys.hmacShaKeyFor(secret.getBytes(StandardCharsets.UTF_8)), Jwts.SIG.HS256)
    .compact();
```

(jjwt 0.11: `.setIssuedAt(...)`, `.setExpiration(...)`, `.signWith(key, SignatureAlgorithm.HS256)`.)
The secret is long enough for jjwt's HS256 key-length check (≥ 256 bits).

**Lifetime.** 12 hours is a good default: the token only lets its bearer *be that visitor inside
Guide Engine* (see their guides, write their analytics events) — it grants nothing in your own
product — so it can comfortably outlive a working session. Mint a fresh one on every page load
and after a login or user switch (the page calls `guideEngine.identify({ jwt })`). If a token
expires mid-session the agent simply gets a 401 on its next call and shows nothing until the next
page load; nothing else happens.

## The endpoint your backend exposes to the page

The page can't sign (it would need the secret), so it asks your backend for a token with the
session it already has. One endpoint, authenticated the same way as the rest of your API:

```
GET /…/guide-engine/identity
200  { "token": "<jwt>", "expiresAt": "2026-10-21T08:00:00Z" }   signed-in user
204  (no body)                                                   anonymous user, when your app allows them
401                                                              not authenticated (same as your other endpoints)
Cache-Control: no-store
```

The page then calls `guideEngine.initialize({ jwt: token })` — with a token, pass **no** plain
`visitor`/`account`: the claims carry both. An anonymous user (an application in `optional` mode)
calls `initialize({ account: { id } })` without a token; the agent gives them a stable anonymous
id per browser.

## The secret

- One signing secret **per Guide Engine application**, and each environment (dev, staging,
  production) is its own application with its own key and secret. The Studio shows a secret
  **once**, when it's generated or rotated.
- Keep it where your other third-party secrets live (your secret store / backend configuration
  for that environment). Never in the frontend, environment files, repositories or logs. The
  frontend only ever sees tokens.
- **Rotation** (Install & settings → Signed identity → rotate): the old secret stops verifying
  the moment the new one is generated, so update your backend's configuration right away.
  Between the two steps, visitors get a 401 and see no guides — nothing else breaks — so rotate
  in a quiet window. Tokens minted before the rotation are invalid afterwards; the next page
  load fetches a new one.
- **Enable "Require signed identity" last**, after the endpoint is live in that environment and
  the page sends tokens; until then the application stays in `optional` mode (tokens that are
  sent are already verified).

## Acceptance

With a token from your endpoint, against the environment's Guide Engine API:

```bash
curl -s -X POST "https://<api host>/v1/agent/<app key>/guides" \
  -H "Origin: https://<your site origin>" -H "Content-Type: text/plain" \
  -d '{"jwt":"<token>"}'
```

| Case | Expected |
|---|---|
| valid token | `200` `{ "enabled": true, "guides": [...] }` |
| token with one character changed | `401` `{ "error": "identity_invalid" }` |
| expired token | `401` `identity_invalid` |
| no `jwt` (app in `required` mode) | `401` `signed_identity_required` |
| `Origin` not in the app's websites | `403` `origin_not_allowed` |

To compare claims with a known-good token, mint one from the Guide Engine repo with the same
secret: `npm run sign-identity --workspace=packages/backend -- --secret ge_sk_… --visitor <id> --account <id>`
and decode both at the terminal (`echo <token> | cut -d. -f2 | base64 -d`).

## Where this fits

- Switching the mode and generating or rotating the secret: **Install & settings → Signed
  identity** in the Studio ([Studio reference](../reference/studio.md#install--settings-editors-the-danger-zone-needs-a-manager)).
- The agent API and its error codes: [Agent API](../reference/README.md#agent-api-public-app-key-cors-for-the-apps-websites).
- The security model as a whole: [Identity, roles and security](../reference/README.md#identity-roles-and-security).
