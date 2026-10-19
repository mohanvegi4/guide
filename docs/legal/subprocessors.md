---
title: Subprocessors
parent: Legal templates
nav_order: 4
---

# Subprocessors (template)

> **TEMPLATE. NOT LEGAL ADVICE.** This is the list the [Privacy Policy](privacy.md) and the
> [Data Processing Addendum](dpa.md) refer to. Fill in the providers you actually use. The rows
> reflect what a Guide Engine deployment needs and what it doesn't: the stack is designed to run
> on a single host with Postgres and a self-hosted identity provider, so several rows are
> "none by default". Replace `{{COMPANY}}` and `{{CONTACT_EMAIL}}` and date the list.

**Last updated:** `[date]`. Changes are announced to organization owners at least `[30]` days in
advance (DPA section 7). Questions: `{{CONTACT_EMAIL}}`.

`{{COMPANY}}` uses the following third parties to process personal data in the course of
providing Guide Engine. "Data" refers to the categories in section 3 of the Privacy Policy and
section 3 of the DPA unless a row says otherwise.

| Purpose | Provider | Location of processing | Data involved | Notes |
|---|---|---|---|---|
| **Hosting** (the backend API, the Studio's static files and reverse proxy, the agent script) | `[hosting provider, e.g. a cloud or VPS provider]` | `[region / country]` | All data in transit through the Service; server logs (request id, route, status, duration; no bodies, headers or tokens) | The reference deployment is a single host running the backend, Studio, Postgres, Keycloak and Caddy (automatic HTTPS) in Docker. |
| **Database** (Postgres) | `[same host as above, or a managed Postgres provider]` | `[region / country]` | Everything the Service stores: author records and memberships, guides and pages, events, per-visitor state, error reports, support-access log, transient rate-limit counters (key + IP) | Row-Level Security is enforced on every table. Signing secrets are encrypted at rest. A managed provider should offer point-in-time recovery. |
| **Backups** | `[where backups live, e.g. object storage; or "same host, ./backups volume"]` | `[region / country]` | Full database dumps | Kept `[retention]`; deleted data persists until backups rotate. `[Say whether backups are encrypted.]` |
| **Identity provider** for Studio sign-in (OpenID Connect) | **Keycloak, self-hosted** by `{{COMPANY}}` `[or: your organization's own IdP / a hosted provider]` | `[same host or region]` | Author identity: subject id, email, name, password (held by the provider, never by Guide Engine); the provider's own session cookies on its domain | Self-hosted means **no third party** receives author credentials. If you replace Keycloak with a hosted provider (for example Okta, Auth0, Entra ID), list it here. |
| **Email** for invitation messages (SMTP) | `[your SMTP provider, e.g. a transactional email service]`, or **none by default** | `[region / country]` | The invitee's email address, the organization name, the inviter's name, the invitation link | Only used when `SMTP_URL`, `MAIL_FROM` and `STUDIO_URL` are configured. Without them, invitations are links authors copy and send themselves, and no email provider is involved. |
| **Error tracking** for backend 5xx errors (Sentry) | `[Sentry (sentry.io) or self-hosted Sentry]`, or **none by default** | `[region / country]` | Exception message and stack trace, request id, route pattern, status code, environment and release. No request bodies, headers, tokens or visitor data. | Only when `SENTRY_DSN` is set; nothing is loaded or sent otherwise. |
| **Metrics and logs** (Prometheus scraping, log shipping) | `[your monitoring stack]`, or **none by default** | `[region / country]` | Prometheus metrics (bounded labels: route patterns, endpoint names, table names; never keys, apps, organizations or guide ids); JSON request logs as above | `GET /metrics` is only exposed when `METRICS_TOKEN` is set. |
| **CDN** in front of the agent script (`/agent/v1/*`) | `[CDN provider]`, or **none by default** | `[region / country]` | The requester's IP address and user agent in the CDN's own logs; the script itself contains no personal data | Optional; the script is cacheable as is. No other API path is cacheable or should go through a CDN. |
| **Content delivery of the Studio or API through a third-party proxy / WAF** | `[provider]`, or **none by default** | `[region / country]` | All traffic to the Service | Only if you put one in front of the reference deployment's Caddy. |
| **Analytics / product analytics vendors** | **None.** | — | — | Guide Engine has no external analytics integration; events are stored only in its own Postgres database. |
| **Payment processing** | `[provider]`, or **none** if the Service is free | `[region / country]` | Billing contact and payment details of the Customer (not end-user data) | Not part of the product; list it if you bill customers. |

**Not a subprocessor:** the agent script runs in end users' browsers on the **Customer's**
website and stores an anonymous visitor id in that site's `localStorage`. That is processing on
the Customer's own property, not a third party acting for `{{COMPANY}}`.

## Change log

| Date | Change |
|---|---|
| `[date]` | Initial list. |
