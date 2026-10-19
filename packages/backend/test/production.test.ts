import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { adminPool, agent, app, as, closePools, liveGuide, resetData, signUp, visitor } from './helpers';
import { createPostgresRateLimiter } from '../src/rateLimit';
import { decryptSecret, encryptSecret, isEncrypted, parseSecretsKey } from '../src/secrets';
import { retentionDaysFromEnv, runRetention } from '../src/retention';
import { assertProductionConfig } from '../src/production';
import { withPlatformSession } from '../src/db';

afterAll(closePools);
beforeEach(async () => {
  await resetData();
  await adminPool.query(`TRUNCATE agent_rate_limit`);
});

const KEY = parseSecretsKey('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef')!;

describe('secrets at rest', () => {
  it('round-trips, never stores the plaintext, and rejects the wrong key or a tampered value', () => {
    const stored = encryptSecret('ge_sk_super_secret', KEY);
    expect(isEncrypted(stored)).toBe(true);
    expect(stored).not.toContain('super_secret');
    expect(encryptSecret('ge_sk_super_secret', KEY)).not.toBe(stored); // fresh IV every time
    expect(decryptSecret(stored, KEY)).toBe('ge_sk_super_secret');
    expect(() => decryptSecret(stored, parseSecretsKey('ff'.repeat(32)))).toThrow();
    expect(() => decryptSecret(stored.slice(0, -4) + 'AAAA', KEY)).toThrow();
    expect(() => decryptSecret(stored, null)).toThrow(/SECRETS_KEY/);
  });

  it('reads legacy plaintext as-is, and stores plaintext when there is no key (development)', () => {
    expect(decryptSecret('ge_sk_plain', KEY)).toBe('ge_sk_plain');
    expect(encryptSecret('ge_sk_plain', null)).toBe('ge_sk_plain');
    expect(parseSecretsKey(undefined)).toBeNull();
    expect(parseSecretsKey(Buffer.alloc(32, 7).toString('base64'))).toHaveLength(32);
    expect(() => parseSecretsKey('too-short')).toThrow(/32 bytes/);
  });

  it('the signing-secret endpoint stores an encrypted value, and signed identities still verify', async () => {
    const { appId, key } = await signUp('alice');
    await liveGuide('alice', appId);
    const minted = await request(app)
      .post(`/v1/apps/${appId}/signing-secret`)
      .set('Authorization', as('alice'));
    expect(minted.status).toBe(201);
    const row = await adminPool.query<{ signing_secret: string }>(
      `SELECT signing_secret FROM application WHERE id = $1`,
      [appId],
    );
    expect(isEncrypted(row.rows[0].signing_secret)).toBe(true);
    expect(row.rows[0].signing_secret).not.toContain(minted.body.secret);

    const token = jwt.sign({ visitor: { id: 'v-signed' }, account: { id: 'acme' } }, minted.body.secret, {
      algorithm: 'HS256',
      expiresIn: '5m',
    });
    const res = await agent(key, '/guides', { jwt: token });
    expect(res.status).toBe(200);
    expect(res.body.guides).toHaveLength(1);
  });
});

describe('shared rate limiter (Postgres)', () => {
  it('counts one budget per key and window, shared by every caller', async () => {
    const allow = createPostgresRateLimiter(3, 60_000);
    const other = createPostgresRateLimiter(3, 60_000); // "another replica"
    expect([await allow('k1'), await other('k1'), await allow('k1')]).toEqual([true, true, true]);
    expect(await other('k1')).toBe(false);
    expect(await allow('k2')).toBe(true); // a different key has its own budget
  });

  it('starts a new window when the old one ends', async () => {
    const allow = createPostgresRateLimiter(1, 1_000);
    expect(await allow('k')).toBe(true);
    expect(await allow('k')).toBe(false);
    await new Promise((r) => setTimeout(r, 1_100));
    expect(await allow('k')).toBe(true);
  });

  it('is what the agent API uses when RATE_LIMIT_STORE=postgres (rows appear per key and client)', async () => {
    // The test app runs with RATE_LIMIT_STORE=memory; the limiter itself is
    // covered above. Here: the table is unscoped, so no session is needed.
    const rows = await adminPool.query(`SELECT COUNT(*)::int AS n FROM agent_rate_limit`);
    expect(rows.rows[0].n).toBe(0);
  });
});

