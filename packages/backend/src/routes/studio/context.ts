import { Request } from 'express';
import { PoolClient } from 'pg';
import { z } from 'zod';
import { AppRole, OrgRole, StudioContext, appRoleAtLeast, withStudioSession } from '../../db';
import { HttpError, forbidden, notFound } from '../../httpError';
import { StudioRequest } from '../../auth/studio';

/** Runs `fn` in a database session scoped to the signed-in Studio user's memberships. */
export function studio<T>(
  req: Request,
  fn: (client: PoolClient, ctx: StudioContext) => Promise<T>,
): Promise<T> {
  const user = (req as StudioRequest).studioUser;
  if (!user) throw new HttpError(401, 'missing_auth');
  return withStudioSession(user.id, fn);
}

const ORG_RANK: Record<OrgRole, number> = { member: 0, admin: 1, owner: 2 };

/** Not a member -> 404 (no probing); member without the role -> 403. */
export function requireOrgRole(ctx: StudioContext, orgId: string, min: OrgRole): OrgRole {
  const role = ctx.orgs.get(orgId);
  if (!role) throw notFound();
  if (ORG_RANK[role] < ORG_RANK[min]) throw forbidden();
  return role;
}

/** No access to the app -> 404; access without the role -> 403. */
export function requireAppRole(
  ctx: StudioContext,
  appId: string,
  min: AppRole,
): { orgId: string; role: AppRole } {
  const app = ctx.apps.get(appId);
  if (!app) throw notFound();
  if (!appRoleAtLeast(app.role, min)) throw forbidden();
  return app;
}

const uuid = z.string().uuid();

/** Parses a uuid path parameter; anything else is a 404 rather than a database cast error. */
export function idParam(req: Request, name: string): string {
  const parsed = uuid.safeParse(req.params[name]);
  if (!parsed.success) throw notFound();
  return parsed.data;
}

/** Validates a body with zod, or throws a 400 with field errors. */
export function parseBody<S extends z.ZodTypeAny>(schema: S, body: unknown): z.infer<S> {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new HttpError(400, 'invalid_body', parsed.error.flatten());
  return parsed.data;
}

/** Same-site path only (no scheme, no "//host"): help start pages, saved-page start pages. */
export const sitePathSchema = z
  .string()
  .trim()
  .max(2000)
  .regex(/^\/(?!\/)/, 'must be a path on your site, e.g. /settings/team');

/** A guide's or saved page's URL rule: an exact path, or a pattern where * matches anything. */
export const routeMatchSchema = z.object({
  type: z.enum(['exact', 'pattern']),
  value: z.string().trim().max(2000).startsWith('/'),
});

/**
 * SQL for a version's effective route: the saved page's URL when the version
 * references one (so live guides follow page edits), else its own
 * route_match. Expects `gv` (guide_version) and `p` (LEFT JOIN app_page ON
 * p.id = gv.page_id) in the FROM clause. Mirrors the active_guide view
 * (migration 007); every query that serves a route must use one of the two.
 */
export const RESOLVED_ROUTE_MATCH_SQL = `CASE WHEN p.id IS NOT NULL
  THEN jsonb_build_object('type', p.match_type::text, 'value', p.match_value)
  ELSE gv.route_match END`;

/**
 * Websites allowed to run an app's agent, normalized to bare origins
 * ("https://app.example.com"). Paths are dropped: CORS compares origins only.
 */
export const websitesSchema = z
  .array(
    z
      .string()
      .trim()
      .url()
      .refine((u) => /^https?:$/.test(new URL(u).protocol), 'must be an http(s) URL')
      .transform((u) => new URL(u).origin),
  )
  .max(20)
  .transform((origins) => [...new Set(origins)]);
