---
title: Home
nav_order: 1
---

# Guide Engine

In-app guides for any web application: a lightweight alternative to Pendo or WalkMe.

Add one snippet to your site, author tooltips, modals, banners and tours in the **Studio**, point
them at elements tagged `data-guide-id`, publish, and measure what visitors did. A floating
**Help** button gives visitors a searchable list of guides. One Studio serves many applications:
an **organization** owns any number of **applications**, and everyone in it has one role
(viewer, editor, manager or owner) for all of them.

## Who this site is for

**Product and engineering teams installing Guide Engine on a site**

- [Installing Guide Engine on a website](reference/README.md#installing-guide-engine-on-a-website):
  the snippet, tagging elements, signed identity, and the npm packages for Angular, Vue or
  plain TypeScript.
- [How a guide is chosen and shown](reference/README.md#how-a-guide-is-chosen-and-shown): what the
  agent sends and when, route matching, fail-closed behaviour and error reporting.
- [Agent API](reference/README.md#agent-api-public-app-key-cors-for-the-apps-websites) and
  [Troubleshooting](reference/README.md#troubleshooting).

**Authors using the Studio**

- [Studio reference](reference/studio.md): signing in, organizations, apps and roles, working
  with a guide, saved pages, the help center and analytics.
- [Using the Studio](reference/README.md#using-the-studio) in the main reference, including
  [Saved pages](reference/README.md#saved-pages) and the [Help center](reference/README.md#help-center).

**Engineers running, extending or reviewing Guide Engine**

- [How Guide Engine is built](architecture.md): the whole system part by part, from the boot
  sequence and row-level security to the browser engine, with a who-can-do-what matrix, the
  audience-targeting model and a list of known gaps.

**Operators running Guide Engine**

- [Deploying](reference/README.md#deploying): CI, images, the single-host stack, any other
  platform, and the agent script's caching and rollback contract.
- [Signed identity](integration/signed-identity.md): the contract for the backend that signs
  visitor identities — claims, algorithm, the endpoint the page calls, rotation and acceptance.
- [Identity, roles and security](reference/README.md#identity-roles-and-security), including
  [Guide Engine administration](reference/README.md#guide-engine-administration) (platform
  admins, suspension, support access).
- [Configuration reference](reference/README.md#configuration-reference),
  [Operations](reference/README.md#operations) and [Observability](reference/README.md#observability).
- [Legal templates](legal/index.md): terms of service, privacy policy, data processing addendum
  and a subprocessor list to adapt before offering Guide Engine as a hosted service.

## Where the content comes from

The reference pages are the repository's `README.md` and `apps/studio/README.md`, assembled at
build time so there is one source of truth. To change them, edit the READMEs in the
[repository](https://github.com/mohanvegi4/guide). Everything else on this site lives in
[`docs/`](https://github.com/mohanvegi4/guide/tree/main/docs).
