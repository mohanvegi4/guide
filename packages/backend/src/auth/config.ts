/**
 * Single sign-on via an external OpenID Connect provider. Tokens it issues are
 * verified with the provider's published keys (JWKS) — asymmetric RS/ES
 * algorithms only — and mapped to our tenant/user/roles claims.
 */
export interface OidcConfig {
  issuer: string;
  /** Expected `aud` of access tokens (the API's identifier at the provider). */
  audience: string;
  /** Overrides discovery via {issuer}/.well-known/openid-configuration. */
  jwksUri?: string;
  /** Claim paths (dot notation for nested claims, e.g. realm_access.roles). */
  tenantClaim: string;
  userClaim: string;
  rolesClaim: string;
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
  /** HMAC secret for our own HS256 bearer tokens (SDK end users, scripts). */
  jwtSecret?: string;
  issuer?: string;
  audience?: string;
  /**
   * When true, raw "tenantId:userId[:role]" bearer tokens are accepted in
   * addition to JWTs. Only ever true for NODE_ENV development/test.
   */
  devAuth: boolean;
  oidc?: OidcConfig;
}

/** NODE_ENV values in which the dev auth bypass may be switched on. */
const DEV_AUTH_ALLOWED_ENVS = new Set(['development', 'test']);

const MIN_SECRET_LENGTH = 32;

export function loadAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const devRequested = env.GUIDE_ENGINE_DEV_AUTH === 'true';

  // Allowlist, not `!== 'production'`: an environment that forgot to set
  // NODE_ENV (a common staging mistake) must not be able to enable the bypass.
  // And if someone sets the flag where it isn't allowed, refuse to boot rather
  // than silently ignore it — a loud failure gets the config fixed.
  if (devRequested && !DEV_AUTH_ALLOWED_ENVS.has(env.NODE_ENV ?? '')) {
    throw new Error(
      `GUIDE_ENGINE_DEV_AUTH=true is only allowed when NODE_ENV is development or test ` +
        `(got ${env.NODE_ENV ? `"${env.NODE_ENV}"` : 'unset'}). Remove it from this environment.`
    );
  }

  const oidc = loadOidcConfig(env);
  const jwtSecret = env.JWT_SECRET || undefined;
  if (jwtSecret === undefined && !oidc && !devRequested) {
    throw new Error(
      'No token verification configured: set JWT_SECRET (generate with `openssl rand -hex 32`) and/or OIDC_ISSUER.'
    );
  }
  if (jwtSecret !== undefined && jwtSecret.length < MIN_SECRET_LENGTH) {
    throw new Error(`JWT_SECRET must be at least ${MIN_SECRET_LENGTH} characters.`);
  }

  return {
    jwtSecret,
    issuer: env.JWT_ISSUER || undefined,
    audience: env.JWT_AUDIENCE || undefined,
    devAuth: devRequested,
    oidc,
  };
}

function loadOidcConfig(env: NodeJS.ProcessEnv): OidcConfig | undefined {
  const issuer = env.OIDC_ISSUER?.replace(/\/$/, '');
  if (!issuer) return undefined;

  if (!env.OIDC_AUDIENCE) {
    // Without an audience check, a token the provider issued for some OTHER
    // application would be accepted here.
    throw new Error('OIDC_AUDIENCE is required when OIDC_ISSUER is set.');
  }
  // Plain http is only tolerated for a local mock provider during development.
  const local = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(issuer);
  if (!issuer.startsWith('https://') && !(local && DEV_AUTH_ALLOWED_ENVS.has(env.NODE_ENV ?? ''))) {
    throw new Error('OIDC_ISSUER must use https (http://localhost is allowed only in development/test).');
  }

  return {
    issuer,
    audience: env.OIDC_AUDIENCE,
    jwksUri: env.OIDC_JWKS_URI || undefined,
    tenantClaim: env.OIDC_TENANT_CLAIM || 'tenantId',
    userClaim: env.OIDC_USER_CLAIM || 'sub',
    rolesClaim: env.OIDC_ROLES_CLAIM || 'roles',
    studioClientId: env.OIDC_STUDIO_CLIENT_ID || undefined,
    studioScope: env.OIDC_STUDIO_SCOPE || 'openid profile',
  };
}

/** NODE_ENV allows developer conveniences such as the Studio's paste-a-token login. */
export function isDevEnvironment(env: NodeJS.ProcessEnv = process.env): boolean {
  return DEV_AUTH_ALLOWED_ENVS.has(env.NODE_ENV ?? '');
}

let cached: AuthConfig | null = null;

/** Config for the request path; loaded on first use (createApp forces it at boot). */
export function getAuthConfig(): AuthConfig {
  if (!cached) {
    cached = loadAuthConfig();
    if (cached.devAuth) {
      console.warn(
        '\n⚠️  GUIDE_ENGINE_DEV_AUTH is ON — raw "tenantId:userId" bearer tokens are accepted. ' +
          'This is NOT authentication. Local development only.\n'
      );
    }
  }
  return cached;
}

/** @internal tests only — lets a suite re-read process.env. */
export function resetAuthConfigForTests(): void {
  cached = null;
}
