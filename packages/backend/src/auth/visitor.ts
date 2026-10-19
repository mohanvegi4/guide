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
 */
export interface Visitor {
  visitorId: string;
  accountId: string | null;
}

const idSchema = z.string().trim().min(1).max(256);

export const identityInputSchema = z.object({
  visitor: z.object({ id: idSchema }).passthrough().optional(),
  account: z.object({ id: idSchema }).passthrough().nullable().optional(),
  jwt: z.string().max(8192).optional(),
});
export type IdentityInput = z.infer<typeof identityInputSchema>;

const signedClaimsSchema = z.object({
  visitor: z.object({ id: idSchema }).passthrough(),
  account: z.object({ id: idSchema }).passthrough().nullable().optional(),
  exp: z.number(), // required: no eternal identities
});

export type VisitorResult = { ok: true; visitor: Visitor } | { ok: false; error: string };

export function resolveVisitor(app: AgentApp, input: IdentityInput): VisitorResult {
  if (input.jwt !== undefined) {
    if (!app.signingSecret) return { ok: false, error: 'identity_invalid' };
    try {
      const payload = jwt.verify(input.jwt, app.signingSecret, { algorithms: ['HS256'], clockTolerance: 5 });
      const claims = signedClaimsSchema.safeParse(payload);
      if (!claims.success) return { ok: false, error: 'identity_invalid' };
      return {
        ok: true,
        visitor: { visitorId: claims.data.visitor.id, accountId: claims.data.account?.id ?? null },
      };
    } catch {
      return { ok: false, error: 'identity_invalid' };
    }
  }

  if (app.identityMode === 'required') return { ok: false, error: 'signed_identity_required' };
  if (!input.visitor) return { ok: false, error: 'visitor_required' };
  return { ok: true, visitor: { visitorId: input.visitor.id, accountId: input.account?.id ?? null } };
}
