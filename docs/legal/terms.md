---
title: Terms of Service
parent: Legal templates
nav_order: 1
---

# Terms of Service (template)

> **TEMPLATE. NOT LEGAL ADVICE.** This document is a starting point for a company that offers
> Guide Engine as a hosted service. It has not been reviewed by a lawyer. Have counsel in your
> jurisdiction review it, replace `{{COMPANY}}`, `{{CONTACT_EMAIL}}` and `{{JURISDICTION}}`,
> and complete every item in `[square brackets]` before publishing.

**Effective date:** `[date]`
**Operator:** `{{COMPANY}}`, `[registered address]` (the "Operator", "we", "us")
**Contact:** `{{CONTACT_EMAIL}}`

These Terms govern the use of the Guide Engine hosted service at `[service URLs: Studio, API]`
(the "Service"). By creating or joining an organization in the Studio, or by installing the
Service's snippet on a website, the organization you act for (the "Customer", "you") agrees to
these Terms. If you accept on behalf of an organization, you confirm that you are authorized to
do so.

## 1. The Service

Guide Engine lets the Customer author in-app guides (tooltips, modals, banners, tours and a
searchable help center) in the **Studio**, and show them on the Customer's own websites by
installing a script snippet carrying the application's public key. The Service records
analytics events about those guides (shown, step viewed, step completed, completed, dismissed,
errors, help center opened and searched) and shows them to the Customer in the Studio.

The Service consists of the Studio, the API the Studio and the snippet talk to, and the agent
script served from the API. The Operator may change, add or remove features; material
reductions in functionality are announced as described in section 12.

## 2. Accounts and organizations

1. **Identity.** People sign in to the Studio through the identity provider configured by the
   Operator (OpenID Connect). The provider supplies identity only (subject identifier, email
   address and name). Which organizations and applications a person can access is stored by the
   Service. The Customer is responsible for the security of the identity provider accounts its
   people use.
2. **Organizations and roles.** The person who creates an organization becomes its **owner**.
   Owners and admins manage the organization's applications and members; members get a role
   per application (viewer, editor, publisher or app admin). The Customer is responsible for who
   it invites, for the roles it grants, and for everything done under its members' sessions.
   Invitation links are valid for 7 days and work once; keep them private.
3. **Applications and keys.** Each application has a **public key**, embedded in the install
   snippet, and a list of **websites** (origins) where guides may load. The public key is not a
   secret. The optional **signing secret** for signed visitor identity is shown once and must be
   kept on the Customer's servers only; the Customer is responsible for its custody and may
   rotate it at any time in the Studio.
4. **Platform administration.** The Operator's staff can see organization names, owners,
   member, application and guide counts and event volumes for service administration. They
   cannot read the content of your guides, pages or per-visitor state unless an **owner** of your
   organization grants time-boxed, read-only **support access** in the Studio (see the
   [Privacy Policy](privacy.md), section 4). Every request made under support access is logged
   and visible to your organization's admins.

## 3. Acceptable use

You must not use the Service to:

- show guides on websites you do not control or are not authorized to modify;
- include in guide content anything unlawful, infringing, defamatory, deceptive or malicious,
  or anything that attempts to execute code or exfiltrate data (guide content is sanitized on
  save: scripts, styles, event handlers, iframes and SVG are removed, but the Customer remains
  responsible for what it publishes);
- pass to the Service, as visitor or account identifiers or in any other field, data you are
  not permitted to share with us, or data that is sensitive in a way the Service is not designed
  for (see section 5);
- probe, scan, overload or interfere with the Service, bypass rate limits, or attempt to access
  other customers' organizations;
- resell the Service or offer it to third parties as your own, unless agreed in writing.

The Operator may suspend an organization whose use violates these Terms (section 10).

## 4. Your content and your responsibilities

1. **Your content stays yours.** You retain all rights in the guides, pages, names and other
   content you create in the Studio ("Customer Content"). You grant the Operator the licence
   needed to store, process, display and serve Customer Content as the Service requires.
2. **You are responsible for it.** You are responsible for the accuracy and lawfulness of
   Customer Content, for having the rights to use it, and for keeping it appropriate for the
   audience of your websites.
3. **End-user notices and consent.** You decide which visitor and account identifiers your
   website passes to the Service, and you are responsible for any notice, consent or legal basis
   that your use of those identifiers and of guide analytics requires under the laws that apply
   to you and your users. The agent sets no cookies; an anonymous visitor's random identifier is
   stored by the agent in your website's browser storage (`localStorage`), under your domain, and
   you are responsible for disclosing that where required.
4. **Your websites.** You are responsible for the websites on which you install the snippet,
   for tagging elements (`data-guide-id`), and for listing the correct origins in the
   application's websites list.

## 5. Data protection

The Operator processes personal data about your authors as a controller, and personal data
about your end users as your processor, as described in the [Privacy Policy](privacy.md). Where
data protection law requires a written processing agreement, the
[Data Processing Addendum](dpa.md) applies and forms part of these Terms. The Service is designed
for identifiers and usage events, not for special categories of personal data, payment card data,
health data or government identifiers; do not pass such data to it.

