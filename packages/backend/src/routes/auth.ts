import { Router } from 'express';
import { getAuthConfig, isDevEnvironment } from '../auth/config';
import { AuthedRequest, requireTenant } from '../middleware/tenant';

export const authRouter = Router();

// ------------------------------------------------------------
// GET /auth/config — [public] how the Studio should sign in. Only public
// identifiers (issuer, public client id, scopes) — no secrets.
// ------------------------------------------------------------
authRouter.get('/config', (_req, res) => {
  const { oidc } = getAuthConfig();
  const sso = oidc?.studioClientId
    ? { issuer: oidc.issuer, clientId: oidc.studioClientId, scope: oidc.studioScope }
    : null;
  res.json({
    oidc: sso,
    // Paste-a-token stays available for local development, and as the only
    // option when no SSO is configured. Pasted tokens are still verified
    // server-side like any other; this flag is UX only.
    tokenPaste: !sso || isDevEnvironment(),
  });
});

// ------------------------------------------------------------
// GET /auth/me — the caller's VERIFIED identity, so the Studio never has to
// decode tokens or know a provider's claim names to decide what to show.
// ------------------------------------------------------------
authRouter.get('/me', requireTenant, (req, res) => {
  const { tenantId, userId, roles } = req as AuthedRequest;
  res.json({ tenantId, userId, roles: roles ?? [] });
});
