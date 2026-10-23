import jwt from 'jsonwebtoken';
import { z } from 'zod';
import type { AgentApp } from '../db';

/**
 * End-user identity for agent (install snippet) requests.
 *
 * The app key is public, so by default visitor/account ids are simply what
 * the host page passes to guideEngine.initialize() — like Pendo, convenient
 * but spoofable. An app can switch on identity_mode = 'required': then every
 * request must carry a JWT the customer's BACKEND signed with the app's
 * signing secret, so ids can't be forged from the browser. If a JWT is sent
 * at all it must verify, even when it isn't required.
 *
 * Visitor tags travel the same way: plain in the body for unsigned visitors,
 * inside the token's visitor claim for signed ones (body tags are then
 * ignored, like body ids).
 */
export interface Visitor {
  visitorId: string;
  accountId: string | null;
  /** What the host application says this visitor may do; matched against guide_version.visitor_tags. */
  tags: string[];
}

const idSchema = z.string().trim().min(1).max(256);

/**
 * One visitor tag. Opaque to Guide Engine, so the format is narrow enough to
 * type into the Studio, read in logs and compare exactly: letters, digits and
 * _ . : / - — e.g. "POINT_OF_SALE", "CUSTOMERS:edit". Case-sensitive.
 */
export const VISITOR_TAG_PATTERN = /^[A-Za-z0-9_.:/-]{1,100}$/;
export const visitorTagSchema = z.string().regex(VISITOR_TAG_PATTERN, 'letters, digits and _ . : / - only (max 100)');

/**
 * A visitor's tags. Generous, because a host application may derive one per
 * permission and level (a staff user can hold several hundred); the per-guide
 * list is much shorter (see guides.ts).
 */
export const MAX_VISITOR_TAGS = 1000;
const visitorTagsSchema = z.array(visitorTagSchema).max(MAX_VISITOR_TAGS);

const visitorInputSchema = z.object({ id: idSchema, tags: visitorTagsSchema.optional() }).passthrough();

export const identityInputSchema = z.object({
  visitor: visitorInputSchema.optional(),
  account: z.object({ id: idSchema }).passthrough().nullable().optional(),
  // Room for a signed visitor with hundreds of tags.
  jwt: z.string().max(65_536).optional(),
});
export type IdentityInput = z.infer<typeof identityInputSchema>;

const signedClaimsSchema = z.object({
  visitor: visitorInputSchema,
  account: z.object({ id: idSchema }).passthrough().nullable().optional(),
  exp: z.number(), // required: no eternal identities
});

export type VisitorResult = { ok: true; visitor: Visitor } | { ok: false; error: string };

const uniqueTags = (tags: string[] | undefined): string[] => [...new Set(tags ?? [])];

export function resolveVisitor(app: AgentApp, input: IdentityInput): VisitorResult {
  if (input.jwt !== undefined) {
    if (!app.signingSecret) return { ok: false, error: 'identity_invalid' };
    try {
      const payload = jwt.verify(input.jwt, app.signingSecret, { algorithms: ['HS256'], clockTolerance: 5 });
      const claims = signedClaimsSchema.safeParse(payload);
      if (!claims.success) return { ok: false, error: 'identity_invalid' };
      return {
        ok: true,
        visitor: {
          visitorId: claims.data.visitor.id,
          accountId: claims.data.account?.id ?? null,
          tags: uniqueTags(claims.data.visitor.tags),
        },
      };
    } catch {
      return { ok: false, error: 'identity_invalid' };
    }
  }

  if (app.identityMode === 'required') return { ok: false, error: 'signed_identity_required' };
  if (!input.visitor) return { ok: false, error: 'visitor_required' };
  return {
    ok: true,
    visitor: {
      visitorId: input.visitor.id,
      accountId: input.account?.id ?? null,
      tags: uniqueTags(input.visitor.tags),
    },
  };
}
