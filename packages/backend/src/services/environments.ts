import { PoolClient } from 'pg';
import { HttpError } from '../httpError';

/**
 * Environments and releases (migration 021).
 *
 * An app's environments are its release stages in promotion order (position
 * 1 first); the last one is production. Each owns websites, which is how the
 * agent tells them apart. A guide has at most one live version per
 * environment (guide_release); every change is logged in guide_release_event,
 * which revert walks back. guide.current_version_id mirrors the production
 * release, so "live" elsewhere in the Studio keeps meaning live in production.
 *
 * All of it runs inside the caller's scoped session (Studio or agent): RLS
 * decides what each may read or change; the routes check roles first.
 */

export interface EnvironmentRow {
  id: string;
  name: string;
  position: number;
  websites: string[];
  analyticsEnabled: boolean;
}

const ENVIRONMENT_SELECT = `id, name, position, origins AS websites, analytics_enabled AS "analyticsEnabled"`;

export async function listEnvironments(client: PoolClient, appId: string): Promise<EnvironmentRow[]> {
  const result = await client.query<EnvironmentRow>(
    `SELECT ${ENVIRONMENT_SELECT} FROM app_environment WHERE app_id = $1 ORDER BY position`,
    [appId],
  );
  return result.rows;
}

/** The last stage. Every app has at least one environment (the API never deletes the last). */
export async function productionEnvironmentId(client: PoolClient, appId: string): Promise<string> {
  const result = await client.query<{ id: string }>(
    `SELECT id FROM app_environment WHERE app_id = $1 ORDER BY position DESC LIMIT 1`,
    [appId],
  );
  if (result.rows.length === 0) throw new HttpError(409, 'no_environment');
  return result.rows[0].id;
}

/** The first stage, where a newly published version goes. */
export async function firstEnvironmentId(client: PoolClient, appId: string): Promise<string> {
  const result = await client.query<{ id: string }>(
    `SELECT id FROM app_environment WHERE app_id = $1 ORDER BY position LIMIT 1`,
    [appId],
  );
  if (result.rows.length === 0) throw new HttpError(409, 'no_environment');
  return result.rows[0].id;
}

/** application.allowed_origins (read by the CORS check) = every environment's websites. */
export async function syncAllowedOrigins(client: PoolClient, appId: string): Promise<void> {
  await client.query(
    `UPDATE application SET allowed_origins = COALESCE(
       (SELECT array_agg(DISTINCT o ORDER BY o) FROM app_environment e, unnest(e.origins) AS o WHERE e.app_id = $1),
       '{}')
     WHERE id = $1`,
    [appId],
  );
}

/** A website may belong to one environment of an app only; otherwise a request's environment is ambiguous. */
export async function assertWebsitesFree(
  client: PoolClient,
  appId: string,
  websites: string[],
  exceptEnvironmentId: string | null,
): Promise<void> {
  if (websites.length === 0) return;
  const clash = await client.query<{ name: string; site: string }>(
    `SELECT e.name, o AS site FROM app_environment e, unnest(e.origins) AS o
     WHERE e.app_id = $1 AND o = ANY($2::text[]) AND e.id IS DISTINCT FROM $3::uuid`,
    [appId, websites, exceptEnvironmentId],
  );
  if (clash.rows.length > 0) {
    throw new HttpError(409, 'website_in_use', {
      websites: clash.rows.map((r) => ({ website: r.site, environment: r.name })),
    });
  }
}

/**
 * guide.current_version_id := the production release (or NULL). Run after
 * any release change, and for every guide after the stage order changes.
 */
export async function syncCurrentVersion(client: PoolClient, appId: string, guideId?: string): Promise<void> {
  await client.query(
    `UPDATE guide g SET current_version_id = (
       SELECT r.version_id FROM guide_release r
       WHERE r.guide_id = g.id
         AND r.environment_id = (SELECT id FROM app_environment WHERE app_id = $1 ORDER BY position DESC LIMIT 1))
     WHERE g.app_id = $1 AND ($2::uuid IS NULL OR g.id = $2)`,
    [appId, guideId ?? null],
  );
}

async function environmentOfApp(client: PoolClient, appId: string, environmentId: string): Promise<void> {
  const result = await client.query(`SELECT 1 FROM app_environment WHERE id = $1 AND app_id = $2`, [
    environmentId,
    appId,
  ]);
  if (result.rows.length === 0) throw new HttpError(404, 'not_found');
}

