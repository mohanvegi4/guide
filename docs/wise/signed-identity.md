---
title: Signed identity for the WISE API
parent: WISE integration
nav_order: 2
---

# Signed identity for the WISE API

**Status:** proposal for implementation · **Owner:** Guide Engine integration (WISE) ·
**Date:** 2026-10-20

Guide Engine identifies end users by the ids the page passes to `guideEngine.initialize()`. The app
key in the page is public, so with plain ids anyone could claim to be any staff member or patron —
fine for showing tips, not for a production system whose analytics and per-account targeting we
want to trust. **Signed identity** closes that: the WISE backend signs each user's identity with a
per-application secret, the page passes the token, and Guide Engine refuses anything it can't
verify.

This page is what the WISE REST API has to build and how it's rolled out. The token rules
themselves (HS256, the signing secret, claim limits, identity modes, error codes, signing examples
in Node and Java, the endpoint's response shape, secret rotation) are the generic contract in
[Signed identity](../integration/signed-identity.md); read that first. The frontend side is already
prepared on the `poc/guide-engine` branches of `application-ng-staff` and `application-ng-patron`.

## What we need from the API

Two endpoints, one per application, each minting a token for the **current session**. Both answer
as described in [The endpoint your backend exposes to the page](../integration/signed-identity.md#the-endpoint-your-backend-exposes-to-the-page)
(`200 { "token", "expiresAt" }`, `204` when anonymous, `401` when not authenticated,
`Cache-Control: no-store`).

| | Staff console (WISE console) | OPAC (patron) |
|---|---|---|
| Endpoint (proposal) | `GET /restapi/guide-engine/identity` | `GET /restapi/opac/guide-engine/identity` |
| Authentication | the console's staff session (Keycloak bearer / legacy session), like other console endpoints | the patron session, like other OPAC endpoints |
| `visitor.id` | the staff **actor UUID** — what the console already holds as `patronSystemId` (Keycloak claim `wiseUuid` / `token.actorUuid`) | the patron's **system id** (`wiseUuid`), what the OPAC holds as `patronSystemId` |
| `account.id` | the **library id** (`libraryId` / *instantieId*) | the branch's **instance** (library id, `branch.instance`) |
| `visitor.tags` | the staff member's **permission tags** (rule below), so guides can be limited to people who may use a screen | `signed-in` plus the patron's **active authorities** (rule below); anonymous visitors get no token, and the OPAC sends `anonymous` itself |
| Anonymous | n/a — the console is always signed in | **204, no token**; the OPAC then calls `initialize({ account })` and the agent uses an anonymous per-browser id |
| Identity mode in the Studio | **required** (switched on once the endpoint is live) | **optional** (anonymous patrons must still get guides; a token that *is* sent is always verified) |
| Secret | the "WISE Staff console" application's signing secret, per environment | the "WISE OPAC (patron)" application's signing secret, per environment |
| Lifetime | 12 hours (`exp`) | 12 hours (`exp`) |

`expiresAt` is informational for the frontend; the token's `exp` is what Guide Engine checks.

Each environment (dev, staging, production) is its own Guide Engine application with its own key
and secret, so the WISE backend holds two secrets per environment, one per application. Keep them in the WISE backend configuration for that environment, never in the
frontend or its environment files ([The secret](../integration/signed-identity.md#the-secret)).

### Staff permission tags

The console already computes these from `GET /authorities` (see `guideEngineTags` in
`GuideEngineService`); the endpoint must produce exactly the same list from the same data, because
once the token is required the console stops sending its own tags:

- For every authority whose role function is known to `WISE_ROLE_FUNCTION`, take its
  **branch-level** permission.
- Use the enum **name**, not the Dutch value: `SERVICE_CASH_REGISTER`, not its stored value.
- Add one tag per level reached: READ (1) or more → `NAME`; EDIT (3) → `NAME:edit`;
  ADD (7) → `NAME:add`; DELETE (15) → `NAME:delete`. NOTHING (0) adds nothing.
- Library- and system-level permissions are not encoded.

Example: branch EDIT on the cash register and READ on customers gives
`["SERVICE_CASH_REGISTER", "SERVICE_CASH_REGISTER:edit", "SERVICE_CUSTOMERS"]`. A staff user has
at most 540 tags (135 role functions × 4 levels), about 24 KB once signed: within Guide Engine's
limits of 1000 tags per visitor and 65,536 characters per token. Tags are case-sensitive and may
contain letters, digits and `_ . : / -` only; a malformed tag is ignored, and the rest of the token
still counts.

### Patron tags

The OPAC computes these from the patron's granted authorities (`guideEngineTags` in the OPAC's
`GuideEngineService`); the patron endpoint must produce the same list:

- `signed-in`, then the name of every authority whose status is `ACTIVE` (`MA_RENEW`,
  `MA_VIEW_WISHLIST`, …), sorted. These are the same names the OPAC's `Authority` enum uses.
- Anonymous visitors: 204 and no token; the OPAC then tags them `anonymous` without a token.

Example: a patron who may renew and view loans gives `["signed-in", "MA_RENEW", "MA_VIEW_LOANS"]`.
At most about 50 tags.

Which guide needs which tag is in the [guide catalogue](integration.md#13-studio-content-and-the-guide-catalogue).

## Frontend wiring (ready on the POC branches)

`GuideEngineService` in both apps already installs the agent from environment configuration and
calls `initialize` / `identify`. The change for signed identity is small and waits only on the
endpoints:

- **Staff console:** after the user and their authorities are known (the service already waits
  for both), `GET /restapi/guide-engine/identity`, then `initialize({ jwt })` (no plain ids or
  tags). Re-fetch and `identify({ jwt })` when the user or their permissions change.
- **OPAC:** when the branch is known: signed-in patron → fetch the token, `initialize({ jwt })`;
  anonymous → `initialize({ account: { id: branch.instance } })`; on login, fetch and
  `identify({ jwt })`.
- Tokens are never stored by the page (fetched per page load; `Cache-Control: no-store` on the
  endpoint).

## Rollout

1. API team: implement the two endpoints against the dev Guide Engine (secrets from the Studio's
   dev applications), verify with the acceptance checks below.
2. Frontend: switch the two services to the endpoints (both branches), verify guides still show.
3. Per environment, in the Studio: generate the signing secret for each application, put it in the
   WISE backend's configuration for that environment, deploy, confirm the acceptance checks.
4. Studio → staff console application → **Require signed identity: on**. The OPAC stays optional.
5. Production: the two production applications get their own keys and secrets; the apps'
   `environment.prod.ts` get the production host and keys (currently `null` = guides off).

## Acceptance

Run the generic [acceptance checks](../integration/signed-identity.md#acceptance) (valid, tampered
and expired tokens, a missing token in `required` mode, a foreign `Origin`) against each endpoint's
tokens, then these WISE-specific ones:

| Case | Expected |
|---|---|
| valid staff token for someone with the cash register at branch edit level | the response includes "Sell at Point of sale" (tagged `SERVICE_CASH_REGISTER:edit` in the dev Studio) |
| valid staff token for someone without it | that guide is absent |
| valid patron token with `MA_RENEW` | `/v1/agent/<OPAC key>/help` lists "Renew a loan"; without it, it is absent |
| OPAC endpoint without a patron session | `204`, no body |

To compare claims with a known-good token, mint one from the Guide Engine repository with the same
secret and the tags the endpoint should produce:
`npm run sign-identity --workspace=packages/backend -- --secret ge_sk_… --visitor <id> --account <id> --tags A,B`
and decode both at the terminal (`echo <token> | cut -d. -f2 | base64 -d`).
