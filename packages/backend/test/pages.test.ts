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
  signUp,
  visitor,
} from './helpers';
import { withAgentSession, withStudioSession } from '../src/db';

afterAll(closePools);
beforeEach(resetData);

const teamPage = { name: 'Team settings', routeMatch: { type: 'exact', value: '/settings/team' } };

async function createPage(sub: string, appId: string, body: Record<string, unknown> = teamPage) {
  const res = await request(app).post(`/v1/apps/${appId}/pages`).set('Authorization', as(sub)).send(body);
  if (res.status !== 201) throw new Error(`createPage failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as { id: string };
}

const onPage = (pageId: string, extra: Record<string, unknown> = {}) => ({
  steps: [sampleStep],
  pageId,
  ...extra,
});

function updatePage(sub: string, appId: string, pageId: string, body: Record<string, unknown>) {
  return request(app).put(`/v1/apps/${appId}/pages/${pageId}`).set('Authorization', as(sub)).send(body);
}

describe('saved pages', () => {
  it('creates, lists (by name) and reads pages', async () => {
    const { appId } = await signUp('alice');
    await createPage('alice', appId);
    const projects = await createPage('alice', appId, {
      name: 'Any project',
      routeMatch: { type: 'pattern', value: '/projects/*' },
      startPath: '/projects',
    });

    const list = await request(app).get(`/v1/apps/${appId}/pages`).set('Authorization', as('alice'));
    expect(list.status).toBe(200);
    expect(list.body.map((p: { name: string }) => p.name)).toEqual(['Any project', 'Team settings']);
    expect(list.body[0]).toMatchObject({
      id: projects.id,
      routeMatch: { type: 'pattern', value: '/projects/*' },
      startPath: '/projects',
      usage: { guides: 0, live: 0 },
    });

    const one = await request(app)
      .get(`/v1/apps/${appId}/pages/${projects.id}`)
      .set('Authorization', as('alice'));
    expect(one.body).toMatchObject({ name: 'Any project', guides: [] });
  });

  it('validates pages: patterns need a start page, paths stay on-site, names are unique per app', async () => {
    const { appId } = await signUp('alice');
    const post = (body: object) =>
      request(app).post(`/v1/apps/${appId}/pages`).set('Authorization', as('alice')).send(body);

    expect((await post({ name: 'P', routeMatch: { type: 'pattern', value: '/p/*' } })).status).toBe(400);
    expect((await post({ name: 'P', routeMatch: { type: 'exact', value: 'p' } })).status).toBe(400);
    expect(
      (await post({ name: 'P', routeMatch: { type: 'exact', value: '/p' }, startPath: '//evil.example' }))
        .status,
    ).toBe(400);
    expect((await post({ name: '<b></b>', routeMatch: { type: 'exact', value: '/p' } })).body.error).toBe(
      'empty_content_after_sanitize',
    );

    await createPage('alice', appId);
    const dup = await post({ ...teamPage, name: 'team SETTINGS' });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toBe('page_name_taken');

    // Same name in another app is fine.
    const other = await request(app)
      .post(`/v1/orgs/${(await signUp('bob')).orgId}/apps`)
      .set('Authorization', as('bob'))
      .send({ name: 'Second', websites: [] });
    expect(other.status).toBe(201);
    await createPage('bob', other.body.id);
  });

  it('serves guides on a page with the page URL, and live guides follow page edits without a republish', async () => {
    const { key, appId } = await signUp('alice');
    const page = await createPage('alice', appId);
    const g = await liveGuide('alice', appId, onPage(page.id));

    let guides = (await agent(key, '/guides', visitor())).body.guides;
    expect(guides).toMatchObject([{ id: g.guideId, routeMatch: { type: 'exact', value: '/settings/team' } }]);

    const res = await updatePage('alice', appId, page.id, {
      name: 'Team settings',
      routeMatch: { type: 'pattern', value: '/org/*/team' },
      startPath: '/org/default/team',
    });
    expect(res.status).toBe(200);
    expect(res.body.guides).toEqual([{ id: g.guideId, name: 'G', live: true, draft: false }]);

    guides = (await agent(key, '/guides', visitor())).body.guides;
    expect(guides).toMatchObject([
      { versionId: g.versionId, routeMatch: { type: 'pattern', value: '/org/*/team' } },
    ]);
  });

  it('versions keep the page reference and a snapshot of its route', async () => {
    const { appId } = await signUp('alice');
    const page = await createPage('alice', appId);
    const g = await liveGuide('alice', appId, onPage(page.id));
    const detail = await request(app)
      .get(`/v1/apps/${appId}/guides/${g.guideId}`)
      .set('Authorization', as('alice'));
    expect(detail.body.versions[0]).toMatchObject({
      page_id: page.id,
      route_match: { type: 'exact', value: '/settings/team' },
    });
    const list = await request(app).get(`/v1/apps/${appId}/guides`).set('Authorization', as('alice'));
    expect(list.body[0]).toMatchObject({ page_id: page.id, page_name: 'Team settings' });
  });

  it('requires exactly one of a saved page or a custom route, and only this app’s pages', async () => {
    const { appId } = await signUp('alice');
    const page = await createPage('alice', appId);
    const bob = await signUp('bob');
    const bobsPage = await createPage('bob', bob.appId);
    const g = await request(app)
      .post(`/v1/apps/${appId}/guides`)
      .set('Authorization', as('alice'))
      .send({ name: 'G', type: 'tooltip' });
    const draft = (body: object) =>
      request(app)
        .put(`/v1/apps/${appId}/guides/${g.body.id}/draft`)
        .set('Authorization', as('alice'))
        .send(body);

    expect((await draft({ steps: [sampleStep] })).status).toBe(400);
    expect((await draft({ ...onPage(page.id), routeMatch: { type: 'exact', value: '/x' } })).status).toBe(
      400,
    );
    const foreign = await draft(onPage(bobsPage.id));
    expect(foreign.status).toBe(400);
    expect(foreign.body.error).toBe('unknown_page');
    expect((await draft(onPage(page.id))).body).toMatchObject({ pageId: page.id });
    // Switching back to a custom route clears the page.
    const custom = await draft({ steps: [sampleStep], routeMatch: { type: 'exact', value: '/x' } });
    expect(custom.body).toMatchObject({ pageId: null, routeMatch: { type: 'exact', value: '/x' } });
  });

  it('help center: guides on a pattern page need no start page of their own (the page’s is used)', async () => {
    const { key, appId } = await signUp('alice');
    const page = await createPage('alice', appId, {
      name: 'Any project',
      routeMatch: { type: 'pattern', value: '/projects/*' },
      startPath: '/projects/demo',
    });
    await liveGuide('alice', appId, onPage(page.id, { help: { title: 'Open a project' } }));
    await liveGuide(
      'alice',
      appId,
      onPage(page.id, { help: { title: 'Share a project', startPath: '/projects/shared' } }),
    );

    const help = (await agent(key, '/help', visitor())).body.guides;
    expect(
      help.map((h: { help: { title: string; startPath: string } }) => [h.help.title, h.help.startPath]),
    ).toEqual([
      ['Open a project', '/projects/demo'],
      ['Share a project', '/projects/shared'], // the guide's own start page wins
    ]);

    // Moving the page moves the default start page too.
    await updatePage('alice', appId, page.id, {
      name: 'Any project',
      routeMatch: { type: 'pattern', value: '/p/*' },
      startPath: '/p/demo',
    });
    expect((await agent(key, '/help', visitor())).body.guides[0].help.startPath).toBe('/p/demo');
  });

  it('preview links open on the page’s current URL', async () => {
    const { appId } = await signUp('alice');
    const page = await createPage('alice', appId);
    const g = await request(app)
      .post(`/v1/apps/${appId}/guides`)
      .set('Authorization', as('alice'))
      .send({ name: 'G', type: 'tooltip' });
    const draft = await request(app)
      .put(`/v1/apps/${appId}/guides/${g.body.id}/draft`)
      .set('Authorization', as('alice'))
      .send(onPage(page.id));
    await updatePage('alice', appId, page.id, { ...teamPage, routeMatch: { type: 'exact', value: '/team' } });
    const minted = await request(app)
      .post(`/v1/apps/${appId}/guides/${g.body.id}/preview-token`)
      .set('Authorization', as('alice'))
      .send({ versionId: draft.body.id });
    expect(minted.status).toBe(201);
    expect(minted.body.url).toMatch(/^https:\/\/app\.acme\.test\/team\?guidePreview=/);
  });

  it('preview links keep the token in the query when the start page has a query or #fragment', async () => {
    const { appId } = await signUp('alice');
    const page = await createPage('alice', appId, {
      name: 'Hash router',
      routeMatch: { type: 'exact', value: '/app' },
      startPath: '/app?tab=team#/settings',
    });
    const g = await request(app)
      .post(`/v1/apps/${appId}/guides`)
      .set('Authorization', as('alice'))
      .send({ name: 'G', type: 'tooltip' });
    const draft = await request(app)
      .put(`/v1/apps/${appId}/guides/${g.body.id}/draft`)
      .set('Authorization', as('alice'))
      .send(onPage(page.id));
    const minted = await request(app)
      .post(`/v1/apps/${appId}/guides/${g.body.id}/preview-token`)
      .set('Authorization', as('alice'))
      .send({ versionId: draft.body.id });
    const url = new URL(minted.body.url);
    expect(url.pathname).toBe('/app');
    expect(url.searchParams.get('tab')).toBe('team');
    expect(url.searchParams.get('guidePreview')).toBe(minted.body.token);
    expect(url.hash).toBe('#/settings');
  });

  it('refuses to delete a page a live guide or draft uses; afterwards old versions keep their route snapshot', async () => {
    const { key, appId } = await signUp('alice');
    const page = await createPage('alice', appId);
    const g = await liveGuide('alice', appId, onPage(page.id));

    const del = () =>
      request(app).delete(`/v1/apps/${appId}/pages/${page.id}`).set('Authorization', as('alice'));
    const blocked = await del();
    expect(blocked.status).toBe(409);
    expect(blocked.body).toMatchObject({
      error: 'page_in_use',
      details: { guides: [{ id: g.guideId, name: 'G' }] },
    });

    // Move the guide to a custom route (v2), then roll back to v1 after the page is gone.
    await request(app)
      .post(`/v1/apps/${appId}/guides/${g.guideId}/publish`)
      .set('Authorization', as('alice'))
      .send({ steps: [sampleStep], routeMatch: { type: 'exact', value: '/elsewhere' } });
    const list = await request(app).get(`/v1/apps/${appId}/pages`).set('Authorization', as('alice'));
    expect(list.body[0].usage).toEqual({ guides: 0, live: 0 });
    expect((await del()).status).toBe(204);

    const v1 = await adminPool.query(`SELECT page_id, route_match FROM guide_version WHERE id = $1`, [
      g.versionId,
    ]);
    expect(v1.rows[0]).toEqual({ page_id: null, route_match: { type: 'exact', value: '/settings/team' } });
    await request(app)
      .post(`/v1/apps/${appId}/guides/${g.guideId}/rollback/1`)
      .set('Authorization', as('alice'));
    expect((await agent(key, '/guides', visitor())).body.guides[0].routeMatch).toEqual({
      type: 'exact',
      value: '/settings/team',
    });
  });

  it('roles: viewers read, editors manage pages, only publishers move pages live guides use', async () => {
    const { orgId, appId } = await signUp('alice');
    await addMember('alice', orgId, 'vic', 'member', { [appId]: 'viewer' });
    await addMember('alice', orgId, 'eddie', 'member', { [appId]: 'editor' });
    await addMember('alice', orgId, 'pat', 'member', { [appId]: 'publisher' });

    expect((await request(app).get(`/v1/apps/${appId}/pages`).set('Authorization', as('vic'))).status).toBe(
      200,
    );
    expect(
      (await request(app).post(`/v1/apps/${appId}/pages`).set('Authorization', as('vic')).send(teamPage))
        .status,
    ).toBe(403);

    const unused = await createPage('eddie', appId, {
      name: 'Unused',
      routeMatch: { type: 'exact', value: '/u' },
    });
    expect(
      (
        await updatePage('eddie', appId, unused.id, {
          name: 'Unused',
          routeMatch: { type: 'exact', value: '/u2' },
        })
      ).status,
    ).toBe(200);

    // A page only a draft uses isn't live: editors may still move it.
    const drafted = await createPage('eddie', appId, {
      name: 'Drafted',
      routeMatch: { type: 'exact', value: '/d' },
    });
    const g = await request(app)
      .post(`/v1/apps/${appId}/guides`)
      .set('Authorization', as('eddie'))
      .send({ name: 'Draft only', type: 'tooltip' });
    await request(app)
      .put(`/v1/apps/${appId}/guides/${g.body.id}/draft`)
      .set('Authorization', as('eddie'))
      .send(onPage(drafted.id));
    expect(
      (
        await updatePage('eddie', appId, drafted.id, {
          name: 'Drafted',
          routeMatch: { type: 'exact', value: '/d2' },
        })
      ).status,
    ).toBe(200);

    const used = await createPage('eddie', appId);
    await liveGuide('alice', appId, onPage(used.id));
    const moved = { ...teamPage, routeMatch: { type: 'exact', value: '/team' } };
    expect((await updatePage('eddie', appId, used.id, moved)).status).toBe(403);
    // Changing only the start page also changes where the help center sends people.
    expect(
      (await updatePage('eddie', appId, used.id, { ...teamPage, startPath: '/settings/team?tab=members' }))
        .status,
    ).toBe(403);
    // Renaming doesn't change what's live.
    expect((await updatePage('eddie', appId, used.id, { ...teamPage, name: 'Team' })).status).toBe(200);
    expect((await updatePage('pat', appId, used.id, moved)).status).toBe(200);
    expect(
      (await request(app).delete(`/v1/apps/${appId}/pages/${unused.id}`).set('Authorization', as('vic')))
        .status,
    ).toBe(403);
  });

  it('isolation: other orgs can’t see or touch an app’s pages (API and RLS)', async () => {
    const alice = await signUp('alice');
    const bob = await signUp('bob');
    const page = await createPage('alice', alice.appId);

    expect(
      (await request(app).get(`/v1/apps/${alice.appId}/pages`).set('Authorization', as('bob'))).status,
    ).toBe(404);
    expect(
      (await request(app).get(`/v1/apps/${alice.appId}/pages/${page.id}`).set('Authorization', as('bob')))
        .status,
    ).toBe(404);
    expect((await updatePage('bob', bob.appId, page.id, teamPage)).status).toBe(404);
    expect(
      (await request(app).delete(`/v1/apps/${bob.appId}/pages/${page.id}`).set('Authorization', as('bob')))
        .status,
    ).toBe(404);

    // Even without the app_id filters, RLS hides the row.
    const bobUser = await adminPool.query(`SELECT id FROM studio_user WHERE oidc_sub = 'bob'`);
    const seen = await withStudioSession(bobUser.rows[0].id, (client) =>
      client.query(`SELECT id FROM app_page`).then((r) => r.rows),
    );
    expect(seen).toEqual([]);
    const seenByAgent = await withAgentSession(bob.key, (client) =>
      client.query(`SELECT id FROM app_page`).then((r) => r.rows),
    );
    expect(seenByAgent).toEqual([]);
  });
});
