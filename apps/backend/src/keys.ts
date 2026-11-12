import { createHash, randomBytes } from 'crypto';

/**
 * Public app key, embedded in every page's install snippet. It identifies the
 * app; it is NOT a secret and authenticates nobody (see auth/visitor.ts).
 */
export function generatePublicKey(): string {
  return `ge_pk_${randomBytes(16).toString('hex')}`;
}

/** Per-app secret the customer's backend uses to sign visitor identities (HS256). */
export function generateSigningSecret(): string {
  return `ge_sk_${randomBytes(32).toString('base64url')}`;
}

/** Invitation link token. Only its hash is stored, so a DB leak doesn't leak working links. */
export function generateInviteToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
