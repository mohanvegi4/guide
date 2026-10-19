#!/usr/bin/env node
// Sets the version of the three public npm packages (@guide-engine/core, /angular, /vue) in one
// go, and points the wrappers' @guide-engine/core peer range at the same version, so a release is
// one command (`npm run version:set 0.2.0`) and the packages can never drift apart. Then it
// refreshes package-lock.json, because `npm ci` in the release workflow refuses a lock whose
// workspace entries disagree with package.json. Dependency-free on purpose.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CORE = '@guide-engine/core';
// The agent bundle is private but reports its version (banner, guideEngine.version, error
// reports), so it follows the same number as the packages it is built from.
const PACKAGES = ['packages/core', 'packages/angular-wrapper', 'packages/vue-wrapper', 'packages/agent'];
const DEPENDENCY_FIELDS = ['dependencies', 'peerDependencies', 'devDependencies', 'optionalDependencies'];

const [version, ...rest] = process.argv.slice(2);
// Plain semver with an optional prerelease (0.2.0, 1.0.0-rc.1); build metadata is not allowed on
// npm anyway and the tag check in the release workflow expects the same string.
if (rest.length > 0 || !version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error('usage: npm run version:set <version>   e.g. npm run version:set 0.2.0');
  process.exit(1);
}

for (const dir of PACKAGES) {
  const file = join(ROOT, dir, 'package.json');
  const pkg = JSON.parse(readFileSync(file, 'utf8'));
  const before = pkg.version;
  pkg.version = version;
  for (const field of DEPENDENCY_FIELDS) {
    if (pkg[field] && pkg[field][CORE]) pkg[field][CORE] = `^${version}`;
  }
  writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
  console.log(`${pkg.name}: ${before} -> ${version}`);
}

// Only the lock's own workspace entries change here; nothing is downloaded.
execFileSync('npm', ['install', '--package-lock-only', '--no-audit', '--no-fund'], {
  cwd: ROOT,
  stdio: 'inherit',
});
console.log(
  `\nDone. Next: review the diff, commit, then \`git tag v${version}\` and push the tag (see RELEASING.md).`,
);
