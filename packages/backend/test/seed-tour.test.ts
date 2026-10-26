import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { adminPool, agent, closePools, resetData, signUp, visitor } from './helpers';
import { withStudioSession } from '../src/db';
import { seedWelcomeTour } from '../src/scripts/welcome-tour';

afterAll(closePools);
beforeEach(resetData);

describe('seeded welcome tour', () => {
  it('is live on /dashboard with five steps, in the help center, on a saved page', async () => {
    const { key, appId } = await signUp('alice');
    const userId = (await adminPool.query(`SELECT id FROM studio_user WHERE oidc_sub = 'alice'`)).rows[0].id;
    const guideId = await withStudioSession(userId, (client, ctx) => seedWelcomeTour(client, ctx, appId));

    const guides = (await agent(key, '/guides', visitor())).body.guides;
    expect(guides).toMatchObject([
      { id: guideId, routeMatch: { type: 'exact', value: '/dashboard' } },
    ]);
    expect(guides[0].steps).toHaveLength(5);
    expect(guides[0].steps.map((s: { order: number }) => s.order)).toEqual([0, 1, 2, 3, 4]);
    expect(guides[0].steps[4].actions).toEqual([{ label: 'Done', action: 'complete' }]);

    const help = (await agent(key, '/help', visitor())).body.guides;
    expect(help).toMatchObject([
      { id: guideId, help: { title: 'Take the welcome tour', startPath: '/dashboard' } },
    ]);

    const page = await adminPool.query(`SELECT name FROM app_page WHERE app_id = $1`, [appId]);
    expect(page.rows).toEqual([{ name: 'Dashboard' }]);
  });
});
