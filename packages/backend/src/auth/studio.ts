import { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { AuthConfig, getAuthConfig } from './config';
import { OidcVerifier, createOidcVerifier } from './oidc';
import { withIdentity } from '../db';

/** Who a verified Studio token says the caller is. Authorization comes from our DB, not the token. */
export interface StudioIdentity {
  issuer: string;
  sub: string;
  email?: string;
  emailVerified: boolean;
  name?: string;
}

/** Issuer recorded for development tokens minted by `npm run mint-token`. */
export const DEV_TOKEN_ISSUER = 'guide-engine-dev';

export interface StudioRequest extends Request {
  studioUser?: { id: string; email?: string; emailVerified: boolean; name?: string };
}

const devClaimsSchema = z.object({
  sub: z.string().min(1),
  email: z.string().email().optional(),
  name: z.string().optional(),
  // jsonwebtoken only checks exp when present; require it.
  exp: z.number(),
});

/**
 * Verifies a Studio bearer token. Routes by the token's declared algorithm,
 * each path pinned to its own algorithms and keys: HS256 -> the development
 * secret (dev/test only); asymmetric -> the OIDC provider's JWKS. The header
 * only chooses the path; each verifier re-checks the algorithm.
 * Returns null for ANY failure — all failures look the same to the caller.
 */
export async function verifyStudioToken(
  token: string,
  config: AuthConfig,
  oidc: OidcVerifier | null,
): Promise<StudioIdentity | null> {
  const header = jwt.decode(token, { complete: true })?.header;
  if (!header) return null;

  if (header.alg !== 'HS256') return oidc ? oidc(token) : null;
  if (!config.devTokenSecret) return null;

  try {
    const payload = jwt.verify(token, config.devTokenSecret, {
      algorithms: ['HS256'],
      issuer: DEV_TOKEN_ISSUER,
      clockTolerance: 5,
    });
    const parsed = devClaimsSchema.safeParse(payload);
    if (!parsed.success) return null;
    return {
      issuer: DEV_TOKEN_ISSUER,
      sub: parsed.data.sub,
      email: parsed.data.email,
      // Dev tokens are minted by an operator on their own machine.
      emailVerified: parsed.data.email !== undefined,
      name: parsed.data.name,
    };
  } catch {
    return null;
  }
}

let oidcVerifier: OidcVerifier | null | undefined;

/** One verifier (and so one JWKS cache) per process; null when OIDC isn't configured. */
function getOidcVerifier(): OidcVerifier | null {
  if (oidcVerifier === undefined) {
    const { oidc } = getAuthConfig();
    oidcVerifier = oidc ? createOidcVerifier(oidc) : null;
  }
  return oidcVerifier;
}

/**
 * Finds or creates the studio_user for a verified identity (just-in-time
 * provisioning: the first sign-in creates the account). Profile fields are
 * refreshed at most every few minutes so busy users don't write every request.
 */
export async function provisionStudioUser(identity: StudioIdentity): Promise<string> {
  return withIdentity(`${identity.issuer}|${identity.sub}`, async (client) => {
    const existing = await client.query<{ id: string; stale: boolean }>(
      `SELECT id, last_seen_at < now() - interval '5 minutes' AS stale
       FROM studio_user WHERE oidc_issuer = $1 AND oidc_sub = $2`,
      [identity.issuer, identity.sub],
    );
    if (existing.rows[0] && !existing.rows[0].stale) return existing.rows[0].id;

    const upserted = await client.query<{ id: string }>(
      `INSERT INTO studio_user (oidc_issuer, oidc_sub, email, email_verified, name)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (oidc_issuer, oidc_sub) DO UPDATE
         SET email = EXCLUDED.email, email_verified = EXCLUDED.email_verified,
             name = COALESCE(EXCLUDED.name, studio_user.name), last_seen_at = now()
       RETURNING id`,
      [identity.issuer, identity.sub, identity.email ?? null, identity.emailVerified, identity.name ?? null],
    );
    return upserted.rows[0].id;
  });
}

/**
 * Requires a verified Studio user. Sets req.studioUser; organizations and
 * roles are resolved per request from the database (db.ts withStudioSession).
 */
export function requireStudioUser(req: Request, res: Response, next: NextFunction): void {
  const header = req.header('authorization');
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'missing_auth' });
    return;
  }
  verifyStudioToken(header.slice('Bearer '.length), getAuthConfig(), getOidcVerifier())
    .then(async (identity) => {
      if (!identity) {
        res.status(401).json({ error: 'invalid_token' });
        return;
      }
      const id = await provisionStudioUser(identity);
      (req as StudioRequest).studioUser = {
        id,
        email: identity.email,
        emailVerified: identity.emailVerified,
        name: identity.name,
      };
      next();
    })
    .catch(next);
}
