import { defineConfig } from 'vitest/config';
import { createRequire } from 'node:module';

// The same version injection as build.mjs, so tests see the real version.
const pkg = createRequire(import.meta.url)('./package.json') as { version: string };

export default defineConfig({
  define: { __GUIDE_ENGINE_VERSION__: JSON.stringify(pkg.version) },
  test: { include: ['test/**/*.test.ts'], environment: 'jsdom' },
});
