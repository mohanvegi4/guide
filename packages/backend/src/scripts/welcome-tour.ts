import { randomUUID } from 'crypto';
import { PoolClient } from 'pg';
import { StudioContext } from '../db';
import { sanitizeStepContent } from '../sanitize';

/**
 * The demo's ready-made multi-step guide: a five-step welcome tour of the
 * demo site's dashboard, published and enabled, listed in the help center,
 * on a saved "Dashboard" page. Seeded so a fresh checkout shows a real tour
 * without authoring anything first (apps/demo tags the anchors it points at).
 */
const NEXT = [
  { label: 'Next', action: 'next' },
  { label: 'Skip tour', action: 'dismiss' },
];
const anchor = (id: string) => `[data-guide-id="${id}"]`;
const TOUR_STEPS = [
  {
    type: 'modal',
    position: 'center',
    content: '<h3>Welcome to Acme 👋</h3><p>Let us show you around — it takes about 30 seconds.</p>',
    actions: [
      { label: 'Start tour', action: 'next' },
      { label: 'Maybe later', action: 'dismiss' },
    ],
  },
  {
    type: 'tooltip',
    position: 'bottom',
    targetSelector: anchor('nav-projects'),
    content:
      '<p><strong>Projects</strong> is where your work lives. Create one per client or initiative.</p>',
    actions: NEXT,
  },
  {
    type: 'tooltip',
    position: 'bottom',
    targetSelector: anchor('invite-button'),
    content:
      '<p>Acme is better with colleagues. <strong>Invite teammates</strong> sends them a link to join your account.</p>',
    actions: NEXT,
  },
  {
    type: 'tooltip',
    position: 'bottom',
    targetSelector: anchor('sign-in'),
    content:
      '<p>Switch who you are signed in as here. Guides remember what each visitor has already seen.</p>',
    actions: NEXT,
  },
  {
    type: 'tooltip',
    position: 'bottom',
    targetSelector: anchor('help-link'),
    content:
      '<p>Stuck later? <strong>? Help</strong> lists every walkthrough, including this one — you can replay it any time.</p>',
    actions: [{ label: 'Done', action: 'complete' }],
  },
];

/** Creates the "Dashboard" page and the published, enabled "Welcome tour" guide in `appId`. */
export async function seedWelcomeTour(
  client: PoolClient,
  ctx: StudioContext,
  appId: string,
): Promise<string> {
  const page = await client.query<{ id: string }>(
    `INSERT INTO app_page (app_id, name, match_type, match_value, created_by)
     VALUES ($1, 'Dashboard', 'exact', '/dashboard', $2) RETURNING id`,
    [appId, ctx.userId],
  );
  const guide = await client.query<{ id: string }>(
    `INSERT INTO guide (app_id, name, type, status, enabled, created_by)
     VALUES ($1, 'Welcome tour', 'tour', 'published', TRUE, $2) RETURNING id`,
    [appId, ctx.userId],
  );
  const steps = TOUR_STEPS.map((step, order) => ({
    ...step,
    id: randomUUID(),
    order,
    content: sanitizeStepContent(step.content),
  }));
  const help = {
    title: 'Take the welcome tour',
    description: 'A 30-second walk through the dashboard, projects and your team',
    keywords: ['tour', 'welcome', 'getting started', 'onboarding'],
  };
  const version = await client.query<{ id: string }>(
    `INSERT INTO guide_version (guide_id, version_number, steps, route_match, page_id, help, published_at)
     VALUES ($1, 1, $2, '{"type": "exact", "value": "/dashboard"}', $3, $4, now()) RETURNING id`,
    [guide.rows[0].id, JSON.stringify(steps), page.rows[0].id, JSON.stringify(help)],
  );
  // Live in every environment of the app (a seeded app has just one).
  await client.query(
    `INSERT INTO guide_release (guide_id, environment_id, app_id, version_id)
     SELECT $1, e.id, e.app_id, $2 FROM app_environment e WHERE e.app_id = $3`,
    [guide.rows[0].id, version.rows[0].id, appId],
  );
  await client.query(`UPDATE guide SET current_version_id = $1 WHERE id = $2`, [
    version.rows[0].id,
    guide.rows[0].id,
  ]);
  return guide.rows[0].id;
}
