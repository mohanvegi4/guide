import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

// Resolve the SDK from source: the published package is CommonJS, which Vite
// doesn't transform for workspace-linked packages.
export default defineConfig({
  resolve: {
    alias: { '@guide-engine/core': fileURLToPath(new URL('../../packages/core/src/index.ts', import.meta.url)) },
  },
});
