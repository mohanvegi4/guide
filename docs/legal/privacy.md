---
title: Privacy Policy
parent: Legal templates
nav_order: 2
---

# Privacy Policy (template)

> **TEMPLATE. NOT LEGAL ADVICE.** This document describes what a Guide Engine deployment stores
> and why, as a starting point for the operator's own privacy policy. It has not been reviewed by
> a lawyer. Have counsel review it for the laws that apply to you (GDPR, UK GDPR, CCPA/CPRA and
> others), replace `{{COMPANY}}`, `{{CONTACT_EMAIL}}` and `{{JURISDICTION}}`, complete every item
> in `[square brackets]`, and keep it in step with your configuration (section 6 depends on
> environment variables you set).

**Effective date:** `[date]`
**Controller / processor:** `{{COMPANY}}`, `[registered address]` ("we", "us")
**Contact for privacy matters:** `{{CONTACT_EMAIL}}` `[and, if appointed, your Data Protection
Officer and EU/UK representative]`

Guide Engine shows in-app guides on our customers' websites and lets their teams author those
guides in the **Studio**. This policy covers two groups of people:

- **Authors**: people who sign in to the Studio. For their data we are the **controller**
  (section 2).
- **End users** (visitors): people who use a customer's website where the Guide Engine snippet
  is installed. For their data the **customer is the controller** and we are its **processor**
  (section 3). The customer's own privacy notice governs that use; this policy explains what
  we process on the customer's behalf.

## 1. Summary

| | Authors (Studio) | End users (customer websites) |
|---|---|---|
| Who decides | We do (controller) | The customer (controller); we process on its instructions |
| Identifiers | Identity-provider subject id, email, name | The visitor id and optional account id the customer's site passes in; or a random anonymous id |
| What we record | Memberships and roles, invitations, support-access log, request logs | Guide events, dismissal / completion state, sampled error reports with the page URL |
| Cookies | Our identity provider may set its own; the Studio keeps the session in the browser's `sessionStorage` | **None.** The agent sets no cookies |
| Retention | While you are a member, then on request | Events and error reports: `[EVENT_RETENTION_DAYS]` days (default 400); state: while the guide exists |

## 2. Authors: what the Studio stores about you

**Where it comes from.** You sign in through our identity provider using OpenID Connect
(`[name your provider, e.g. a self-hosted Keycloak at auth.example.com]`). The provider
supplies **identity only**: a subject identifier (`sub`), your **email address** and your
**name**. We do not receive your password. The Studio keeps your session in your browser's
`sessionStorage` and renews it silently if the provider issues refresh tokens; nothing about the
session is stored on our servers.

**What we store.**

- A Studio user record: the provider's issuer and subject id, your email (and whether the
  provider marked it verified) and name, created on first sign-in and updated from the provider
  on later sign-ins, with the time of your last sign-in; and, for our own staff, a platform-admin
  flag.
- Your **memberships**: which organizations you belong to and your role in each (owner, manager,
  editor or viewer), which applies to every application of that organization.
- **Invitations** you create or receive: the organization and role, the invitee's email address
  if one was entered, an expiry (7 days) and the invitation token stored **hashed**. If the
  operator has email configured, the invitation is emailed to that address through the email
  provider listed in our [subprocessors](subprocessors.md).
- **Support-access log**: if an organization owner grants our staff support access, every
  request a staff member makes under that access is logged (who, when, HTTP method and path)
  and shown to the organization's admins.
- **Content you author** (guides, versions, pages, names, help-center text) is business data of
  your organization, not personal data about you, but it is attributed to the organization,
  and versions carry their publish time.
- **Request logs**: one log line per API request with a request id, the route pattern, status
  and duration. Bodies, headers and tokens are never logged. `[State how long logs are kept.]`

**Why (legal bases where GDPR applies).** To provide the Studio to you and your organization
(contract); to secure the service, investigate abuse and keep the support-access audit trail
(legitimate interests); to send invitation emails you or your colleagues request (contract).

## 3. End users: what we process on behalf of customers

