# Changelog

All notable changes to the public npm packages (`@guide-engine/core`, `@guide-engine/angular`,
`@guide-engine/vue`) are documented here. The three packages share one version.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). How a release is cut is in
[RELEASING.md](RELEASING.md).

## [Unreleased]

### Changed

- **`@guide-engine/core`**: one guide at a time. When several guides match a page the engine
  used to show all of them at once (several cards and spotlights). Now walkthroughs (tours,
  multi-step guides) go first, then single-step tips in the server's order; the next one shows
  when the current one completes or fails to find its target, a dismissal ends the pop-ups for
  that page view (the rest return on the next navigation), and a guide launched from the help
  center takes the screen, with the automatic one returning once it's done. The agent bundle
  picks this up on its next build.

## [0.2.0] - 2026-10-19

First release on npm. The engine was previously consumed only through the install snippet or
`npm link`.

### Added

- **`@guide-engine/core`**: the framework-agnostic engine. `GuideEngine` loads the visitor's
  guides from the Guide Engine backend in one request, matches them to the current route, renders
  them through an injected renderer (`createDomRenderer`: a Shadow DOM card, spotlight ring,
  target tracking, retries with backoff when the anchor isn't in the DOM yet), records
  analytics events per step, and remembers what each visitor dismissed or completed so a guide
  shows once per published version. `identify()` switches the end user after login;
  `onRouteChange()` re-evaluates on navigation. Fail closed, fail silent: nothing renders when
  anything can't be verified, and nothing ever throws into the host page.
- **Help center** (`createHelpWidget`): a floating button (or your own via `openHelp()`,
  `closeHelp()`, `toggleHelp()`; `helpButton: false` hides the built-in one) opens a searchable
  list of the guides authors listed, including ones the visitor already finished. Guides on
  another page open through their start page with a `?guideEngine=help:<id>` launch link, and
  plain `?guideEngine=<id>` links launch a help-center guide directly. Opens and searches are
  reported for the Studio's help-center analytics.
- **Saved pages**: guides whose route is a Studio page follow the page's URL rule; the server
  resolves it, so the engine never needs a republish when a page moves.
- **Route modes**: path routing (`/settings/team`) or hash routing (`/#/settings/team`) per app,
  announced by the server (`routeMode`) with every `/guides` and `/help` response; in hash mode
  the engine matches the path inside the fragment and re-evaluates on `hashchange`.
- **Back buttons**: a `back` step action (`previousStep`) alongside `next`, `dismiss` and
  `complete`.
- **Error reporting**: exceptions the engine swallowed are sampled and reported to
  `POST /v1/agent/<key>/errors` with a per-page cap, so a broken page can't flood anything.
- **Preview links**: `?guidePreview=<token>` renders exactly that version with a badge and no
  analytics; invalid tokens are ignored.
- **Signed identity**: pass a server-signed `jwt` when the app requires one.
- **`@guide-engine/angular`**: `GuideService` (runs the engine and follows `NavigationEnd`,
  `identify`, `openHelp` / `closeHelp` / `toggleHelp`), `GuideAnchorDirective`
  (`[guideAnchor]="'id'"` sets `data-guide-id`) and `GuideModule`. Peer range: Angular 17–21.
- **`@guide-engine/vue`**: `GuidePlugin` (runs the engine and follows `vue-router`),
  `useGuideEngine()` and the `vGuideAnchor` directive. Peer range: Vue 3, vue-router 4.

### Known limitations

- `@guide-engine/angular` is compiled with `tsc`, not ng-packagr, so AOT apps must compile its
  sources themselves or enable JIT; see the package README.
- All three packages ship CommonJS + `.d.ts` (no ESM build yet).

[Unreleased]: https://github.com/mohanvegi4/guide/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/mohanvegi4/guide/releases/tag/v0.2.0
