import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

// One self-contained, minified IIFE: no module loader, no globals besides
// window.guideEngine. Bundles the core engine from source.
await build({
  entryPoints: [fileURLToPath(new URL('./src/index.ts', import.meta.url))],
  outfile: fileURLToPath(new URL('./dist/guide-engine.js', import.meta.url)),
  bundle: true,
  minify: true,
  format: 'iife',
  target: ['es2018'],
  legalComments: 'none',
  alias: { '@guide-engine/core': fileURLToPath(new URL('../core/src/index.ts', import.meta.url)) },
  banner: { js: '/* Guide Engine agent — https://github.com/mohanvegi4/guide */' },
});
