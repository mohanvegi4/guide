# The docs site

Published at https://mohanvegi4.github.io/guide/ by `.github/workflows/docs.yml` on every push to
`main` that touches `README.md`, `apps/studio/README.md`, `docs/**` or the workflow (and on
manual dispatch). This file is for contributors and is not published.

## One source of truth

The site is **assembled** rather than written twice:

- `docs/` is copied as is (`index.md`, `legal/*.md`, `_config.yml`). Every markdown file here
  needs Jekyll front matter (`title`, `nav_order`, and for the legal pages `parent`).
- `reference/README.md` is the root `README.md` and `reference/studio.md` is
  `apps/studio/README.md`, with front matter prepended. Relative links that only make sense in
  a checkout are rewritten: links between the READMEs become links between the pages, and
  other repository paths (for example `apps/studio/proxy.conf.json`) become GitHub URLs.
- Every page body is fenced in `{% raw %}` so Liquid ignores the `{{COMPANY}}`-style placeholders
  in the legal templates. Don't rely on Liquid in these pages; use relative markdown links.

`scripts/build-docs.mjs` does all of that and has no dependencies. Run it locally to see exactly
what Jekyll will build:

```bash
node scripts/build-docs.mjs      # writes site/ (gitignored) and lists the files
```

The Jekyll build itself (`actions/jekyll-build-pages@v1`, the `github-pages` gem with the
`just-the-docs` theme via `jekyll-remote-theme`) runs only in the workflow; it needs Ruby, which
the repo doesn't otherwise use. The config in `_config.yml` is deliberately minimal and standard
so that the local `site/` output is a faithful preview of the input.

## One-time setup (done by a repository admin)

GitHub Pages must be enabled with the **GitHub Actions** source, or the deploy step fails:

1. Repository **Settings → Pages**.
2. Under **Build and deployment → Source**, choose **GitHub Actions** (not "Deploy from a
   branch").
3. Push to `main` or run the **Docs site** workflow manually (**Actions → Docs site → Run
   workflow**). The first run creates the `github-pages` environment.

The site is served at `https://<owner>.github.io/guide/`; `baseurl` in `_config.yml` must match
the repository name.

## Adding a page

Create `docs/<name>.md` with front matter:

```markdown
---
title: My page
nav_order: 5
---
```

Link to it from `index.md` as `<name>.md`; the build turns that into `<name>.html`. Pages under
`docs/legal/` set `parent: Legal templates` to nest under the legal section.
