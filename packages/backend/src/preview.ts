import jwt from 'jsonwebtoken';
import { z } from 'zod';

/**
 * Signed preview links: the Studio mints a short-lived token naming one
 * guide version of one app; the agent, seeing ?guidePreview=<token> in the
 * host page's URL, asks the backend to verify it and force-render that
 * version regardless of the guide's enabled flag or publish state. The token
 * only resolves through that same app's public key, so a leaked link can't be
 * used to read guides from another app.
 *
 * Signed with PREVIEW_TOKEN_SECRET, which must differ from JWT_SECRET, and a
 * dedicated audience — so a preview token can never be replayed as an auth
 * token (or vice versa), even if one leaks via a shared URL.
 */
const PREVIEW_AUDIENCE = 'guide-preview';
const PREVIEW_ISSUER = 'guide-engine';
export const PREVIEW_TTL_SECONDS = 15 * 60;

export interface PreviewClaims {
  guideId: string;
  versionId: string;
  appId: string;
}

const claimsSchema = z.object({
  typ: z.literal('guide_preview'),
  guideId: z.string().uuid(),
  versionId: z.string().uuid(),
  appId: z.string().uuid(),
});

/** Returns the preview secret, or null when preview is not configured (feature off). */
export function previewSecret(env: NodeJS.ProcessEnv = process.env): string | null {
  const secret = env.PREVIEW_TOKEN_SECRET;
  if (!secret) return null;
  if (secret.length < 32) throw new Error('PREVIEW_TOKEN_SECRET must be at least 32 characters.');
  if (secret === env.JWT_SECRET) {
    // Same key for both would let a preview token pass as a session token.
    throw new Error('PREVIEW_TOKEN_SECRET must differ from JWT_SECRET.');
  }
  return secret;
}

export function signPreviewToken(claims: PreviewClaims, secret: string): string {
  return jwt.sign({ typ: 'guide_preview', ...claims }, secret, {
    algorithm: 'HS256',
    audience: PREVIEW_AUDIENCE,
    issuer: PREVIEW_ISSUER,
    expiresIn: PREVIEW_TTL_SECONDS,
  });
}

/** Null for any failure: bad signature, expired, wrong audience/issuer/typ, malformed. */
export function verifyPreviewToken(token: string, secret: string): PreviewClaims | null {
  try {
    const payload = jwt.verify(token, secret, {
      algorithms: ['HS256'],
      audience: PREVIEW_AUDIENCE,
      issuer: PREVIEW_ISSUER,
    });
    const parsed = claimsSchema.safeParse(payload);
    if (!parsed.success) return null;
    const { guideId, versionId, appId } = parsed.data;
    return { guideId, versionId, appId };
  } catch {
    return null;
  }
}

/**
 * Host-app path to open for a preview: the exact route, or a pattern's
 * literal prefix (e.g. '/projects/*' -> '/projects/'). The SDK force-renders
 * the preview regardless of route, so this is just a sensible landing page.
 */
export function previewPath(routeMatch: { type: string; value: string }): string {
  if (routeMatch.type === 'exact') return routeMatch.value;
  const prefix = routeMatch.value.split('*')[0];
  return prefix.startsWith('/') ? prefix : '/';
}
