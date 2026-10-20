import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import {
  addMember,
  adminPool,
  agent,
  app,
  as,
  closePools,
  liveGuide,
  resetData,
  sampleStep,
  sampleVersion,
  signUp,
  visitor,
} from './helpers';

afterAll(closePools);
beforeEach(resetData);

const help = {
  title: 'Invite a teammate',
  description: 'Add people to your workspace',
  keywords: ['Team', 'invite', 'members'],
};

describe('help center', () => {
  it('lists only guides opted into the help center, with their help metadata and steps', async () => {
    const { key, appId } = await signUp('alice');
    const listed = await liveGuide('alice', appId, {
      ...sampleVersion,
      routeMatch: { type: 'exact', value: '/team' },
      help,
    });
    await liveGuide('alice', appId); // not in the help center

    const res = await agent(key, '/help', visitor());
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      enabled: true,
      button: { label: 'Help', color: '#4f46e5', position: 'bottom-right' },
      guides: [
        {
          id: listed.guideId,
          versionId: listed.versionId,
          routeMatch: { type: 'exact', value: '/team' },
          // keywords normalized to lower case, deduplicated; start page defaults to the exact route
          help: {
            title: 'Invite a teammate',
            description: 'Add people to your workspace',
            keywords: ['team', 'invite', 'members'],
            startPath: '/team',
          },
        },
      ],
    });
    expect(res.body.guides[0].steps[0].content).toBe(sampleStep.content);
  });

  it('keeps finished guides listed (help is on demand), unlike automatic guides', async () => {
    const { key, appId } = await signUp('alice');
    const g = await liveGuide('alice', appId, {
      ...sampleVersion,
      routeMatch: { type: 'exact', value: '/team' },
      help,
    });
    await agent(key, '/events', {
      ...visitor('v1'),
      events: [
        {
          guideId: g.guideId,
          guideVersionId: g.versionId,
          sessionId: 's',
          eventType: 'guide_completed',
          occurredAt: new Date().toISOString(),
        },
      ],
    });
    expect((await agent(key, '/guides', visitor('v1'))).body.guides).toEqual([]);
    expect((await agent(key, '/help', visitor('v1'))).body.guides).toHaveLength(1);
  });

  it('applies the account allowlist and the guide/app switches', async () => {
    const { key, appId } = await signUp('alice');
    const g = await liveGuide('alice', appId, {
      ...sampleVersion,
      routeMatch: { type: 'exact', value: '/t' },
      help,
      accountIds: ['acme'],
    });
    expect((await agent(key, '/help', visitor('v', 'acme'))).body.guides).toHaveLength(1);
    expect((await agent(key, '/help', visitor('v', 'globex'))).body.guides).toHaveLength(0);

    await request(app)
      .patch(`/v1/apps/${appId}/guides/${g.guideId}/flag`)
      .set('Authorization', as('alice'))
      .send({ enabled: false });
    expect((await agent(key, '/help', visitor('v', 'acme'))).body.guides).toHaveLength(0);

    await request(app)
      .patch(`/v1/apps/${appId}`)
      .set('Authorization', as('alice'))
      .send({ helpEnabled: false });
    expect((await agent(key, '/help', visitor('v', 'acme'))).body).toEqual({ enabled: false, guides: [] });
  });

  it('requires a start page for wildcard routes, and only same-site paths', async () => {
    const { appId } = await signUp('alice');
    const g = (
      await request(app)
        .post(`/v1/apps/${appId}/guides`)
        .set('Authorization', as('alice'))
        .send({ name: 'G', type: 'tour' })
    ).body.id;
    const draft = (body: object) =>
      request(app)
        .put(`/v1/apps/${appId}/guides/${g}/draft`)
        .set('Authorization', as('alice'))
        .send({ ...sampleVersion, ...body });

    expect((await draft({ help })).status).toBe(400); // sampleVersion's route is '/dashboard/*'
    expect((await draft({ help: { ...help, startPath: '//evil.example' } })).status).toBe(400);
    expect((await draft({ help: { ...help, startPath: 'https://evil.example' } })).status).toBe(400);
    const ok = await draft({ help: { ...help, startPath: '/dashboard/overview' } });
    expect(ok.status).toBe(200);
    expect(ok.body.help).toMatchObject({ startPath: '/dashboard/overview' });
  });

  it('stores help text as plain text', async () => {
    const { appId } = await signUp('alice');
    const g = (
      await request(app)
        .post(`/v1/apps/${appId}/guides`)
        .set('Authorization', as('alice'))
        .send({ name: 'G', type: 'tour' })
    ).body.id;
    const res = await request(app)
      .put(`/v1/apps/${appId}/guides/${g}/draft`)
      .set('Authorization', as('alice'))
      .send({
        ...sampleVersion,
        routeMatch: { type: 'exact', value: '/x' },
        help: {
          title: '<b>Team</b><script>x()</script>',
          description: '<img src=x onerror=alert(1)>Add people',
          keywords: [],
        },
      });
    expect(res.body.help).toMatchObject({ title: 'Team', description: 'Add people' });
  });

  it('validates the button settings', async () => {
    const { appId } = await signUp('alice');
    const patch = (body: object) =>
      request(app).patch(`/v1/apps/${appId}`).set('Authorization', as('alice')).send(body);
    expect((await patch({ helpButtonColor: 'red; background:url(x)' })).status).toBe(400);
    expect((await patch({ helpPosition: 'middle' })).status).toBe(400);
    const ok = await patch({
      helpButtonColor: '#0EA5E9',
      helpButtonLabel: 'Need help?',
      helpPosition: 'top-left',
    });
    expect(ok.body).toMatchObject({
      help_button_color: '#0EA5E9',
      help_button_label: 'Need help?',
      help_enabled: true,
      help_position: 'top-left',
    });
  });

  it('serves the placement to the agent', async () => {
    const { key, appId } = await signUp('alice');
    await liveGuide('alice', appId, { ...sampleVersion, routeMatch: { type: 'exact', value: '/t' }, help });
    await request(app)
      .patch(`/v1/apps/${appId}`)
      .set('Authorization', as('alice'))
      .send({ helpPosition: 'center' });
    expect((await agent(key, '/help', visitor())).body.button).toEqual({
      label: 'Help',
      color: '#4f46e5',
      position: 'center',
    });
  });

  it('counts guides started from the help center', async () => {
    const { key, appId } = await signUp('alice');
    const g = await liveGuide('alice', appId, {
      ...sampleVersion,
      routeMatch: { type: 'exact', value: '/t' },
      help,
    });
    const ev = (metadata?: object) => ({
      guideId: g.guideId,
      guideVersionId: g.versionId,
      sessionId: 's',
      eventType: 'guide_shown',
      occurredAt: new Date().toISOString(),
      ...(metadata ? { metadata } : {}),
    });
    await agent(key, '/events', {
      ...visitor(),
      events: [ev({ source: 'help' }), ev({ source: 'help' }), ev()],
    });
    const stats = await request(app)
      .get(`/v1/apps/${appId}/guides/${g.guideId}/analytics`)
      .set('Authorization', as('alice'));
    expect(stats.body.startedFromHelp).toBe(2);
  });

  it('tells the agent how the app routes (path by default, or hash)', async () => {
    const { key, appId } = await signUp('alice');
    expect((await agent(key, '/guides', visitor())).body.routeMode).toBe('path');
    expect((await agent(key, '/help', visitor())).body.routeMode).toBe('path');
    await request(app)
      .patch(`/v1/apps/${appId}`)
      .set('Authorization', as('alice'))
      .send({ routeMode: 'hash' });
    expect((await agent(key, '/guides', visitor())).body).toMatchObject({ enabled: true, routeMode: 'hash' });
    expect((await agent(key, '/help', visitor())).body).toMatchObject({ enabled: true, routeMode: 'hash' });
  });

  it('includes the help methods in the install snippet stub', async () => {
    const { appId } = await signUp('alice');
    const res = await request(app).get(`/v1/apps/${appId}`).set('Authorization', as('alice'));
    expect(res.body.snippet).toContain("'openHelp','closeHelp','toggleHelp'");
  });
});

