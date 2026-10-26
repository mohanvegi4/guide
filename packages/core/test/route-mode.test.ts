import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GuideEngine,
  HelpItem,
  HelpUi,
  LAUNCH_STORAGE_KEY,
  createHelpWidget,
  currentRoutePath,
  displayRoutePath,
} from '../src';
import { R, baseOptions, callsTo, fakeRenderer, makeGuide, makeStep, mockFetch } from './helpers';

const HELP = R.guides.replace(/\/guides$/, '/help');

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
  window.history.replaceState({}, '', '/');
  window.sessionStorage.clear();
});

/** A /guides responder for a hash-routed app. */
const servingHash =
  (...guides: ReturnType<typeof makeGuide>[]) =>
  () => ({ body: { enabled: true, routeMode: 'hash', guides } });

function helpItem(id: string, route: string, startPath = route): HelpItem {
  return {
    ...makeGuide({
      id,
      versionId: `${id}-v1`,
      routeMatch: { type: 'exact', value: route },
      steps: [makeStep()],
    }),
    help: { title: `Topic ${id}`, description: '', keywords: [], startPath },
  };
}

const helpBody =
  (routeMode: string, ...guides: HelpItem[]) =>
  () => ({ body: { enabled: true, routeMode, button: { label: 'Help', color: '#4f46e5' }, guides } });

function fakeHelpUi() {
  const updates: Array<Parameters<HelpUi['update']>[0]> = [];
  const ui: HelpUi = {
    update: (s) => void updates.push(s),
    open: () => undefined,
    close: () => undefined,
    isOpen: () => false,
  };
  return { ui, updates };
}

describe('currentRoutePath', () => {
  const loc = (pathname: string, hash: string) => ({ pathname, hash }) as Location;
  it.each([
    ['path', loc('/settings/team', '#/x'), '/settings/team'],
    ['path', loc('/', ''), '/'],
    ['hash', loc('/app/', '#/settings/team'), '/settings/team'],
    ['hash', loc('/app/', '#/settings/team?tab=2'), '/settings/team'],
    ['hash', loc('/app/', '#'), '/'],
    ['hash', loc('/app/', ''), '/'],
  ] as const)('%s mode, %o -> %s', (mode, location, expected) => {
    expect(currentRoutePath(mode, location)).toBe(expected);
  });

  it('shows start pages the way visitors see them', () => {
    expect(displayRoutePath('path', '/team')).toBe('/team');
    expect(displayRoutePath('hash', '/team')).toBe('/#/team');
  });
});