## 6. Availability and support

1. **No SLA unless agreed.** The Service is provided without a committed availability level
   unless a separate written agreement (an order form or an SLA) says otherwise. The Operator
   aims to keep the Service available and to announce planned maintenance in advance, but may
   interrupt it for maintenance, security reasons or events outside its control.
2. **Fail closed.** The agent is designed so that when the Service cannot be reached or an
   application is switched off, websites simply show no guides; it does not block or break the
   Customer's pages. The Operator is not liable for guides not being shown.
3. **Support.** `[Describe the support channel, hours and response targets, if any; otherwise
   state that support is provided on a reasonable-efforts basis through {{CONTACT_EMAIL}}.]`

## 7. Fees

`[Describe the pricing model, billing period, payment terms, taxes, late payment and price
changes, or state that the Service is provided free of charge. If free, say whether the Operator
may introduce fees and with how much notice.]`

## 8. Changes to the Service and these Terms

See section 12.

## 9. Term and termination

1. These Terms apply from the moment an organization is created until it is deleted or the
   agreement is terminated.
2. **By you.** Owners can stop using the Service at any time: switch applications off, rotate or
   stop using the public key, remove the snippet from your websites, and ask the Operator to
   delete the organization (section 11). `[If fees apply: state the notice period and whether
   prepaid fees are refundable.]`
3. **By the Operator.** The Operator may terminate with `[notice period]` notice, or
   immediately on a material breach of these Terms that is not cured within `[cure period]`,
   on non-payment where fees apply, or where continued operation would be unlawful.

## 10. Suspension

The Operator may suspend an organization (its applications then serve no guides, and its
members see a notice in the Studio) or a single application where it reasonably believes that
use violates section 3, creates a security or legal risk, or where fees are overdue. The
Operator will tell the organization's owners why, and will lift the suspension when the cause is
resolved. A platform-wide kill switch exists for emergencies; its use is announced as an
incident.

## 11. Data on termination and deletion

1. **Self-service.** In the Studio, owners and admins can remove members, revoke invitations,
   close support access, disable guides, delete saved pages no guide uses, rotate public keys
   and switch applications off.
   Guide analytics are visible in the Studio for the retention period described in the
   [Privacy Policy](privacy.md).
2. **Export and deletion of the organization.** `[TODO: the Service currently has no
   self-service "export my organization" or "delete my organization" function. Until it does,
   describe the manual process:]` an owner requests export or deletion by writing to
   `{{CONTACT_EMAIL}}` from the email address of their Studio account. The Operator verifies the
   request with the organization's owners, provides a copy of the organization's data in a
   machine-readable form within `[number]` days, and deletes the organization's data (guides,
   versions, pages, members, invitations, support-access log, analytics events, per-visitor
   state and agent error reports) within `[number]` days of the request, except where retention
   is required by law. Backups are overwritten on the Operator's backup schedule
   (see the Privacy Policy, section 6).
3. **Author accounts.** A person's Studio record (identifier, email, name) is kept while they
   are a member of any organization, and is deleted on request to `{{CONTACT_EMAIL}}` once they
   have left or been removed from all organizations.

## 12. Changes

The Operator may update the Service and these Terms. Changes to these Terms that materially
reduce your rights or increase your obligations are announced at least `[30]` days in advance by
email to the organization's owners and/or a notice in the Studio. Continued use after the
effective date is acceptance; if you do not agree, stop using the Service and request deletion
under section 11.

## 13. Warranties and disclaimers

The Service is provided "as is" and "as available". To the extent permitted by law, the Operator
disclaims all warranties, express or implied, including merchantability, fitness for a
particular purpose and non-infringement, and does not warrant that the Service will be
uninterrupted, error-free or secure, or that guides will be shown to any particular visitor.

## 14. Limitation of liability

To the extent permitted by law: (a) neither party is liable for indirect, incidental, special,
consequential or punitive damages, or for lost profits, revenue or data; (b) the Operator's
total liability under these Terms is limited to `[the fees paid by the Customer in the 12 months
before the claim, or [amount] if the Service is free]`. These limits do not apply to liability
that cannot be limited by law, `[and, if you choose, to breaches of confidentiality or data
protection obligations, or to wilful misconduct]`.

## 15. Indemnity

You will defend and indemnify the Operator against third-party claims arising from Customer
Content, from your websites, or from your use of visitor and account identifiers in breach of
section 4 or applicable law. `[Consider a reciprocal IP indemnity from the Operator.]`

## 16. General

- **Governing law and venue:** `{{JURISDICTION}}`.
- **Entire agreement:** these Terms, the Privacy Policy, the DPA and any order form are the
  whole agreement; order forms prevail over these Terms where they conflict.
- **Assignment:** neither party may assign without consent, except to a successor of its
  business.
- **Severability, waiver, notices:** `[standard clauses]`. Notices to the Operator go to
  `{{CONTACT_EMAIL}}`; notices to the Customer go to the email addresses of its organization's
  owners.
- **Open source:** the Guide Engine software is `[licence]`; these Terms cover the hosted
  Service, not the software licence.
