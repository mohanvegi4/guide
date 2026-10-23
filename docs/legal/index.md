---
title: Legal templates
nav_order: 6
has_children: true
---

# Legal templates

> **These are templates, not legal advice.** They were written to match what Guide Engine
> actually does, so that a company offering it as a hosted service has an accurate starting
> point. They have not been reviewed by a lawyer. Before you publish any of them, have counsel
> in your jurisdiction review them, and replace every placeholder: `{{COMPANY}}` (the legal
> entity operating the service), `{{CONTACT_EMAIL}}` (where legal and privacy requests go),
> `{{JURISDICTION}}` (governing law and venue), plus the dated and bracketed items in each
> document.

| Template | Use it when |
|---|---|
| [Terms of Service](terms.md) | You offer Guide Engine to other organizations as a hosted service. |
| [Privacy Policy](privacy.md) | You run the Studio and the agent API for customers; it covers both authors and the end users of customers' sites. |
| [Data Processing Addendum](dpa.md) | A customer needs a processor agreement (GDPR Art. 28 or similar). |
| [Subprocessors](subprocessors.md) | The list the Privacy Policy and the DPA refer to. |

**How the templates relate to the product.** Every factual statement in them, about what is
stored, where, and for how long, is taken from the [Guide Engine reference](../reference/README.md)
and the [Studio reference](../reference/studio.md). When the product changes, these templates need
the same change: a new event type, a new configuration variable that sends data somewhere, or a
new retention rule is also a legal change.

**Who is who.** In these templates, the **operator** (`{{COMPANY}}`) runs Guide Engine. A
**customer** is an organization in the Studio that installs the snippet on its own websites.
**Authors** are the customer's people who sign in to the Studio. **End users** (visitors) are the
people who use the customer's websites and see guides. For end-user data, the customer is the
controller and the operator is the processor; for author accounts, the operator is the
controller.
