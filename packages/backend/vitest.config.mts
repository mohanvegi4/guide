import { defineConfig } from 'vitest/config';

const TEST_DB = 'postgres://guide_engine:guide_engine@localhost:5433/guide_engine_test';
// Superuser on the same test DB. Used ONLY by test fixtures for things the
// app role is (correctly) not allowed to do — e.g. seeding global guides or
// a tenant kill switch — and for asserting on raw rows. Never used by the app.
const TEST_ADMIN_DB = 'postgres://postgres:postgres@localhost:5433/guide_engine_test';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    // One shared Postgres database: run files serially so per-test truncation
    // in one file can't wipe rows another file is mid-way through using.
    fileParallelism: false,
    env: {
      NODE_ENV: 'test',
      // Fixed test-only secret; suites mint real HS256 tokens with it so they
      // exercise production auth, not the dev bypass.
      JWT_SECRET: 'test-secret-test-secret-test-secret-0123456789',
      JWT_ISSUER: 'guide-engine-test',
      JWT_AUDIENCE: 'guide-engine-api',
      GUIDE_ENGINE_DEV_AUTH: 'false',
      PREVIEW_TOKEN_SECRET: 'preview-secret-preview-secret-0123456789',
      PREVIEW_APP_BASE_URL: 'http://app.test',
      // Pin everything else the backend reads, so a developer's .env (loaded
      // by migrate.ts during global setup) can't leak into the tests.
      OIDC_ISSUER: '',
      OIDC_AUDIENCE: '',
      OIDC_JWKS_URI: '',
      OIDC_STUDIO_CLIENT_ID: '',
      CORS_ORIGINS: '',
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? TEST_DB,
      TEST_ADMIN_DATABASE_URL: process.env.TEST_ADMIN_DATABASE_URL ?? TEST_ADMIN_DB,
    },
  },
});
