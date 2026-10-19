# @guide-engine/angular

Angular bindings for [Guide Engine](https://github.com/mohanvegi4/guide), a lightweight in-app
guide product: a `GuideService` that runs the engine and follows the router, a `GuideAnchorDirective`
that marks the elements guides point at, and a `GuideModule` for NgModule-based apps.

Most apps don't need this package: paste the **install snippet** from the Studio into your
`index.html` instead. Use the npm package when you prefer a dependency over a script tag, and
read [Packaging limitation](#packaging-limitation) first.

## Install

```sh
npm install @guide-engine/angular @guide-engine/core
```

Peer dependencies: `@angular/core` and `@angular/router` 17–21, `rxjs` 7, `@guide-engine/core`.

## Usage

```ts
// app.config.ts
import { inject, provideAppInitializer } from '@angular/core';
import { GuideService } from '@guide-engine/angular';

export const appConfig = {
  providers: [
    provideAppInitializer(() =>
      inject(GuideService).init({
        apiBaseUrl: 'https://guides.example.com', // your Guide Engine backend
        appKey: 'ge_pk_…', // the app's public key from the Studio
        visitor: { id: user.id }, // optional; anonymous visitors get a per-browser id
        account: { id: user.companyId }, // optional
        // jwt: token,                     // when the app requires a signed identity
      }),
    ),
  ],
};
```

```html
<!-- any component that imports GuideAnchorDirective (or GuideModule) -->
<button [guideAnchor]="'invite-button'">Invite</button>
```

`GuideService` subscribes to `NavigationEnd` and re-evaluates guides on every navigation.
After login call `identify({ visitor, account })`; wire your own help button to `openHelp()`
(`closeHelp()`, `toggleHelp()` exist too, and `helpButton: false` in `init` hides the floating one).

`provideAppInitializer` needs Angular 19+. On older versions, call `init` from an
`APP_INITIALIZER` factory or the root component's `ngOnInit`.

## Packaging limitation

This package is compiled with plain `tsc` (CommonJS + `.d.ts`, decorators compiled to
`__decorate` calls), **not** with ng-packagr, so it carries no Ivy partial-compilation metadata.
Angular's AOT compiler, the default for `ng build` and `ng serve`, cannot compile `GuideService`
and `GuideAnchorDirective` from this output; an AOT app fails at runtime with
`JIT compilation failed for injectable GuideService`. Until the package ships an ng-packagr build,
pick one of:

1. **Compile the sources yourself (recommended).** The wrapper is about 100 lines over
   `@guide-engine/core`. Copy
   [`packages/angular-wrapper/src`](https://github.com/mohanvegi4/guide/tree/main/packages/angular-wrapper/src)
   into your app (it only imports `@angular/core`, `@angular/router`, `rxjs` and
   `@guide-engine/core`) and let your app's compiler build it. Keep `@guide-engine/core` as the
   dependency; this package is then only a reference.
2. **JIT.** Add `import '@angular/compiler';` to `main.ts`. The published output includes the
   decorator metadata JIT needs, at the cost of shipping the compiler to the browser. This path is
   not covered by the repository's tests.
3. **The install snippet** instead of an npm package.

Also, the packages are CommonJS: Angular CLI may ask you to list `@guide-engine/core` in
`allowedCommonJsDependencies`.

## Docs

Full documentation lives in the
[Guide Engine repository](https://github.com/mohanvegi4/guide#readme); release notes are in its
[CHANGELOG](https://github.com/mohanvegi4/guide/blob/main/CHANGELOG.md).

## License

MIT
