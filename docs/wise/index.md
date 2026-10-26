---
title: WISE integration
nav_order: 7
has_children: true
---

# WISE integration

Guide Engine is installed in two WISE applications: the **staff console** (`application-ng-staff`)
and the patron **OPAC** (`application-ng-patron`). The proof of concept is done and approved for
production. These pages are the one place that says what was built, how the two apps are wired,
what the WISE API still has to build, and what remains before go-live.

| Page | For | What it covers |
|---|---|---|
| [Integration and production TODO](integration.md) | Everyone on the project | What exists, how the console and the OPAC are wired, the guide catalogue with the visitor tags each guide needs, running it locally, the production TODO and known limitations |
| [Signed identity for the WISE API](signed-identity.md) | The WISE API team | The two identity endpoints, what goes in `visitor.id`, `account.id` and `visitor.tags` for staff and patrons, the tag rules, rollout and acceptance |
| [Project handbook](handbook.md) | Developers joining the project | Every project and where it lives, the tools, the hosts, the Docker and configuration files, and DevOps in short |
| [DevOps handoff](../handoff-devops.md) | DevOps | The first deployment: what to deploy, servers, decisions, settings, go-live steps and checks |

The generic pages these build on:

- [Signed identity](../integration/signed-identity.md): the token contract any backend follows
  (algorithm, claims, limits, identity modes, rotation).
- [DevOps quick guide](../devops.md): everyday commands for the `deploy/` stack.
- [Guide Engine reference](../../README.md) and [Studio reference](../../apps/studio/README.md).

The guides were written from the public WISE help sites:
[Wise console](https://help.wise.oclc.org/Wise_console) and [OPAC](https://help.wise.oclc.org/OPAC).
