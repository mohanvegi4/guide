import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// One self-contained, minified IIFE: no module loader, no globals besides
// window.guideEngine. Bundles the core engine from source.
//
// The file on disk is self-describing: its first line is
//   /* guide-engine agent <version> <hash> */
// where <version> is this package's version and <hash> the first 16 hex
// chars of the sha256 of the code that follows the banner. The backend reads
// the version from that line and recomputes the same hash when it serves the
// file (ETag, GET /agent/v1/version), so a deploy or a rollback is visible
// from the outside without either side trusting the other's bookkeeping.
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8'));
const outfile = fileURLToPath(new URL('./dist/guide-engine.js', import.meta.url));

const result = await build({
  entryPoints: [fileURLToPath(new URL('./src/index.ts', import.meta.url))],
  bundle: true,
  minify: true,
  format: 'iife',
  target: ['es2018'],
  legalComments: 'none',
  write: false,
  alias: { '@guide-engine/core': fileURLToPath(new URL('../core/src/index.ts', import.meta.url)) },
  // The agent reports its version (window.guideEngine.version, error reports).
  define: { __GUIDE_ENGINE_VERSION__: JSON.stringify(pkg.version) },
});

const code = result.outputFiles[0].text;
const hash = createHash('sha256').update(code).digest('hex').slice(0, 16);
mkdirSync(fileURLToPath(new URL('./dist/', import.meta.url)), { recursive: true });
writeFileSync(outfile, `/* guide-engine agent ${pkg.version} ${hash} */\n${code}`);
console.log(`guide-engine agent ${pkg.version} ${hash} -> ${outfile}`);
