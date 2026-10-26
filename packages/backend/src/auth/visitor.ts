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
 * inside the token's visitor claim for signed ones (everything sent beside a
 * token is then ignored, ids included).
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

/** Tags a guide version may list (routes/studio/guides.ts, and chk_guide_version_visitor_tags). */
export const MAX_GUIDE_TAGS = 100;
/**
 * Tags a visitor may carry. Generous, because a host application may derive
 * one per permission and level (a staff user can hold several hundred).
 */
export const MAX_VISITOR_TAGS = 1000;
/**
 * A signed identity's length. It travels with every event batch, and browsers
 * cap keepalive requests at 64 KiB in total; the agent sends a larger body as
 * an ordinary request, which is lost only if the page is closing.
 */
export const MAX_IDENTITY_TOKEN_LENGTH = 65_536;

/**
 * The visitor's tags, as far as they can match anything: well-formed,
 * de-duplicated, at most MAX_VISITOR_TAGS. Anything else is dropped rather
 * than refused: a malformed tag can never match a guide (guide tags follow the
 * same pattern), so dropping it changes no decision, while refusing would
 * cost the visitor every guide, untagged ones included.
 */
function usableTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const wellFormed = raw.filter((t): t is string => typeof t === 'string' && VISITOR_TAG_PATTERN.test(t));
  return [...new Set(wellFormed)].slice(0, MAX_VISITOR_TAGS);
}

const visitorInputSchema = z.object({ id: idSchema, tags: z.unknown().optional() }).passthrough();
const accountInputSchema = z.object({ id: idSchema }).passthrough().nullable().optional();

const plainIdentitySchema = z.object({
  visitor: visitorInputSchema.optional(),
  account: accountInputSchema,
});

const signedClaimsSchema = z.object({
  visitor: visitorInputSchema,
  account: accountInputSchema,
  exp: z.number(), // required: no eternal identities
});

/** A request body's identity: a signed token (anything beside it is ignored), or plain ids. */
export type IdentityInput =
  | { jwt: string }
  | { jwt?: undefined; visitor?: z.infer<typeof visitorInputSchema>; account?: { id: string } | null };

/** Parses the identity part of an agent request body; null when it's malformed. */
export function parseIdentityInput(body: unknown): IdentityInput | null {
  const token = (body as { jwt?: unknown } | null)?.jwt;
  if (token !== undefined) return typeof token === 'string' ? { jwt: token } : null;
  const plain = plainIdentitySchema.safeParse(body ?? {});
  return plain.success ? plain.data : null;
}

export type VisitorResult = { ok: true; visitor: Visitor } | { ok: false; error: string };

export function resolveVisitor(app: AgentApp, input: IdentityInput): VisitorResult {
  if (input.jwt !== undefined) {
    if (!app.signingSecret || input.jwt.length > MAX_IDENTITY_TOKEN_LENGTH) {
      return { ok: false, error: 'identity_invalid' };
    }
    try {
      const payload = jwt.verify(input.jwt, app.signingSecret, { algorithms: ['HS256'], clockTolerance: 5 });
      const claims = signedClaimsSchema.safeParse(payload);
      if (!claims.success) return { ok: false, error: 'identity_invalid' };
      return {
        ok: true,
        visitor: {
          visitorId: claims.data.visitor.id,
          accountId: claims.data.account?.id ?? null,
          tags: usableTags(claims.data.visitor.tags),
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
      tags: usableTags(input.visitor.tags),
    },
  };
}
