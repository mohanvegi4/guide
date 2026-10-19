import { defineConfig } from 'vitest/config';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// The same version injection as build.mjs, so tests see the real version.
const pkg = createRequire(import.meta.url)('./package.json') as { version: string };

export default defineConfig({
  resolve: {
    alias: { '@guide-engine/core': fileURLToPath(new URL('../core/src/index.ts', import.meta.url)) },
  },
  define: { __GUIDE_ENGINE_VERSION__: JSON.stringify(pkg.version) },
  test: { include: ['test/**/*.test.ts'], environment: 'jsdom' },
});
