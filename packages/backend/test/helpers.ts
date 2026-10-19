import { Pool } from 'pg';
import { createApp } from '../src/app';

export const app = createApp();

/** Superuser pool for fixtures and raw-row assertions only (bypasses RLS by design). */
export const adminPool = new Pool({ connectionString: process.env.TEST_ADMIN_DATABASE_URL });

export async function resetData(): Promise<void> {
  await adminPool.query(
    `TRUNCATE tenant, tenant_config, guide, guide_version, step, guide_event, user_guide_state RESTART IDENTITY CASCADE`,
  );
  await adminPool.query(`UPDATE system_config SET value = 'true' WHERE key = 'guide_engine_enabled'`);
}

export async function createTenant(name: string): Promise<string> {
  const result = await adminPool.query<{ id: string }>(`INSERT INTO tenant (name) VALUES ($1) RETURNING id`, [
    name,
  ]);
  return result.rows[0].id;
}

/** Seeds a global (is_global) guide — something no tenant API call can create. */
export async function createGlobalGuide(name: string): Promise<string> {
  const result = await adminPool.query<{ id: string }>(
    `INSERT INTO guide (tenant_id, is_global, name, type, created_by) VALUES (NULL, TRUE, $1, 'banner', 'ops')
     RETURNING id`,
    [name],
  );
  return result.rows[0].id;
}

export const sampleStep = {
  order: 0,
  type: 'tooltip' as const,
  targetSelector: '[data-guide-id="invite-button"]',
  content: '<p>Invite your team</p>',
  position: 'bottom',
  actions: [{ label: 'Got it', action: 'complete' }],
};

export const samplePublishBody = {
  steps: [sampleStep],
  routeMatch: { type: 'pattern' as const, value: '/dashboard/*' },
};
