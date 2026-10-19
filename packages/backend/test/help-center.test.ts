import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import {
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
    const ok = await patch({ helpButtonColor: '#0EA5E9', helpButtonLabel: 'Need help?', helpPosition: 'top-left' });
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

  it('includes the help methods in the install snippet stub', async () => {
    const { appId } = await signUp('alice');
    const res = await request(app).get(`/v1/apps/${appId}`).set('Authorization', as('alice'));
    expect(res.body.snippet).toContain("'openHelp','closeHelp','toggleHelp'");
  });
});
