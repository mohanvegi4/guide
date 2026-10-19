import { Request, Response, NextFunction, RequestHandler } from 'express';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { AuthConfig, getAuthConfig } from '../auth/config';
import { OidcVerifier, createOidcVerifier } from '../auth/oidc';

export interface AuthedRequest extends Request {
  tenantId?: string;
  userId?: string;
  roles?: string[];
}

/** Role that may author the tenant's own guides (Studio). End-user SDK tokens don't carry it. */
export const GUIDE_ADMIN_ROLE = 'guide_admin';
/** Role that may author GLOBAL guides, shown to every tenant. */
export const PLATFORM_ADMIN_ROLE = 'platform_admin';

/**
 * Resolves the calling tenant from the AUTHENTICATED SESSION — never from a
 * client-supplied query param or body field. This is the single most
 * important security boundary in the whole service: every downstream route
 * trusts req.tenantId, so it must never be settable by request input.
 */
export function requireTenant(req: AuthedRequest, res: Response, next: NextFunction): void {
  const authHeader = req.header('authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'missing_auth' });
    return;
  }

  verifyAndDecodeToken(authHeader.slice('Bearer '.length), getAuthConfig(), getOidcVerifier())
    .then((claims) => {
      if (!claims) {
        res.status(401).json({ error: 'invalid_token' });
        return;
      }
      req.tenantId = claims.tenantId;
      req.userId = claims.userId;
      req.roles = claims.roles;
      next();
    })
    .catch(next);
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
 * Authorization on top of authentication: a valid tenant token proves who the
 * caller is, not that they may author guides. Without this, any end user's
 * SDK token could create or publish guides for their tenant.
 * Must run after requireTenant.
 */
export function requireRole(role: string): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!(req as AuthedRequest).roles?.includes(role)) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    next();
  };
}

export interface TokenClaims {
  tenantId: string;
  userId: string;
  roles: string[];
}

const jwtClaimsSchema = z.object({
  tenantId: z.string().uuid(),
  userId: z.string().min(1),
  // Either a single `role` or a `roles` array (common in identity providers).
  role: z.string().optional(),
  roles: z.array(z.string()).optional(),
  // jsonwebtoken only checks exp when present; a token without one would be
  // valid forever, so it's required here.
  exp: z.number(),
});

/**
 * Returns the verified claims, or null for ANY failure (bad signature,
 * expired, wrong alg/issuer/audience, malformed or missing claims). All
 * failures are deliberately indistinguishable to the caller.
 */
export async function verifyAndDecodeToken(
  token: string,
  config: AuthConfig,
  oidc: OidcVerifier | null = null
): Promise<TokenClaims | null> {
  // DEV-ONLY FALLBACK: lets you run/curl this service locally without minting
  // JWTs. It trusts a raw "tenantId:userId[:role]" string as the bearer token.
  // This is NOT authentication. config.devAuth can only be true when NODE_ENV
  // is development/test — loadAuthConfig() refuses to boot otherwise.
  // Anything shaped like a JWT still goes through real verification below.
  if (config.devAuth && !token.includes('.')) {
    const [tenantId, userId, role] = token.split(':');
    if (!z.string().uuid().safeParse(tenantId).success || !userId) return null;
    return { tenantId, userId, roles: role ? role.split(',') : [] };
  }

  // Route by the token's declared algorithm, each path pinned to its own
  // algorithms and key material: HS256 -> our JWT_SECRET; asymmetric -> the
  // OIDC provider's JWKS. The header is only used to choose a path — each
  // verifier re-checks the algorithm against its own allowlist.
  const header = jwt.decode(token, { complete: true })?.header;
  if (header && header.alg !== 'HS256') {
    return oidc ? oidc(token) : null;
  }

  if (!config.jwtSecret) return null;

  try {
    const payload = jwt.verify(token, config.jwtSecret, {
      // Pinning the algorithm blocks alg:none and RS/HS confusion attacks.
      algorithms: ['HS256'],
      issuer: config.issuer,
      audience: config.audience,
      clockTolerance: 5,
    });
    const parsed = jwtClaimsSchema.safeParse(payload);
    if (!parsed.success) return null;
    const { tenantId, userId, role, roles } = parsed.data;
    return { tenantId, userId, roles: [...(roles ?? []), ...(role ? [role] : [])] };
  } catch {
    // Expired, bad signature, malformed — all rejected the same way.
    return null;
  }
}
