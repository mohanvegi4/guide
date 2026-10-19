import jwt from 'jsonwebtoken';

/** Signs a real HS256 token with the test JWT_SECRET (see vitest.config.mts). */
export function signToken(claims: Record<string, unknown>, options: jwt.SignOptions = {}): string {
  return jwt.sign(claims, process.env.JWT_SECRET!, {
    algorithm: 'HS256',
    expiresIn: '5m',
    issuer: process.env.JWT_ISSUER,
    audience: process.env.JWT_AUDIENCE,
    ...options,
  });
}

/** Authoring Studio caller (guide_admin role). */
export function bearer(tenantId: string, userId = 'admin-1'): string {
  return `Bearer ${signToken({ tenantId, userId, role: 'guide_admin' })}`;
}

/** End-user SDK caller: valid tenant token, no authoring role. */
export function endUserBearer(tenantId: string, userId = 'end-user-1'): string {
  return `Bearer ${signToken({ tenantId, userId })}`;
}

/** Platform admin: manages global guides (from their own home tenant session). */
export function platformBearer(tenantId: string, userId = 'platform-1'): string {
  return `Bearer ${signToken({ tenantId, userId, roles: ['platform_admin'] })}`;
}
