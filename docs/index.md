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

- [Installing Guide Engine](install.md): the snippet, tagging elements, signed identity,
  [how a guide is chosen and shown](install.md#how-a-guide-is-chosen-and-shown) and the
  [help center](install.md#help-center) visitors see.
- [Agent API](reference.md#agent-api-public-app-key-cors-for-the-apps-websites) and
  [Troubleshooting](operations.md#troubleshooting).

**Authors using the Studio**

- [Studio reference](../apps/studio/README.md): signing in, organizations, apps and roles, working
  with a guide, [environments and releases](../apps/studio/README.md#environments-and-releases),
  saved pages, the help center settings and analytics.

**Engineers running, extending or reviewing Guide Engine**

- [Architecture overview](architecture-overview.md): the whole system on one page with
  diagrams: the pieces, the folder layout, the data model, isolation, release stages, the install
  snippet and deployment.
- [How Guide Engine is built](architecture.md): the whole system part by part, from the boot
  sequence and row-level security to the browser engine, with a who-can-do-what matrix, the
  audience-targeting model and a list of known gaps.

**Operators running Guide Engine**

- [Deploying and operating](operations.md): what runs, first install, the go-live checklist,
  everyday tasks, secrets, backups, observability, other platforms, the agent script's caching
  and rollback contract, and [troubleshooting](operations.md#troubleshooting).
- [DevOps handoff](handoff-devops.md): for the first deployment, the servers to provision for the
  whole stack, the decisions we need from DevOps, settings, go-live steps and checks.
- [Signed identity](integration/signed-identity.md): the contract for the backend that signs
  visitor identities — claims, algorithm, the endpoint the page calls, rotation and acceptance.
- [Identity, roles and security](security.md), including
  [Guide Engine administration](security.md#guide-engine-administration) (platform
  admins, suspension, support access).
- [Configuration and API reference](reference.md): every setting, every endpoint, migrations.
- [Legal templates](legal/index.md): terms of service, privacy policy, data processing addendum
  and a subprocessor list to adapt before offering Guide Engine as a hosted service.

**Teams integrating Guide Engine into WISE**

- [WISE integration](wise/index.md): Guide Engine in the WISE staff console and the OPAC.
- [Integration and production TODO](wise/integration.md): what was built, how the two apps are
  wired, the guide catalogue with the visitor tags each guide needs, running it locally, and what
  remains before production.
- [Signed identity for the WISE API](wise/signed-identity.md): the two identity endpoints the WISE
  API team builds, the staff and patron tag rules, rollout and acceptance.
- [Project handbook](wise/handbook.md): every project, tool, host, Docker and configuration file,
  and DevOps in short.

## Where the content comes from

Every page is Markdown in the [repository](https://github.com/mohanvegi4/guide): the pages in
[`docs/`](https://github.com/mohanvegi4/guide/tree/main/docs), plus the root `README.md` (Getting
started) and `apps/studio/README.md` (Studio reference), assembled at build time.
