import type { RequestHandler } from 'express';

/**
 * Baseline response hardening for everything the backend serves. Done by hand
 * rather than with helmet: three headers are all an API needs, and helmet's
 * defaults (Cross-Origin-Resource-Policy same-origin, COEP, a default-src
 * 'self' CSP) would have to be unpicked for the agent surface anyway.
 *
 * Two kinds of response:
 *  - The agent surface — the script at /agent/v1/<key>/guides.js and the API
 *    under /v1/agent/<key>/ — is loaded and called from customers' own
 *    origins. It only gets nosniff (a script or JSON body must never be
 *    sniffed into HTML); nothing that could interfere with cross-origin use.
 *    Its CORS and caching headers are set by the agent routers themselves.
 *  - Everything else (the Studio API, /auth/config, health, metrics) is ours
 *    and is never a document anyone may frame: deny framing (both the legacy
 *    and the CSP form) and send no referrer.
 *
 * Mounted first, so error responses and 404s carry the headers too.
 */
const AGENT_SURFACE = [/^\/agent\/v1\//, /^\/v1\/agent\//];

/** @internal exported for unit tests */
export function isAgentSurface(path: string): boolean {
  return AGENT_SURFACE.some((pattern) => pattern.test(path));
}

export function securityHeaders(): RequestHandler {
  return (req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    if (!isAgentSurface(req.path)) {
      res.set({
        'Referrer-Policy': 'no-referrer',
        'X-Frame-Options': 'DENY',
        'Content-Security-Policy': "frame-ancestors 'none'",
      });
    }
    next();
  };
}
