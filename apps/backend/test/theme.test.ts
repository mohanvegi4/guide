import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { clearAgentCacheForTests } from '../src/routes/agent';
import { addMember, agent, app, as, closePools, liveGuide, resetData, signUp, visitor } from './helpers';

afterAll(closePools);

let orgId: string;
let appId: string;
let key: string;

beforeEach(async () => {
  await resetData();
  ({ orgId, appId, key } = await signUp('owner'));
  clearAgentCacheForTests();
});

const patch = (body: object, sub = 'owner') =>
  request(app).patch(`/v1/apps/${appId}`).set('Authorization', as(sub)).send(body);

describe('matching the website theme', () => {
  it('is on for a new app, and editors can switch it', async () => {
    const created = await request(app).get(`/v1/apps/${appId}`).set('Authorization', as('owner'));
    expect(created.body.match_site_theme).toBe(true);

    await addMember('owner', orgId, 'editor', 'editor');
    const off = await patch({ matchSiteTheme: false, helpButtonColor: '#236192' }, 'editor');
    expect(off.status).toBe(200);
    expect(off.body).toMatchObject({ match_site_theme: false, help_button_color: '#236192' });
    expect((await patch({ matchSiteTheme: 'yes' })).status).toBe(400);
  });

  it('reaches the agent with /guides, /help and /preview, so cards, the help center and previews agree', async () => {
    const { guideId, versionId } = await liveGuide('owner', appId, {
      steps: [{ order: 0, content: '<p>Hi</p>', actions: [] }],
      routeMatch: { type: 'exact', value: '/' },
      help: { title: 'Hi' },
    });
    const expected = { color: '#4f46e5', matchSite: true };
    expect((await agent(key, '/guides', visitor())).body.theme).toEqual(expected);
    expect((await agent(key, '/help', visitor())).body.theme).toEqual(expected);

    const minted = await request(app)
      .post(`/v1/apps/${appId}/guides/${guideId}/preview-token`)
      .set('Authorization', as('owner'))
      .send({ versionId });
    expect((await agent(key, '/preview', { token: minted.body.token })).body.theme).toEqual(expected);

    await patch({ matchSiteTheme: false });
    expect((await agent(key, '/guides', visitor())).body.theme).toEqual({ color: '#4f46e5', matchSite: false });
  });
});
