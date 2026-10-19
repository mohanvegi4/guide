# @guide-engine/vue

Vue 3 bindings for [Guide Engine](https://github.com/mohanvegi4/guide), a lightweight in-app
guide product: a `GuidePlugin` that runs the engine and follows `vue-router`, a `useGuideEngine()`
composable, and a `vGuideAnchor` directive that marks the elements guides point at.

Most apps don't need this package: paste the **install snippet** from the Studio into your
`index.html` instead. Use the npm package when you prefer a dependency over a script tag.

## Install

```sh
npm install @guide-engine/vue @guide-engine/core
```

Peer dependencies: `vue` 3, `vue-router` 4, `@guide-engine/core`.

## Usage

```ts
// main.ts
import { createApp } from 'vue';
import { GuidePlugin, vGuideAnchor } from '@guide-engine/vue';
import { router } from './router';

const app = createApp(App);
app.use(GuidePlugin, {
  router,
  apiBaseUrl: 'https://guides.example.com', // your Guide Engine backend
  appKey: 'ge_pk_…', // the app's public key from the Studio
  visitor: { id: user.id }, // optional; anonymous visitors get a per-browser id
  account: { id: user.companyId }, // optional
  // jwt: token,                     // when the app requires a signed identity
});
app.directive('guide-anchor', vGuideAnchor);
app.mount('#app');
```

```vue
<button v-guide-anchor="'invite-button'">Invite</button>
```

The plugin calls `engine.onRouteChange()` from `router.afterEach`. From a component:

```ts
import { useGuideEngine } from '@guide-engine/vue';

const engine = useGuideEngine();
engine.openHelp(); // wire your own help button (helpButton: false in the options hides the floating one)
await engine.identify({ visitor: { id }, account: { id } }); // after login
```

## Notes

- Built as CommonJS plus `.d.ts` files; Vite pre-bundles it without configuration.
- Full documentation lives in the
  [Guide Engine repository](https://github.com/mohanvegi4/guide#readme); release notes are in its
  [CHANGELOG](https://github.com/mohanvegi4/guide/blob/main/CHANGELOG.md).

## License

MIT
