/**
 * Single sign-on for the Studio via an external OpenID Connect provider.
 * The provider is used for IDENTITY only (who you are: sub, email, name);
 * which organizations and apps you can manage lives in our database.
 * Tokens are verified with the provider's published keys (JWKS).
 */
export interface OidcConfig {
  issuer: string;
  /** Expected `aud` of access tokens (the API's identifier at the provider). */
  audience: string;
  /** Overrides discovery via {issuer}/.well-known/openid-configuration. */
  jwksUri?: string;
  /** Public Studio (browser) client — for the Authorization Code + PKCE login. */
  studioClientId?: string;
  studioScope: string;
}

/**
 * Auth configuration, validated once at boot. Misconfiguration throws, so the
 * process refuses to start rather than running with auth half-configured
 * (fail closed).
 */
export interface AuthConfig {
  /**
   * HS256 secret for DEVELOPMENT Studio tokens (`npm run mint-token`). Only
   * honoured when NODE_ENV is development or test; production Studio sign-in
   * is OIDC only.
   */
  devTokenSecret?: string;
  oidc?: OidcConfig;
}

/** NODE_ENV values that unlock developer conveniences. */
const DEV_ENVS = new Set(['development', 'test']);
const MIN_SECRET_LENGTH = 32;

export function isDevEnvironment(env: NodeJS.ProcessEnv = process.env): boolean {
  return DEV_ENVS.has(env.NODE_ENV ?? '');
}

export function loadAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const dev = isDevEnvironment(env);
  const oidc = loadOidcConfig(env, dev);

  // Development tokens are an allowlisted-environment convenience. An
  // environment that forgot NODE_ENV (a common staging mistake) gets none.
  const secret = env.JWT_SECRET || undefined;
  if (secret !== undefined && secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`JWT_SECRET must be at least ${MIN_SECRET_LENGTH} characters.`);
  }
  const devTokenSecret = dev ? secret : undefined;

  if (!oidc && !devTokenSecret) {
    throw new Error(
      dev
        ? 'No Studio sign-in configured: set OIDC_ISSUER, or JWT_SECRET for development tokens.'
        : 'OIDC_ISSUER is required outside development: the Studio signs in through your identity provider.',
    );
  }
  return { devTokenSecret, oidc };
}

function loadOidcConfig(env: NodeJS.ProcessEnv, dev: boolean): OidcConfig | undefined {
  const issuer = env.OIDC_ISSUER?.replace(/\/$/, '');
  if (!issuer) return undefined;

  if (!env.OIDC_AUDIENCE) {
    // Without an audience check, a token the provider issued for some OTHER
    // application would be accepted here.
    throw new Error('OIDC_AUDIENCE is required when OIDC_ISSUER is set.');
  }
  // Plain http is only tolerated for a local mock provider during development.
  const local = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(issuer);
  if (!issuer.startsWith('https://') && !(local && dev)) {
    throw new Error('OIDC_ISSUER must use https (http://localhost is allowed only in development/test).');
  }

  return {
    issuer,
    audience: env.OIDC_AUDIENCE,
    jwksUri: env.OIDC_JWKS_URI || undefined,
    studioClientId: env.OIDC_STUDIO_CLIENT_ID || undefined,
    studioScope: env.OIDC_STUDIO_SCOPE || 'openid profile email',
  };
}

let cached: AuthConfig | null = null;

/** Config for the request path; loaded on first use (createApp forces it at boot). */
export function getAuthConfig(): AuthConfig {
  cached ??= loadAuthConfig();
  return cached;
}

/** @internal tests only — lets a suite re-read process.env. */
export function resetAuthConfigForTests(): void {
  cached = null;
}
