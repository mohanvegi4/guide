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
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? TEST_DB,
      TEST_ADMIN_DATABASE_URL: process.env.TEST_ADMIN_DATABASE_URL ?? TEST_ADMIN_DB,
      // Fixed test-only secret for development Studio tokens (signed per test).
      JWT_SECRET: 'test-secret-test-secret-test-secret-0123456789',
      PREVIEW_TOKEN_SECRET: 'preview-secret-preview-secret-0123456789',
      AGENT_BUNDLE_PATH: 'test/fixtures/agent-bundle.js',
      AGENT_APP_CACHE_MS: '0',
      // Pin everything else the backend reads, so a developer's .env (loaded
      // by migrate.ts during global setup) can't leak into the tests.
      OIDC_ISSUER: '',
      OIDC_AUDIENCE: '',
      OIDC_JWKS_URI: '',
      OIDC_STUDIO_CLIENT_ID: '',
      AGENT_RATE_LIMIT_PER_MIN: '600',
      RATE_LIMIT_STORE: 'memory',
      // Encryption at rest is on in tests, so every path that stores or reads
      // a signing secret exercises it.
      SECRETS_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      EVENT_RETENTION_DAYS: '',
    },
  },
});
