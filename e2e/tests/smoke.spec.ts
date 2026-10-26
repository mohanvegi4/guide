import { expect, test, type Locator } from '@playwright/test';

/**
 * The whole product, once, through a real browser:
 *
 *   sign in to the Studio through Keycloak → create an organization with its
 *   first app → read the app's public key from the install snippet → create,
 *   publish and enable a guide → a website that installs the snippet with that
 *   key shows the guide.
 *
 * The "website" is a tiny HTML page with the install snippet (the shape from
 * README "1. Add the snippet"), served from a Playwright route at SITE_ORIGIN,
 * so its origin matches the app's websites list (per-app CORS) without a
 * server. The agent script and the agent API are the real backend's.
 *
 * Every run creates a fresh organization and deletes it at the end through
 * the Studio's own danger zone (even when an earlier step failed), so it can
 * be repeated against the same database without leaving "E2E …" orgs behind.
 */

const API_URL = (process.env.API_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const KEYCLOAK_USER = process.env.KEYCLOAK_USER ?? 'olivia';
const KEYCLOAK_PASSWORD = process.env.KEYCLOAK_PASSWORD ?? 'olivia';
/** Origin of the customer website: what the app's websites list must contain. */
const SITE_ORIGIN = (process.env.SITE_ORIGIN ?? 'http://e2e.localhost').replace(/\/$/, '');

const STAMP = Date.now();
const ORG_NAME = `E2E ${STAMP}`;
const APP_NAME = 'Site';
const GUIDE_NAME = 'Welcome card';
const GUIDE_CONTENT = 'Hello from e2e';

/**
 * Types into a Studio form field once Angular has wired it up. The Studio is
 * zoneless: the router creates a page's DOM a tick before the first change
 * detection, which is when formControlName attaches and writes the control's
 * initial value into the element. Text typed in that gap (a few ms, so never
 * by a person) is overwritten, so wait for the ng-pristine/ng-dirty status
 * class Angular adds at that moment, then check the value stuck.
 */
async function fillField(field: Locator, value: string): Promise<void> {
  await expect(field).toHaveClass(/\bng-(pristine|dirty)\b/);
  await field.fill(value);
  await expect(field).toHaveValue(value);
}

/** The customer's page: the install snippet pointing at the backend, plus a visitor id. */
function hostPage(appKey: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>E2E host page</title>
<script>
(function(w,d,k,a){var g=w.guideEngine=w.guideEngine||{_q:[]};
['initialize','identify','openHelp','closeHelp','toggleHelp'].forEach(function(m){g[m]=g[m]||function(){g._q.push([m].concat([].slice.call(arguments)))}});
var s=d.createElement('script');s.async=1;s.src=a+'/agent/v1/'+k+'/guides.js';d.head.appendChild(s);
})(window,document,${JSON.stringify(appKey)},${JSON.stringify(API_URL)});
guideEngine.initialize({ visitor: { id: ${JSON.stringify(`e2e-visitor-${STAMP}`)} } });
</script>
</head>
<body>
<h1>A customer's website</h1>
</body>
</html>`;
}

test('sign in with SSO, create an org and an app, publish a guide, see it on the website', async ({
  page,
  browser,
}) => {
  let orgId = '';
  let appId = '';
  let appKey = '';

  try {
    await run();
  } finally {
    // Best effort: an org exists from the moment step 2 succeeds, whatever
    // happens later. A failure here is reported, but never hides the real one.
    if (orgId) await deleteOrganization();
  }

  async function deleteOrganization(): Promise<void> {
    await test.step('Clean up: delete the organization', async () => {
      await page.goto(`/o/${orgId}/members`);
      const zone = page.locator('section.danger-zone');
      await fillField(zone.getByLabel(/to confirm/), ORG_NAME);
      await zone.getByRole('button', { name: 'Delete organization' }).click();
      // The Studio leaves the deleted org: to another org, or (olivia's only
      // org, as in CI) to Welcome, which has no org switcher at all.
      await page.waitForURL((url) => !url.pathname.includes(orgId));
      await expect(
        page.getByRole('combobox', { name: 'Organization' }).locator('option', { hasText: ORG_NAME }),
      ).toHaveCount(0);
    });
  }

  async function run(): Promise<void> {
    await test.step('Sign in to the Studio through Keycloak', async () => {
      await page.goto('/login');
      await page.getByRole('button', { name: 'Sign in with SSO' }).click();
      await page.waitForURL(/\/realms\/guide-engine\//);
      await page.getByLabel('Username or email').fill(KEYCLOAK_USER);
      await page.getByLabel('Password', { exact: true }).fill(KEYCLOAK_PASSWORD);
      await page.getByRole('button', { name: 'Sign In' }).click();
      // Back in the Studio and signed in: the header knows who we are.
      await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible({ timeout: 60_000 });
    });

    await test.step('Create an organization with its first app', async () => {
      // A first-time SSO user lands on Welcome. A user who already owns an
      // organization (every local run after the first) lands on its guides and
      // starts a new one from the header, so this works against any database.
      await page.waitForURL(/\/(welcome|o\/)/);
      if (!/\/welcome/.test(page.url())) await page.getByRole('link', { name: 'New org' }).click();
      await expect(page.getByRole('heading', { name: 'Welcome to Guide Studio' })).toBeVisible();

      await fillField(page.getByLabel('Organization name'), ORG_NAME);
      await fillField(page.getByLabel('First application'), APP_NAME);
      await fillField(page.getByRole('textbox', { name: /Website\(s\) where the app runs/ }), SITE_ORIGIN);
      await page.getByRole('button', { name: 'Create organization' }).click();

      // Straight to Install & settings for the new app.
      await page.waitForURL(/\/o\/[^/]+\/apps\/[^/]+\/settings/);
      const m = page.url().match(/\/o\/([^/]+)\/apps\/([^/]+)\/settings/);
      orgId = m?.[1] ?? '';
      appId = m?.[2] ?? '';
      expect(orgId).not.toBe('');
      expect(appId).not.toBe('');
      await expect(page.getByRole('heading', { name: `${APP_NAME} — settings` })).toBeVisible();
      await expect(page.getByRole('combobox', { name: 'Organization' })).toHaveValue(orgId);
    });

    await test.step('Read the public key from the install snippet', async () => {
      const snippet = (await page.locator('pre.snippet').first().textContent()) ?? '';
      const key = snippet.match(/ge_pk_[0-9a-f]{32}/)?.[0];
      expect(key, 'the install snippet carries the public key').toBeDefined();
      appKey = key ?? '';
      // The snippet is for this app: the key is the one shown in the header.
      await expect(page.getByText(`Public key ${appKey}`)).toBeVisible();
      // Guides only load on the website we gave the app, which belongs to its
      // one environment, Production.
      await expect(page.getByRole('textbox', { name: 'Websites of Production, one per line' })).toHaveValue(
        SITE_ORIGIN,
      );
    });

    await test.step('Create a guide: one centered card on the home page', async () => {
      await page.getByRole('link', { name: 'Guides', exact: true }).click();
      await page.waitForURL(new RegExp(`/o/${orgId}/apps/${appId}/guides$`));
      await fillField(page.getByLabel('Name'), GUIDE_NAME);
      await page.getByRole('button', { name: 'Create' }).click();
      await page.waitForURL(new RegExp(`/o/${orgId}/apps/${appId}/guides/[^/]+$`));
      await expect(page.getByRole('heading', { name: GUIDE_NAME })).toBeVisible();

      // A new app has no saved pages, so the guide gets a custom route: the
      // editor's default is the exact path "/", which is the host page's path.
      await expect(page.getByRole('radio', { name: 'A custom route' })).toBeChecked();
      await expect(page.getByRole('combobox', { name: 'Route match' })).toHaveValue('exact');
      await expect(page.getByRole('textbox', { name: 'Path', exact: true })).toHaveValue('/');
      // New guides start as help-center topics; this one should pop up on the page.
      await expect(page.getByRole('radio', { name: /^Only from the help center/ })).toBeChecked();
      await page.getByRole('radio', { name: /^Automatically/ }).check();
      await expect(page.getByRole('radio', { name: /^Automatically/ })).toBeChecked();
      // One step, no anchor: it shows as a centered card.
      await expect(page.getByLabel('Anchor (data-guide-id)')).toHaveValue('');
      await fillField(page.getByRole('textbox', { name: /^Content \(HTML/ }), `<p>${GUIDE_CONTENT}</p>`);
    });

    await test.step('Publish and enable it', async () => {
      await page.getByRole('button', { name: 'Publish new version' }).click();
      await expect(page.getByRole('status')).toHaveText(/Published v1\./);
      await page.getByRole('checkbox', { name: 'Disabled' }).check();
      await expect(page.getByRole('status')).toHaveText(/Guide enabled\./);
      await expect(page.getByRole('checkbox', { name: 'Enabled' })).toBeChecked();
    });

    await test.step('The website shows the guide', async () => {
      // A visitor's browser: a separate context, so nothing of the Studio
      // session (cookies, storage) is around, as on a real customer site.
      const visitor = await browser.newContext();
      try {
        // The page is fulfilled from a route, so Chromium can't place it in an
        // address space and its Local Network Access check would block the
        // script load from localhost (the backend). A real site on a real host
        // gets no such prompt for a public API.
        await visitor.grantPermissions(['local-network-access'], { origin: SITE_ORIGIN });
        const site = await visitor.newPage();
        await site.route(`${SITE_ORIGIN}/**`, (route) =>
          route.fulfill({ contentType: 'text/html', body: hostPage(appKey) }),
        );
        await site.goto(`${SITE_ORIGIN}/`);

        // The agent renders every step in a Shadow DOM under [data-guide-host]
        // (Playwright's CSS locators pierce open shadow roots).
        const card = site.locator('[data-guide-host] .card');
        await expect(card).toContainText(GUIDE_CONTENT);
        await expect(card.getByRole('button', { name: 'Next' })).toBeVisible();
        await expect(card.getByRole('button', { name: 'Dismiss' })).toBeVisible();
      } finally {
        await visitor.close();
      }
    });
  }
});
