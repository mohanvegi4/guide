import { Request, Response, NextFunction } from 'express';

export interface AuthedRequest extends Request {
  tenantId?: string;
  userId?: string;
}

/**
 * Resolves the calling tenant from the AUTHENTICATED SESSION — never from a
 * client-supplied query param or body field. This is the single most
 * important security boundary in the whole service: every downstream route
 * trusts req.tenantId, so it must never be settable by request input.
 *
 * This is a placeholder that reads from a verified JWT-style bearer token.
 * Wire this up to your real auth (session cookie lookup, JWT verification
 * with your actual signing key, SSO middleware, etc.) before shipping.
 */
export function requireTenant(req: AuthedRequest, res: Response, next: NextFunction): void {
  const authHeader = req.header('authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'missing_auth' });
    return;
  }

  const claims = verifyAndDecodeToken(authHeader.slice('Bearer '.length));
  if (!claims) {
    res.status(401).json({ error: 'invalid_token' });
    return;
  }

  req.tenantId = claims.tenantId;
  req.userId = claims.userId;
  next();
}

interface TokenClaims {
  tenantId: string;
  userId: string;
}

function verifyAndDecodeToken(token: string): TokenClaims | null {
  // DEV-ONLY FALLBACK: lets you run/curl this service locally before real auth
  // is wired up. It trusts a raw "tenantId:userId" string as the bearer token.
  // This is NOT authentication — it is explicitly unsafe and MUST be removed
  // before any deployment beyond your own machine. Gated behind an env var so
  // it can't accidentally end up live.
  if (process.env.GUIDE_ENGINE_DEV_AUTH === 'true') {
    const [tenantId, userId] = token.split(':');
    if (tenantId && userId) return { tenantId, userId };
    return null;
  }

  // TODO: replace with real JWT verification (e.g. `jsonwebtoken` + your signing
  // secret/JWKS endpoint). Left unimplemented deliberately rather than faked,
  // since a stubbed "always valid" verifier here would be a real vulnerability
  // if this file ships as-is.
  throw new Error(
    'verifyAndDecodeToken() is not implemented — set GUIDE_ENGINE_DEV_AUTH=true for local testing, ' +
    'or wire up real JWT/session verification here before deploying.'
  );
}