When a customer installs the Guide Engine snippet on its website, the agent script runs in
visitors' browsers and talks to our API. We process the following **on the customer's
instructions**, under the [Data Processing Addendum](dpa.md).

**Identifiers the customer's website passes in.**

- A **visitor id** and, optionally, an **account id** (for example the customer's user id and
  the customer's company or tenant id). The customer decides what these are; they may be
  pseudonymous or directly identifying.
- If the customer has not identified the visitor, the agent generates a **random anonymous
  id** and keeps it in the browser's `localStorage` **under the customer's website's domain**.
  It is not a cookie, we do not set it, and it never leaves that browser except as the visitor
  id in the requests below.
- Where the customer requires **signed identity**, the website also sends a token signed by the
  customer's server. We verify it with the application's secret and use the identity inside it;
  the token itself is not stored.

**What the agent sends and we store.**

- **Guide events**: which guide, version and step was shown, viewed, completed or dismissed,
  guide errors (for example an anchor element not found), when, under a per-page-load session
  id, and whether the guide was started from the help center. Help-center events record that
  the help panel was opened and what was **searched** (the query, cut to 200 characters, and how
  many topics it matched). Each event carries the visitor id and account id above.
- **Per-visitor guide state**: for each guide, whether this visitor dismissed or completed it
  and which version they last saw, so that they are not shown it again until a newer version is
  published.
- **Agent error reports**: when the agent itself throws, it reports the error message, stack
  trace, the **page URL** the visitor was on (up to 2000 characters, which may include path and
  query string), the agent version and the time. Reports are sampled (10 %, at most 5 per page
  load) and capped per application; customers see them in the Studio.
- **IP address, for rate limiting only.** The API limits requests per application key and
  client IP address. In production that counter is kept in our database for the duration of the
  limiting window and swept after about an hour. IP addresses are not written to request logs
  and not attached to events.

The agent sends these requests **without browser credentials** (`credentials: 'omit'`) and
only from the origins the customer listed for its application.

**What is not collected.** The agent sets **no cookies**, does not fingerprint devices, does not
read or send the page's content, form fields or keystrokes, and sends nothing to anyone other
than our API. There is no third-party analytics integration; events live only in our database.
Preview links used by authors render a guide **without recording any analytics**.

**Why.** We process end-user data to perform the service for the customer, who determines the
purpose (showing and measuring in-app guidance) and the legal basis under its own privacy
notice. We do not use end-user data for our own purposes other than operating, securing and
measuring the service in aggregate (section 2's request logs and the usage counts in section 4).

## 4. Our staff and your organization's content

Our platform administrators can see, for every organization: its name, its owners, the number
of members, applications and guides, event volumes (for example events in the last 30 days and
agent errors in the last 24 hours), and whether it is suspended or has granted support access.
This is for service administration (capacity, abuse, billing) and does not include the content
of guides, pages or per-visitor state.

An organization **owner** can grant our staff **support access** for 1, 7, 30 or at most 90
days. While it is open, staff can view the organization's guides, pages, analytics and members
**read-only** (the database rejects writes in that mode), every request is written to the
organization's support-access log before it is served, and the organization can close the
window at any time. It is off by default.

## 5. Sharing and subprocessors

We share data only with the service providers needed to run Guide Engine, listed with their
purpose and location in our [subprocessor list](subprocessors.md) (hosting, the Postgres
database, our identity provider, the email provider for invitations, and error tracking if
enabled). Our backend's optional error tracking receives the exception message and stack trace
of server errors tagged with a request id, route and status code, not request bodies, headers or
tokens. We may also disclose data where the law requires it, and to a successor in a merger or
acquisition under the same commitments. We do not sell personal data.

## 6. Retention

| Data | Kept for |
|---|---|
| Guide events and agent error reports | `[EVENT_RETENTION_DAYS]` days (the product default in production is **400 days**); a daily job deletes older rows. Set the number you actually configured. |
| Per-visitor guide state (dismissed / completed, last version seen) | While the guide and application exist; it is what prevents re-showing a guide. Deleted with the guide, the application or on request. |
| Rate-limit counters (application key + IP) | About one hour. |
| Guides, versions, pages, organization settings | While the organization exists; published versions are immutable. |
| Author records, memberships | While you are a member of an organization; then on request (section 8). |
| Invitations | Until accepted or revoked; unused links expire after 7 days. |
| Support-access log | `[Kept for the life of the organization unless you set a shorter period.]` |
| Request logs and metrics | `[Your log retention, e.g. 30 days.]` |
| Backups | `[Your backup schedule and retention, e.g. daily, kept 30 days; or point-in-time recovery window.]` Deleted data persists in backups until they rotate. |

## 7. Security

- **Isolation, enforced twice.** Every query is scoped to an organization or application in the
  application code, and the database enforces **Row-Level Security** on every table with policies
  that read only session variables set from verified credentials. The backend connects as a
  non-superuser role that cannot bypass those policies and refuses to start otherwise.
- **Transport.** Browsers and servers talk to the Service over HTTPS; the production
  configuration requires an `https://` API URL `[and the deploy stack obtains certificates
  automatically]`.
- **Sign-in.** Studio access in production is OpenID Connect only; access tokens are verified
  against the provider's published keys with pinned algorithms, and every token must expire.
- **Secrets at rest.** Application signing secrets are encrypted at rest (AES-256-GCM) with a
  key held in the server environment; invitation tokens are stored hashed. `[Note: the
  encryption key is a single environment secret, not a hardware or cloud KMS key.]`
- **Public API fencing.** The agent API accepts requests only from each application's listed
  websites, rate-limits per key and client IP, caps payload sizes, and never receives browser
  credentials.
- **Content sanitization.** Guide HTML is sanitized on save (no scripts, styles, event handlers,
  iframes or SVG; links restricted to `http`, `https` and `mailto`).
- **Staff access** to customer content requires the customer's consent and is read-only and
  logged (section 4).
- **Logs** never contain request bodies, headers or tokens.
- `[Add your organizational measures: access control for staff, backups and their encryption,
  incident response, vulnerability management.]`

## 8. Your rights and how to exercise them

Depending on where you live, you may have rights to access, correct, delete, restrict or
object to the processing of your personal data, to data portability, and to complain to a
supervisory authority. `[List the rights under the laws that apply to you.]`

**Authors**: write to `{{CONTACT_EMAIL}}` from the email address of your Studio account. You can
leave an organization yourself in the Studio; an organization admin can remove you. We delete
your Studio record on request once you are not a member of any organization.

**Organizations (customers)**: an organization owner can export the organization's data and
delete the organization, immediately and without our involvement, in the Studio under
**Members → Danger zone** (see the [Terms](terms.md), section 11). Deletion removes everything
the organization holds, including all end-user events and state for its applications.

**End users**: because the customer is the controller, please contact the website operator
whose site you were using; their privacy notice tells you how. When a customer asks us to
assist, it identifies the visitor by the visitor id its website used, and we delete or export
that visitor's events and guide state for the customer's applications. The customer's own
administrators do this themselves in the Studio (**Install & settings → Danger zone → Forget a
visitor**: export as JSON, then delete), immediately and without our involvement. Visitors can
also clear their anonymous id by clearing the customer website's site data in their browser.

## 9. International transfers

`[State where the Service is hosted (see the subprocessor list) and, if data leaves the country
or region where your customers or users are, the transfer mechanism you rely on (for example
EU Standard Contractual Clauses, the UK IDTA, or an adequacy decision).]`

## 10. Children

The Service is not directed at children. Customers must not configure it on websites where
that would be unlawful without the safeguards their law requires.

## 11. Changes to this policy

We will post changes here with a new effective date and, for material changes, notify
organization owners by email or a notice in the Studio at least `[30]` days in advance.

## 12. Contact

`{{COMPANY}}`, `[address]`. `{{CONTACT_EMAIL}}`. Governing law: `{{JURISDICTION}}`.
