# Releasing the npm package

One package is public on npm, `@guide-engine/core` (`packages/core`); everything else in the
monorepo is `private`.

A pushed tag `vX.Y.Z` runs
[`.github/workflows/release.yml`](.github/workflows/release.yml), which publishes it and creates
the GitHub Release. The agent, backend and Studio are not versioned by this process (they deploy
as Docker images from `ci.yml`).

## Prerequisites (once)

1. **The npm organization `guide-engine`** must exist and you must be a member who can publish
   (`npm org ls guide-engine`). If the name is taken, see [Renaming the scope](#renaming-the-scope).
2. **A publish token in the repository secrets.** Create a *granular access token* on npmjs.com
   with read/write on the `@guide-engine` packages (or the org), and add it to the GitHub repository
   as the secret `NPM_TOKEN`. The workflow also passes `--provenance`, which needs the repository
   to be public and the token to allow it; if that fails, drop `--provenance` from the workflow.
3. The GitHub Release is created with the workflow's own `GITHUB_TOKEN`; no extra secret.

## Steps

```sh
git checkout main && git pull
npm run version:set 0.2.0          # sets the core and agent versions, refreshes the lock
#   add a "## [0.2.0] - YYYY-MM-DD" section to CHANGELOG.md (move the Unreleased notes under it)
git add -A && git commit -m "Release 0.2.0"
git tag v0.2.0
git push origin main v0.2.0
```

Then watch the **Release** workflow on GitHub.

Before tagging, you can check what would be shipped: `npm run build`, then
`npm pack --dry-run --workspace=packages/core` lists the tarball contents;
only `dist/`, `README.md`, `LICENSE` and `package.json` should appear.

## What the workflow does

1. `npm ci`, `npm run build`, and the core tests (`npm test --if-present`).
2. **Verifies the tag:** the package `version` must equal the tag without its `v`. A mismatch
   fails the run before anything is published.
3. **Publishes** `@guide-engine/core` with
 `npm publish --workspace=<dir> --provenance --access public`. If that version is
   already on the registry it is skipped (`npm view <name>@<version> version`), so the workflow
   can be re-run safely.
4. **Creates the GitHub Release** for the tag with auto-generated notes (skipped if it exists).

Re-run a failed workflow from the Actions tab; nothing needs to be deleted first.

## Rolling back a bad publish

npm versions are immutable, and a version that was once published can never be published again,
so a fix is always a **new patch version** (`npm run version:set 0.2.1`, tag `v0.2.1`).

- **Deprecate** the bad version so installs warn about it:
  `npm deprecate @guide-engine/core@0.2.0 "Broken, use 0.2.1"`.
  Deprecation can be undone with an empty message.
- **Unpublish only within 72 hours** of publishing, and only when no other package depends on
  it (`npm unpublish @guide-engine/core@0.2.0`). Never unpublish after 72 hours: npm refuses,
  and it would break every consumer's lockfile. Deprecate instead.
- If the tag itself is wrong (points at the wrong commit), delete the GitHub Release and the tag
  *before* anything was published; after a publish, leave them and move forward.

## Renaming the scope

If `guide-engine` is not available on npm, pick another scope (say `@oclc-guides`) and change:

- the `name` in `packages/core/package.json` (and in `scripts/set-version.mjs`, the `CORE`
  constant);
- the alias for `@guide-engine/core` in `packages/agent/build.mjs`,
  `packages/agent/tsconfig.json` and `packages/agent/vitest.config.mts`;
- the package names in the READMEs (root "Alternative: the npm package", `packages/core/README.md`)
  and `CHANGELOG.md`.

The private packages (`@guide-engine/backend`, `/agent`, `/studio`, `/demo`) are never published,
so their names can stay. The agent's browser global stays `window.guideEngine` whatever the scope
is called: it is part of the install snippet, not of the npm package.
