import { defineConfig, devices } from '@playwright/test';

/**
 * Runs against an already-running stack (see README "Testing"): the Studio at
 * STUDIO_URL, the backend at API_URL and the Keycloak the backend's OIDC_ISSUER
 * names. Nothing is started here, so the same config serves local development
 * and CI (.github/workflows/ci.yml, job "e2e").
 */
const CI = Boolean(process.env.CI);

export default defineConfig({
  testDir: './tests',
  // One flow, one worker: the test creates its own organization, so repeated
  // runs don't collide, but there is nothing to parallelize either.
  workers: 1,
  fullyParallel: false,
  // Keycloak's first login after boot, and ng serve's first compile, are slow in CI.
  timeout: 180_000,
  expect: { timeout: 20_000 },
  retries: CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: process.env.STUDIO_URL ?? 'http://localhost:4300',
    actionTimeout: 20_000,
    navigationTimeout: 60_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