describe('hash-routed apps', () => {
  it('matches routes on the hash path once the server says routeMode is hash', async () => {
    window.history.replaceState({}, '', '/app/index.html#/team');
    mockFetch({
      [R.guides]: servingHash(
        makeGuide({ id: 'team', routeMatch: { type: 'exact', value: '/team' } }),
        makeGuide({ id: 'doc', routeMatch: { type: 'pattern', value: '/app/*' } }), // the document path: not a route
      ),
    });
    const { renderer, rendered } = fakeRenderer();
    const engine = new GuideEngine();
    await engine.init(baseOptions, renderer);
    expect(rendered.map((r) => r.guide.id)).toEqual(['team']);
    expect(engine.currentPath()).toBe('/team');

    // The agent passes the current route on navigation; omitted, it's read from the location.
    window.history.replaceState({}, '', '/app/index.html#/billing?plan=pro');
    await engine.onRouteChange();
    expect(engine.currentPath()).toBe('/billing');
  });

  it('keeps matching on the URL path for path-routed apps (a hash is ignored)', async () => {
    window.history.replaceState({}, '', '/team#/billing');
    mockFetch({
      [R.guides]: () => ({
        body: {
          enabled: true,
          routeMode: 'path',
          guides: [makeGuide({ id: 'team', routeMatch: { type: 'exact', value: '/team' } })],
        },
      }),
    });
    const { renderer, rendered } = fakeRenderer();
    const engine = new GuideEngine();
    await engine.init(baseOptions, renderer);
    expect(rendered.map((r) => r.guide.id)).toEqual(['team']);
    expect(engine.currentPath()).toBe('/team');
  });

  it('tells the help UI the route mode', async () => {
    window.history.replaceState({}, '', '/#/home');
    mockFetch({ [R.guides]: servingHash(), [HELP]: helpBody('hash', helpItem('a', '/team')) });
    const help = fakeHelpUi();
    await new GuideEngine().init(baseOptions, fakeRenderer().renderer, help.ui);
    expect(help.updates.slice(-1)[0]).toMatchObject({ routeMode: 'hash', items: [{ id: 'a' }] });
  });

  it('starts a help guide for the current hash route right here', async () => {
    window.history.replaceState({}, '', '/#/team');
    const item = helpItem('a', '/team');
    mockFetch({ [R.guides]: servingHash(), [HELP]: helpBody('hash', item) });
    const { renderer, rendered } = fakeRenderer();
    const engine = new GuideEngine();
    const navigate = vi.fn();
    engine.navigate = navigate;
    await engine.init(baseOptions, renderer, fakeHelpUi().ui);
    engine.launchHelpGuide('a');
    expect(rendered.map((r) => r.guide.id)).toEqual(['a']);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('sends the visitor to /#<start page> and starts the guide on the route change that follows', async () => {
    window.history.replaceState({}, '', '/app/?v=2#/dashboard');
    const item = helpItem('b', '/reports/*', '/reports/2026?tab=all');
    mockFetch({ [R.guides]: servingHash(), [HELP]: helpBody('hash', item), [R.events]: () => ({ status: 202 }) });
    const { renderer, rendered } = fakeRenderer();
    const engine = new GuideEngine();
    const navigate = vi.fn((url: string) => window.history.replaceState({}, '', url));
    engine.navigate = navigate;
    await engine.init(baseOptions, renderer, fakeHelpUi().ui);
    engine.launchHelpGuide('b');
    // The document stays where it is (/app/?v=2); the route goes in the fragment,
    // and the guide in session storage. Only the fragment changes, so there is
    // no page load: the hash router's route change picks the hand-off up.
    expect(navigate).toHaveBeenCalledWith('/app/?v=2#/reports/2026?tab=all');
    expect(window.sessionStorage.getItem(LAUNCH_STORAGE_KEY)).not.toBeNull();
    await engine.onRouteChange();
    expect(rendered.map((r) => r.guide.id)).toEqual(['b']);
    expect(window.sessionStorage.getItem(LAUNCH_STORAGE_KEY)).toBeNull();
  });

  it('on arrival at /?guideEngine=help:<id>#<route>, starts the guide and removes only the parameter', async () => {
    window.history.replaceState({}, '', '/app/?guideEngine=help%3Aa#/team');
    const item = helpItem('a', '/team');
    const fetchMock = mockFetch({
      [R.guides]: servingHash(item),
      [HELP]: helpBody('hash', item),
      [R.events]: () => ({ status: 202 }),
    });
    const { renderer, rendered } = fakeRenderer();
    await new GuideEngine().init(baseOptions, renderer, fakeHelpUi().ui);
    expect(rendered.map((r) => r.guide.id)).toEqual(['a']); // once: not again by automatic evaluation
    expect(window.location.pathname + window.location.search + window.location.hash).toBe('/app/#/team');
    expect(callsTo(fetchMock, HELP)).toHaveLength(1);
  });
});

describe('default help widget in hash mode', () => {
  it('shows where a topic opens as /#<route>, in the list and in the confirmation', () => {
    window.history.replaceState({}, '', '/app/#/home');
    const ui = createHelpWidget({ onSelect: vi.fn() });
    const items = [helpItem('here', '/home'), helpItem('there', '/team')];
    ui.update({ items, button: { label: 'Help', color: '#4f46e5' }, showButton: true, routeMode: 'hash' });
    ui.open();
    const root = document.querySelector('[data-guide-help]')!.shadowRoot!;
    const where = Array.from(root.querySelectorAll('li')).map(
      (li) => li.querySelector('.where')?.textContent ?? null,
    );
    expect(where).toEqual([null, 'Opens on /#/team']);

    ui.confirmNavigation!(items[1], vi.fn());
    expect(root.querySelector('#ge-help-confirm-text')!.textContent).toBe(
      '“Topic there” starts on /#/team. Any unsaved changes on this page may be lost.',
    );
  });
});