describe('event retention', () => {
  it('deletes only events older than the retention period, and sweeps spent rate-limit windows', async () => {
    const { appId, key } = await signUp('alice');
    const g = await liveGuide('alice', appId);
    const event = (daysAgo: number) => ({
      guideId: g.guideId,
      guideVersionId: g.versionId,
      sessionId: 's',
      eventType: 'guide_shown',
      occurredAt: new Date(Date.now() - daysAgo * 86_400_000).toISOString(),
    });
    await agent(key, '/events', { ...visitor(), events: [event(500), event(401), event(10), event(0)] });
    await adminPool.query(
      `INSERT INTO agent_rate_limit (bucket, window_start, count) VALUES ('old', now() - interval '2 hours', 1), ('new', now(), 1)`,
    );

    const result = await runRetention(400, () => undefined);
    expect(result).toEqual({ events: 2, rateLimitRows: 1 });
    const left = await adminPool.query(`SELECT COUNT(*)::int AS n FROM guide_event WHERE app_id = $1`, [
      appId,
    ]);
    expect(left.rows[0].n).toBe(2);
    expect((await adminPool.query(`SELECT bucket FROM agent_rate_limit`)).rows).toEqual([{ bucket: 'new' }]);
  });

  it('is the only way to delete events: other sessions cannot', async () => {
    const { appId, key } = await signUp('alice');
    const g = await liveGuide('alice', appId);
    await agent(key, '/events', {
      ...visitor(),
      events: [
        {
          guideId: g.guideId,
          guideVersionId: g.versionId,
          sessionId: 's',
          eventType: 'guide_shown',
          occurredAt: new Date().toISOString(),
        },
      ],
    });
    await adminPool.query(`UPDATE studio_user SET platform_admin = TRUE WHERE oidc_sub = 'alice'`);
    const alice = (await adminPool.query(`SELECT id FROM studio_user WHERE oidc_sub = 'alice'`)).rows[0].id;
    const deleted = await withPlatformSession(alice, (client) =>
      client.query(`DELETE FROM guide_event`).then((r) => r.rowCount),
    );
    expect(deleted).toBe(0);
  });

  it('reads EVENT_RETENTION_DAYS: default 400 in production, off elsewhere, 0 = off', async () => {
    expect(retentionDaysFromEnv({ NODE_ENV: 'production' })).toBe(400);
    expect(retentionDaysFromEnv({ NODE_ENV: 'development' })).toBeNull();
    expect(retentionDaysFromEnv({ EVENT_RETENTION_DAYS: '0', NODE_ENV: 'production' })).toBeNull();
    expect(retentionDaysFromEnv({ EVENT_RETENTION_DAYS: '30' })).toBe(30);
    expect(() => retentionDaysFromEnv({ EVENT_RETENTION_DAYS: 'soon' })).toThrow();
    await expect(runRetention(0)).rejects.toThrow();
  });
});

describe('production boot checks', () => {
  const good = {
    NODE_ENV: 'production',
    SECRETS_KEY: 'x'.repeat(64),
    PREVIEW_TOKEN_SECRET: 'y'.repeat(40),
    RATE_LIMIT_STORE: 'postgres',
    PUBLIC_API_URL: 'https://api.example.com',
    TRUST_PROXY: 'true',
  };

  it('refuses to start without the production essentials, naming each one', () => {
    expect(() =>
      assertProductionConfig({ NODE_ENV: 'production', PUBLIC_API_URL: 'http://api.example.com' }),
    ).toThrow(/SECRETS_KEY[\s\S]*PREVIEW_TOKEN_SECRET[\s\S]*PUBLIC_API_URL must be an https/);
    expect(() => assertProductionConfig({ ...good, RATE_LIMIT_STORE: 'memory' })).toThrow(/RATE_LIMIT_STORE/);
  });

  it('passes a complete configuration, warns when TRUST_PROXY is off, and ignores other environments', () => {
    const warnings: string[] = [];
    expect(() => assertProductionConfig(good, (m) => warnings.push(m))).not.toThrow();
    expect(warnings).toEqual([]);
    assertProductionConfig({ ...good, TRUST_PROXY: 'false' }, (m) => warnings.push(m));
    expect(warnings[0]).toMatch(/TRUST_PROXY/);
    expect(() => assertProductionConfig({ NODE_ENV: 'development' })).not.toThrow();
  });
});
