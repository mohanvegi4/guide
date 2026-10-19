#!/usr/bin/env node
// Assembles the docs site source into site/ (gitignored), ready for Jekyll.
//
// The READMEs are the single source of truth: this script copies docs/ as is,
// then adds reference/README.md (from the root README) and reference/studio.md
// (from apps/studio/README.md) with Jekyll front matter, and rewrites the few
// relative links that only make sense inside the repository checkout. The
// GitHub Actions workflow (.github/workflows/docs.yml) runs exactly this, so a
// local run shows the same markdown Jekyll will build:
//
//   node scripts/build-docs.mjs          # writes ./site
//   node scripts/build-docs.mjs out/dir  # writes somewhere else
//
// Dependency-free on purpose: it must run on a bare checkout, with no npm ci.

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(process.argv[2] ?? join(repoRoot, 'site'));
const docsDir = join(repoRoot, 'docs');

// Where repo-relative links point when they aren't pages of the site.
const GITHUB_BLOB = 'https://github.com/mohanvegi4/guide/blob/main/';

// The two READMEs become pages under reference/. `repoDir` is the directory the
// README lives in, so its relative links can be resolved to repo paths first.
const referencePages = [
  {
    source: 'README.md',
    target: 'reference/README.md',
    repoDir: '',
    frontMatter: { title: 'Guide Engine reference', nav_order: 2 },
  },
  {
    source: 'apps/studio/README.md',
    target: 'reference/studio.md',
    repoDir: 'apps/studio',
    frontMatter: { title: 'Studio reference', nav_order: 3 },
  },
];

// Repo paths that are pages in the site, and the page they map to. Anything
// else that looks like a path into the repository goes to GitHub.
const repoPathToSitePage = new Map([
  ['README.md', 'reference/README.md'],
  ['apps/studio/README.md', 'reference/studio.md'],
  ['docs/legal', 'legal/index.md'],
  ['docs/legal/', 'legal/index.md'],
  ['docs/legal/index.md', 'legal/index.md'],
  ['docs/legal/terms.md', 'legal/terms.md'],
  ['docs/legal/privacy.md', 'legal/privacy.md'],
  ['docs/legal/dpa.md', 'legal/dpa.md'],
  ['docs/legal/subprocessors.md', 'legal/subprocessors.md'],
  ['docs/index.md', 'index.md'],
  ['docs', 'index.md'],
  ['docs/', 'index.md'],
]);

/** POSIX-style normalisation of `base + link` without touching the filesystem. */
function resolveRepoPath(baseDir, link) {
  const parts = (baseDir ? baseDir.split('/') : []).filter(Boolean);
  for (const seg of link.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

/** Relative URL from the directory of `fromPage` to `toPage` (site paths). */
function relativeSitePath(fromPage, toPage) {
  const rel = relative(dirname(fromPage), toPage).split('\\').join('/');
  return rel.replace(/\.md$/, '.html');
}

/**
 * Rewrites markdown link targets in `markdown`, which came from the repo
 * directory `repoDir` and will live at the site path `sitePage`:
 *  - links to another page of the site become relative .html links;
 *  - other relative links into the repo become GitHub URLs;
 *  - absolute URLs, mailto: and #anchors are untouched.
 */
function rewriteLinks(markdown, repoDir, sitePage) {
  return markdown.replace(/\]\(([^)\s]+)\)/g, (match, target) => {
    if (/^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i.test(target)) return match; // absolute, mailto:, #anchor
    const [path, anchor = ''] = target.split('#');
    const repoPath = resolveRepoPath(repoDir, path);
    const page = repoPathToSitePage.get(repoPath);
    if (page) return `](${relativeSitePath(sitePage, page)}${anchor ? `#${anchor}` : ''})`;
    // A link within docs/ to a sibling docs file that is not in the map above
    // (e.g. a future docs page): keep it relative, swap the extension.
    if (repoPath.startsWith('docs/')) {
      return `](${relativeSitePath(sitePage, repoPath.slice('docs/'.length))}${anchor ? `#${anchor}` : ''})`;
    }
    return `](${GITHUB_BLOB}${repoPath}${anchor ? `#${anchor}` : ''})`;
  });
}

function yamlValue(v) {
  return typeof v === 'number' || typeof v === 'boolean' ? String(v) : JSON.stringify(String(v));
}

function renderFrontMatter(fields) {
  const lines = Object.entries(fields).map(([k, v]) => `${k}: ${yamlValue(v)}`);
  return `---\n${lines.join('\n')}\n---\n`;
}

/**
 * Splits a markdown file into its front matter block (or '') and body, and
 * fences the body in {% raw %} so Jekyll's Liquid leaves it alone. The legal
 * templates contain {{COMPANY}}-style placeholders, which Liquid would
 * otherwise render as empty strings; nothing in these pages needs Liquid.
 */
function fenceBody(markdown) {
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(markdown);
  const frontMatter = m ? m[0] : '';
  const body = m ? markdown.slice(m[0].length) : markdown;
  return `${frontMatter}{% raw %}\n${body.endsWith('\n') ? body : `${body}\n`}{% endraw %}\n`;
}

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

function main() {
  if (!existsSync(docsDir)) throw new Error(`docs/ not found at ${docsDir}`);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  const written = [];

  // 1. docs/ content, verbatim apart from link rewriting and the Liquid fence.
  //    docs/README.md is for contributors (how the site is built) and is not a page.
  for (const file of walk(docsDir)) {
    const rel = relative(docsDir, file).split('\\').join('/');
    if (rel === 'README.md') continue;
    const target = join(outDir, rel);
    mkdirSync(dirname(target), { recursive: true });
    if (rel.endsWith('.md')) {
      const source = readFileSync(file, 'utf8');
      if (!source.startsWith('---')) throw new Error(`${rel} has no front matter (title, nav_order)`);
      writeFileSync(target, fenceBody(rewriteLinks(source, `docs/${dirname(rel) === '.' ? '' : dirname(rel)}`, rel)));
    } else {
      cpSync(file, target);
    }
    written.push(rel);
  }

  // 2. The READMEs, with front matter prepended.
  for (const page of referencePages) {
    const source = readFileSync(join(repoRoot, page.source), 'utf8');
    const body = rewriteLinks(source, page.repoDir, page.target);
    const target = join(outDir, page.target);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, fenceBody(renderFrontMatter(page.frontMatter) + body));
    written.push(page.target);
  }

  // 3. Sanity check: every markdown page has front matter with a title.
  for (const rel of written.filter((f) => f.endsWith('.md'))) {
    const head = readFileSync(join(outDir, rel), 'utf8').slice(0, 400);
    if (!/^---\n[\s\S]*?\btitle:/.test(head)) throw new Error(`${rel}: missing title in front matter`);
  }

  process.stdout.write(`Assembled ${written.length} files into ${relative(process.cwd(), outDir) || '.'}:\n`);
  for (const rel of written.sort()) process.stdout.write(`  ${rel}\n`);
}

main();