/** Makes `versionId` (a published version of the guide) live in the environment, or withdraws it (null). */
export async function setRelease(
  client: PoolClient,
  input: { appId: string; guideId: string; environmentId: string; versionId: string | null; actor: string },
): Promise<void> {
  const { appId, guideId, environmentId, versionId, actor } = input;
  await environmentOfApp(client, appId, environmentId);
  if (versionId) {
    const published = await client.query(
      `SELECT 1 FROM guide_version WHERE id = $1 AND guide_id = $2 AND published_at IS NOT NULL`,
      [versionId, guideId],
    );
    // Drafts never go live in any environment: what was reviewed is what ships.
    if (published.rows.length === 0) throw new HttpError(400, 'version_not_published');
  }
  await applyRelease(client, appId, guideId, environmentId, versionId, actor);
  await client.query(
    `INSERT INTO guide_release_event (guide_id, environment_id, app_id, version_id, action, actor)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [guideId, environmentId, appId, versionId, versionId ? 'release' : 'withdraw', actor],
  );
  await client.query(`UPDATE guide SET status = 'published', updated_at = now() WHERE id = $1 AND $2::uuid IS NOT NULL`, [
    guideId,
    versionId,
  ]);
  await syncCurrentVersion(client, appId, guideId);
}

async function applyRelease(
  client: PoolClient,
  appId: string,
  guideId: string,
  environmentId: string,
  versionId: string | null,
  actor: string,
): Promise<void> {
  if (versionId) {
    await client.query(
      `INSERT INTO guide_release (guide_id, environment_id, app_id, version_id, released_by)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (guide_id, environment_id) DO UPDATE
         SET version_id = EXCLUDED.version_id, released_at = now(), released_by = EXCLUDED.released_by`,
      [guideId, environmentId, appId, versionId, actor],
    );
  } else {
    await client.query(`DELETE FROM guide_release WHERE guide_id = $1 AND environment_id = $2`, [
      guideId,
      environmentId,
    ]);
  }
}

/**
 * Undoes the environment's latest release change: marks it reverted and
 * restores the state recorded below it (a version, or nothing). Repeated
 * reverts keep walking back; a new release starts a new top.
 */
export async function revertRelease(
  client: PoolClient,
  input: { appId: string; guideId: string; environmentId: string; actor: string },
): Promise<{ versionId: string | null }> {
  const { appId, guideId, environmentId, actor } = input;
  await environmentOfApp(client, appId, environmentId);
  const live = await client.query<{ id: string; version_id: string | null }>(
    `SELECT id, version_id FROM guide_release_event
     WHERE guide_id = $1 AND environment_id = $2 AND reverted_at IS NULL
     ORDER BY id DESC LIMIT 2`,
    [guideId, environmentId],
  );
  if (live.rows.length === 0) throw new HttpError(409, 'nothing_to_revert');
  const [latest, below] = live.rows;
  await client.query(`UPDATE guide_release_event SET reverted_at = now(), reverted_by = $2 WHERE id = $1`, [
    latest.id,
    actor,
  ]);
  const restored = below?.version_id ?? null;
  await applyRelease(client, appId, guideId, environmentId, restored, actor);
  await syncCurrentVersion(client, appId, guideId);
  return { versionId: restored };
}

/** Per environment: what is live, and the release log (newest first). */
export async function releasesOf(client: PoolClient, appId: string, guideId: string) {
  const environments = await listEnvironments(client, appId);
  const live = await client.query<{ environment_id: string; version_id: string; version_number: number; released_at: string }>(
    `SELECT r.environment_id, r.version_id, gv.version_number, r.released_at
     FROM guide_release r JOIN guide_version gv ON gv.id = r.version_id
     WHERE r.guide_id = $1`,
    [guideId],
  );
  const log = await client.query<{
    environment_id: string;
    version_number: number | null;
    action: string;
    occurred_at: string;
    reverted_at: string | null;
    actor_name: string | null;
  }>(
    `SELECT e.environment_id, gv.version_number, e.action, e.occurred_at, e.reverted_at,
            COALESCE(u.name, u.email) AS actor_name
     FROM guide_release_event e
     LEFT JOIN guide_version gv ON gv.id = e.version_id
     LEFT JOIN studio_user u ON u.id = e.actor
     WHERE e.guide_id = $1
     ORDER BY e.id DESC
     LIMIT 200`,
    [guideId],
  );
  return environments.map((env) => {
    const current = live.rows.find((r) => r.environment_id === env.id);
    const history = log.rows.filter((r) => r.environment_id === env.id);
    return {
      environmentId: env.id,
      name: env.name,
      position: env.position,
      versionId: current?.version_id ?? null,
      versionNumber: current?.version_number ?? null,
      releasedAt: current?.released_at ?? null,
      canRevert: history.some((h) => !h.reverted_at),
      history: history.map((h) => ({
        action: h.action,
        versionNumber: h.version_number,
        at: h.occurred_at,
        by: h.actor_name,
        reverted: h.reverted_at !== null,
      })),
    };
  });
}

/**
 * The environment an agent request belongs to: the one whose websites
 * contain the page's Origin; without an Origin (not a browser), production.
 * Null when the origin belongs to none (a website removed seconds ago, still
 * in the CORS cache): the caller then serves nothing.
 */
export async function environmentForRequest(
  client: PoolClient,
  appId: string,
  origin: string | undefined,
): Promise<{ id: string; analyticsEnabled: boolean } | null> {
  const result = origin
    ? await client.query<{ id: string; analytics_enabled: boolean }>(
        `SELECT id, analytics_enabled FROM app_environment WHERE app_id = $1 AND $2 = ANY(origins) LIMIT 1`,
        [appId, origin],
      )
    : await client.query<{ id: string; analytics_enabled: boolean }>(
        `SELECT id, analytics_enabled FROM app_environment WHERE app_id = $1 ORDER BY position DESC LIMIT 1`,
        [appId],
      );
  const row = result.rows[0];
  return row ? { id: row.id, analyticsEnabled: row.analytics_enabled } : null;
}

/**
 * The environment an analytics view reads: the one asked for (it must be the
 * app's), or production. Analytics are split per environment and never mixed.
 */
export async function analyticsEnvironmentId(
  client: PoolClient,
  appId: string,
  requested: string | undefined,
): Promise<string> {
  if (!requested) return productionEnvironmentId(client, appId);
  await environmentOfApp(client, appId, requested);
  return requested;
}
