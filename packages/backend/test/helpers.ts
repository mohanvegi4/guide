import { Pool } from 'pg';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createApp } from '../src/app';
import { DEV_TOKEN_ISSUER } from '../src/auth/studio';

export const app = createApp();

/** Superuser pool for fixtures and raw-row assertions only (bypasses RLS by design). */
export const adminPool = new Pool({ connectionString: process.env.TEST_ADMIN_DATABASE_URL });

export const SITE = 'https://app.acme.test';

export async function resetData(): Promise<void> {
  await adminPool.query(
    `TRUNCATE organization, studio_user, guide, guide_version, step, guide_event, user_guide_state, invitation
     RESTART IDENTITY CASCADE`,
  );
  await adminPool.query(`UPDATE system_config SET value = 'true' WHERE key = 'guide_engine_enabled'`);
}

/** A development Studio token for identity `sub` (accepted in NODE_ENV=test). */
export function studioToken(
  sub: string,
  claims: Record<string, unknown> = {},
  options: jwt.SignOptions = {},
): string {
  return jwt.sign({ email: `${sub}@example.com`, name: sub, ...claims }, process.env.JWT_SECRET!, {
    algorithm: 'HS256',
    subject: sub,
    issuer: DEV_TOKEN_ISSUER,
    expiresIn: '5m',
    ...options,
  });
}

export const as = (sub: string) => `Bearer ${studioToken(sub)}`;

export interface OrgSetup {
  orgId: string;
  appId: string;
  key: string;
}

/** Self-serve sign-up through the API: `sub` creates an org with one app on `websites`. */
export async function signUp(sub: string, name = `${sub} org`, websites = [SITE]): Promise<OrgSetup> {
  const res = await request(app)
    .post('/v1/orgs')
    .set('Authorization', as(sub))
    .send({ name, app: { name: `${name} app`, websites } });
  if (res.status !== 201) throw new Error(`signUp failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { orgId: res.body.org.id, appId: res.body.app.id, key: res.body.app.public_key };
}

/** Invites `sub` to the org with a role (manager / editor / viewer), and accepts as them. */
export async function addMember(
  adminSub: string,
  orgId: string,
  sub: string,
  orgRole: 'manager' | 'editor' | 'viewer',
): Promise<void> {
  const inv = await request(app)
    .post(`/v1/orgs/${orgId}/invitations`)
    .set('Authorization', as(adminSub))
    .send({ orgRole });
  if (inv.status !== 201) throw new Error(`invite failed: ${inv.status} ${JSON.stringify(inv.body)}`);
  const acc = await request(app)
    .post(`/v1/invitations/${inv.body.token}/accept`)
    .set('Authorization', as(sub));
  if (acc.status !== 201) throw new Error(`accept failed: ${acc.status} ${JSON.stringify(acc.body)}`);
}

export const sampleStep = {
  order: 0,
  type: 'tooltip' as const,
  targetSelector: '[data-guide-id="invite-button"]',
  content: '<p>Invite your team</p>',
  position: 'bottom',
  actions: [{ label: 'Got it', action: 'complete' }],
};

export const sampleVersion = {
  steps: [sampleStep],
  routeMatch: { type: 'pattern' as const, value: '/dashboard/*' },
};

/** Creates, publishes and enables a guide in `appId` as `sub`. Returns ids. */
export async function liveGuide(
  sub: string,
  appId: string,
  version: Record<string, unknown> = sampleVersion,
): Promise<{ guideId: string; versionId: string }> {
  const g = await request(app)
    .post(`/v1/apps/${appId}/guides`)
    .set('Authorization', as(sub))
    .send({ name: 'G', type: 'tooltip' });
  const v = await request(app)
    .post(`/v1/apps/${appId}/guides/${g.body.id}/publish`)
    .set('Authorization', as(sub))
    .send(version);
  await request(app)
    .patch(`/v1/apps/${appId}/guides/${g.body.id}/flag`)
    .set('Authorization', as(sub))
    .send({ enabled: true });
  return { guideId: g.body.id, versionId: v.body.id };
}

/** An agent call as a browser on `origin` would make it (JSON as text/plain). */
export function agent(key: string, path: string, body: unknown, origin: string | null = SITE) {
  const r = request(app).post(`/v1/agent/${key}${path}`).set('Content-Type', 'text/plain');
  if (origin) r.set('Origin', origin);
  return r.send(JSON.stringify(body));
}

export const visitor = (id = 'v-1', account: string | null = 'acme') => ({
  visitor: { id },
  ...(account ? { account: { id: account } } : {}),
});

export async function closePools(): Promise<void> {
  const { pool } = await import('../src/db');
  await pool.end();
  await adminPool.end();
}