describe('help-center analytics', () => {
  const at = new Date().toISOString();
  const opened = (sessionId = 's') => ({ sessionId, eventType: 'help_opened', occurredAt: at });
  const searched = (query: string, results: number, sessionId = 's') => ({
    sessionId,
    eventType: 'help_searched',
    occurredAt: at,
    metadata: { query, results },
  });

  it('accepts help events without a guide, alongside guide events', async () => {
    const { key, appId } = await signUp('alice');
    const g = await liveGuide('alice', appId, {
      ...sampleVersion,
      routeMatch: { type: 'exact', value: '/t' },
      help,
    });
    const res = await agent(key, '/events', {
      ...visitor('v-1'),
      events: [
        opened(),
        searched('Invite', 1),
        {
          guideId: g.guideId,
          guideVersionId: g.versionId,
          sessionId: 's',
          eventType: 'guide_shown',
          occurredAt: at,
          metadata: { source: 'help' },
        },
      ],
    });
    expect(res.status).toBe(202);
    expect(res.body.accepted).toBe(3);
    const rows = await adminPool.query(
      `SELECT event_type::text, guide_id, guide_version_id, visitor_id, metadata FROM guide_event ORDER BY id`,
    );
    expect(rows.rows).toEqual([
      { event_type: 'help_opened', guide_id: null, guide_version_id: null, visitor_id: 'v-1', metadata: {} },
      {
        event_type: 'help_searched',
        guide_id: null,
        guide_version_id: null,
        visitor_id: 'v-1',
        metadata: { query: 'Invite', results: 1 },
      },
      {
        event_type: 'guide_shown',
        guide_id: g.guideId,
        guide_version_id: g.versionId,
        visitor_id: 'v-1',
        metadata: { source: 'help' },
      },
    ]);
  });

  it('caps the stored query at 200 characters and keeps only query and results', async () => {
    const { key } = await signUp('alice');
    const res = await agent(key, '/events', {
      ...visitor(),
      events: [
        { ...searched('x'.repeat(500), 0), metadata: { query: 'x'.repeat(500), results: 0, extra: 1 } },
      ],
    });
    expect(res.status).toBe(202);
    const row = (await adminPool.query(`SELECT metadata FROM guide_event`)).rows[0];
    expect(row.metadata).toEqual({ query: 'x'.repeat(200), results: 0 });
  });

  it('stores a help event without a guide even if one was named, and rejects a guide event without one', async () => {
    const { key, appId } = await signUp('alice');
    const g = await liveGuide('alice', appId);
    const mixed = await agent(key, '/events', {
      ...visitor(),
      events: [{ ...opened(), guideId: g.guideId, guideVersionId: g.versionId }],
    });
    // Stray guide ids on a help event are dropped (the event is about the panel, not a guide).
    expect(mixed.status).toBe(202);
    expect((await adminPool.query(`SELECT guide_id FROM guide_event`)).rows).toEqual([{ guide_id: null }]);
    const orphan = await agent(key, '/events', {
      ...visitor(),
      events: [{ sessionId: 's', eventType: 'guide_shown', occurredAt: at }],
    });
    expect(orphan.status).toBe(400);
    // The database refuses the combination too, whatever the API does.
    await expect(
      adminPool.query(
        `INSERT INTO guide_event (app_id, guide_id, visitor_id, session_id, event_type)
         VALUES ($1, $2, 'v', 's', 'help_opened')`,
        [appId, g.guideId],
      ),
    ).rejects.toThrow(/chk_help_event_has_no_guide/);
    await expect(
      adminPool.query(
        `INSERT INTO guide_event (app_id, guide_id, visitor_id, session_id, event_type)
         VALUES ($1, NULL, 'v', 's', 'guide_shown')`,
        [appId],
      ),
    ).rejects.toThrow(/chk_help_event_has_no_guide/);
  });

  it('reports opens, searches, top queries and guides started from help for the last 30 days', async () => {
    const { key, appId, orgId } = await signUp('alice');
    const g = await liveGuide('alice', appId, {
      ...sampleVersion,
      routeMatch: { type: 'exact', value: '/t' },
      help,
    });
    const shown = (metadata?: object) => ({
      guideId: g.guideId,
      guideVersionId: g.versionId,
      sessionId: 's',
      eventType: 'guide_shown',
      occurredAt: at,
      ...(metadata ? { metadata } : {}),
    });
    await agent(key, '/events', {
      ...visitor('v-1'),
      events: [
        opened(),
        opened('s2'),
        searched('Invite', 2),
        searched('invite ', 0),
        searched('export', 1),
        searched('   ', 0), // blank: counted as a search, never listed
        shown({ source: 'help' }),
        shown(),
      ],
    });
    // An old open falls outside the window.
    await adminPool.query(
      `INSERT INTO guide_event (app_id, visitor_id, session_id, event_type, occurred_at)
       VALUES ($1, 'v', 's', 'help_opened', now() - interval '31 days')`,
      [appId],
    );

    const res = await request(app).get(`/v1/apps/${appId}/help-analytics`).set('Authorization', as('alice'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      days: 30,
      opens: 2,
      searches: 4,
      guidesStarted: 1,
      topQueries: [
        { query: 'invite', count: 2, avgResults: 1 },
        { query: 'export', count: 1, avgResults: 1 },
      ],
    });

    // Viewers may read it; another org's app answers 404.
    await addMember('alice', orgId, 'vic', 'viewer');
    expect(
      (await request(app).get(`/v1/apps/${appId}/help-analytics`).set('Authorization', as('vic'))).status,
    ).toBe(200);
    const other = await signUp('zed');
    expect(
      (await request(app).get(`/v1/apps/${appId}/help-analytics`).set('Authorization', as('zed'))).status,
    ).toBe(404);
    expect(
      (await request(app).get(`/v1/apps/${other.appId}/help-analytics`).set('Authorization', as('alice')))
        .status,
    ).toBe(404);
  });
});
