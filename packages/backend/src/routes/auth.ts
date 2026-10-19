import { Router } from 'express';
import { getAuthConfig, isDevEnvironment } from '../auth/config';
import { invitationMailAvailable } from '../mail';

export const authRouter = Router();

// ------------------------------------------------------------
// GET /auth/config — [public] how the Studio should sign in. Only public
// identifiers (issuer, public client id, scopes) — no secrets.
// ------------------------------------------------------------
authRouter.get('/config', (_req, res) => {
  const { oidc, devTokenSecret } = getAuthConfig();
  const sso = oidc?.studioClientId
    ? { issuer: oidc.issuer, clientId: oidc.studioClientId, scope: oidc.studioScope }
    : null;
  res.json({
    oidc: sso,
    // Development tokens (npm run mint-token) are only accepted in dev/test.
    tokenPaste: Boolean(devTokenSecret) && isDevEnvironment(),
    // Whether the Members page can promise to email invitations (SMTP_URL,
    // MAIL_FROM and STUDIO_URL all set); otherwise it shows links to copy.
    mailEnabled: invitationMailAvailable(),
  });
});
