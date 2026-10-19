import { Router } from 'express';
import { getAuthConfig, isDevEnvironment } from '../auth/config';

export const authRouter = Router();

// ------------------------------------------------------------
// GET /auth/config — [public] how the Studio should sign in. Only public
// identifiers (issuer, public client id, scopes) — no secrets.
// ------------------------------------------------------------
authRouter.get('/config', (_req, res) => {
  const { oidc, devTokenSecret } = getAuthConfig();
  const sso = oidc?.studioClientId ? { issuer: oidc.issuer, clientId: oidc.studioClientId, scope: oidc.studioScope } : null;
  res.json({
    oidc: sso,
    // Development tokens (npm run mint-token) are only accepted in dev/test.
    tokenPaste: Boolean(devTokenSecret) && isDevEnvironment(),
  });
});
