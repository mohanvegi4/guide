import jwt from 'jsonwebtoken';
import { JwksClient } from 'jwks-rsa';
import { z } from 'zod';
import type { OidcConfig } from './config';
import type { TokenClaims } from '../middleware/tenant';

/**
 * Asymmetric algorithms only. HS* is deliberately absent: with a JWKS, an
 * attacker could sign an HS256 token using the provider's PUBLIC key as the
 * HMAC secret (algorithm confusion). Our own HS256 tokens take a separate
 * path keyed on JWT_SECRET (see middleware/tenant.ts).
 */
export const OIDC_ALGORITHMS: jwt.Algorithm[] = [
  'RS256',
  'RS384',
  'RS512',
  'PS256',
  'PS384',
  'PS512',
  'ES256',
  'ES384',
];

export type OidcVerifier = (token: string) => Promise<TokenClaims | null>;

/**
 * Builds a verifier for tokens issued by an OIDC provider: signature via the
 * provider's JWKS (cached, rate-limited), then iss / aud / exp, then the
 * configured claims mapped onto tenantId / userId / roles.
 */
export function createOidcVerifier(config: OidcConfig): OidcVerifier {
  let clientPromise: Promise<JwksClient> | null = null;

  function getClient(): Promise<JwksClient> {
    clientPromise ??= resolveJwksUri(config)
      .then(
        (jwksUri) =>
          new JwksClient({
            jwksUri,
            cache: true,
            cacheMaxAge: 10 * 60 * 1000,
            rateLimit: true, // unknown `kid`s can't make us hammer the provider
            jwksRequestsPerMinute: 10,
            timeout: 5000,
          }),
      )
      .catch((err) => {
        clientPromise = null; // retry discovery on the next request
        throw err;
      });
    return clientPromise;
  }

  return async (token) => {
    try {
      const decoded = jwt.decode(token, { complete: true });
      if (!decoded || typeof decoded === 'string') return null;
      if (!OIDC_ALGORITHMS.includes(decoded.header.alg as jwt.Algorithm)) return null;

      const client = await getClient();
      const key = await client.getSigningKey(decoded.header.kid);
      const payload = jwt.verify(token, key.getPublicKey(), {
        algorithms: OIDC_ALGORITHMS,
        issuer: config.issuer,
        audience: config.audience,
        clockTolerance: 5,
      });
      return mapClaims(payload, config);
    } catch {
      // Bad signature, unknown key, expired, wrong iss/aud, JWKS unreachable —
      // all fail closed as "not authenticated".
      return null;
    }
  };
}

async function resolveJwksUri(config: OidcConfig): Promise<string> {
  if (config.jwksUri) return config.jwksUri;
  const res = await fetch(`${config.issuer}/.well-known/openid-configuration`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`OIDC discovery failed (${res.status})`);
  const doc = (await res.json()) as { issuer?: string; jwks_uri?: string };
  // The discovery document must describe the issuer we trust.
  if (doc.issuer?.replace(/\/$/, '') !== config.issuer || !doc.jwks_uri) {
    throw new Error('OIDC discovery document does not match OIDC_ISSUER');
  }
  return doc.jwks_uri;
}

function claimAt(payload: Record<string, unknown>, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>(
      (v, key) => (v && typeof v === 'object' ? (v as Record<string, unknown>)[key] : undefined),
      payload,
    );
}

function mapClaims(payload: string | jwt.JwtPayload, config: OidcConfig): TokenClaims | null {
  if (typeof payload === 'string') return null;
  // jsonwebtoken only checks exp when present; require it (no eternal tokens).
  if (typeof payload.exp !== 'number') return null;

  const tenant = z.string().uuid().safeParse(claimAt(payload, config.tenantClaim));
  const user = z.string().min(1).safeParse(claimAt(payload, config.userClaim));
  if (!tenant.success || !user.success) return null;

  // Roles may be an array, or a space/comma separated string — providers differ.
  const raw = claimAt(payload, config.rolesClaim);
  const roles = Array.isArray(raw)
    ? raw.filter((r): r is string => typeof r === 'string')
    : typeof raw === 'string'
      ? raw.split(/[\s,]+/).filter(Boolean)
      : [];

  return { tenantId: tenant.data, userId: user.data, roles };
}
