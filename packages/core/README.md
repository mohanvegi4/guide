# @guide-engine/core

The framework-agnostic engine behind [Guide Engine](https://github.com/mohanvegi4/guide), a
lightweight in-app guide product (tooltips, tours, modals, banners, a help center). This package
holds the state machine, the transport to the Guide Engine backend, the DOM renderer and the help
widget. The Angular and Vue wrappers (`@guide-engine/angular`, `@guide-engine/vue`) and the
install snippet sit on top of it.

Most websites don't need this package: paste the **install snippet** from the Studio into your
`<head>` instead. Use the npm package when you bundle your app and prefer a dependency over a
script tag.

## Install

```sh
npm install @guide-engine/core
```

## Usage

```ts
import { GuideEngine, createDomRenderer, createHelpWidget } from '@guide-engine/core';

const engine = new GuideEngine();

const renderer = createDomRenderer({
  advanceStep: (id) => engine.advanceStep(id),
  previousStep: (id) => engine.previousStep(id),
  dismissGuide: (id) => engine.dismissGuide(id),
});

// Optional: the help center (floating button unless `helpButton: false`, plus engine.openHelp()).
const help = createHelpWidget({
  onSelect: (item) => engine.launchHelpGuide(item.id),
  onOpen: () => engine.trackHelpOpened(),
  onSearch: (query, results) => engine.trackHelpSearched(query, results),
});

void engine.init(
  {
    apiBaseUrl: 'https://guides.example.com', // your Guide Engine backend
    appKey: 'ge_pk_…', // the app's public key from the Studio
    visitor: { id: user.id }, // optional; anonymous visitors get a per-browser id
    account: { id: user.companyId }, // optional
    // jwt: token,                     // when the app requires a signed identity
  },
  renderer,
  help,
);

// Single-page apps: tell the engine about navigations (or pass the new route explicitly).
engine.onRouteChange();
// After login:
await engine.identify({ visitor: { id }, account: { id } });
```

The engine **fails closed and fails silent**: when anything can't be verified it shows nothing,
and it never throws into the host page.

It shows **one guide at a time**. When several guides match a page, walkthroughs (tours and
multi-step guides) go before single-step tips, otherwise in the server's order; the next one
shows when the current one completes or fails to find its target. A dismissal ends the pop-ups
for that page view (the rest come back on the next navigation), and a guide launched from the
help center takes the screen until it's done, then the automatic one returns.

Mark the elements guides point at with `data-guide-id="…"`; a step targets them with
`[data-guide-id="invite-button"]`.

## Notes

- Built as CommonJS plus `.d.ts` files. Angular CLI may ask you to list `@guide-engine/core`
  in `allowedCommonJsDependencies`.
- Full documentation, the Studio, the backend and the install snippet live in the
  [Guide Engine repository](https://github.com/mohanvegi4/guide#readme). Release notes are in
  its [CHANGELOG](https://github.com/mohanvegi4/guide/blob/main/CHANGELOG.md).

## License

MIT
