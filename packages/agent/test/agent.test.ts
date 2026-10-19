import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const KEY = `ge_pk_${'b'.repeat(32)}`;
const SRC = `https://guides.example.com/agent/v1/${KEY}/guides.js`;

/** Installs the snippet's stub + script tag the way the real snippet does. */
function installSnippet(calls: unknown[][] = []) {
  const s = document.createElement('script');
  s.src = SRC;
  document.head.appendChild(s);
  (window as unknown as { guideEngine: unknown }).guideEngine = { _q: calls };
}

function mockApi() {
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
    new Response(JSON.stringify({ enabled: true, guides: [] }), { status: 200 })
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const guidesCalls = (f: ReturnType<typeof mockApi>) => f.mock.calls.filter(([u]) => String(u).endsWith('/guides'));
const body = (call: [string, RequestInit?]) => JSON.parse(String(call[1]!.body));

// Each test loads a fresh agent, which patches history; undo that between tests
// so earlier agents don't react to later tests' navigation.
const originalPush = window.history.pushState;
const originalReplace = window.history.replaceState;

beforeEach(() => {
  window.history.pushState = originalPush;
  window.history.replaceState = originalReplace;
  vi.resetModules();
  document.head.innerHTML = '';
  document.body.innerHTML = ''; // earlier agents' help widgets
  window.history.replaceState({}, '', '/start');
  delete (window as unknown as { guideEngine?: unknown }).guideEngine;
});
afterEach(() => vi.unstubAllGlobals());

describe('install snippet agent', () => {
  it('reads the key and API origin from its own script URL', async () => {
    const { locateInstall } = await import('../src/index');
    installSnippet();
    expect(locateInstall(document)).toEqual({ apiBaseUrl: 'https://guides.example.com', appKey: KEY });
  });

  it('replays queued calls (initialize first) against that app', async () => {
    const fetchMock = mockApi();
    installSnippet([
      ['identify', { visitor: { id: 'later-user' } }],
      ['initialize', { visitor: { id: 'u-1' }, account: { id: 'acme' } }],
    ]);
    await import('../src/index');
    await vi.waitFor(() => expect(guidesCalls(fetchMock).length).toBeGreaterThanOrEqual(2));

    const [first, second] = guidesCalls(fetchMock);
    expect(first[0]).toBe(`https://guides.example.com/v1/agent/${KEY}/guides`);
    expect(body(first)).toEqual({ visitor: { id: 'u-1' }, account: { id: 'acme' } });
    expect(body(second)).toMatchObject({ visitor: { id: 'later-user' } }); // the identify that came after
    expect((window as unknown as { guideEngine: { version: string } }).guideEngine.version).toBe('1');
  });

  it('follows client-side navigation (pushState, replaceState, back/forward)', async () => {
    const fetchMock = mockApi();
    installSnippet([['initialize', { visitor: { id: 'u-1' } }]]);
    await import('../src/index');
    await vi.waitFor(() => expect(guidesCalls(fetchMock)).toHaveLength(1));

    window.history.pushState({}, '', '/projects');
    await vi.waitFor(() => expect(guidesCalls(fetchMock)).toHaveLength(2));
    window.history.replaceState({}, '', '/projects?tab=2'); // same path: no re-evaluation
    window.history.replaceState({}, '', '/settings');
    await vi.waitFor(() => expect(guidesCalls(fetchMock)).toHaveLength(3));
    window.history.pushState({}, '', '/a');
    window.history.back();
    await vi.waitFor(() => expect(guidesCalls(fetchMock).length).toBeGreaterThanOrEqual(4));
  });

  it('is harmless when loaded twice', async () => {
    mockApi();
    installSnippet([['initialize', { visitor: { id: 'u-1' } }]]);
    const { startAgent } = await import('../src/index');
    const first = window.guideEngine;
    startAgent();
    expect(window.guideEngine).toBe(first);
  });

  it('never throws into the page when the key cannot be found', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    (window as unknown as { guideEngine: unknown }).guideEngine = { _q: [['initialize', {}]] };
    await expect(import('../src/index')).resolves.toBeDefined();
    expect(warn).toHaveBeenCalled();
  });
});

describe('help center API', () => {
  it('exposes openHelp/closeHelp/toggleHelp, and replays an openHelp queued before the script loaded', async () => {
    const fetchMock = vi.fn(async (url: string) =>
      new Response(
        JSON.stringify(
          String(url).endsWith('/help')
            ? { enabled: true, button: { label: 'Help', color: '#4f46e5' }, guides: [] }
            : { enabled: true, guides: [] }
        ),
        { status: 200 }
      )
    );
    vi.stubGlobal('fetch', fetchMock);
    installSnippet([
      ['openHelp'],
      ['initialize', { visitor: { id: 'u-1' }, helpButton: false }],
    ]);
    await import('../src/index');
    const api = window.guideEngine as unknown as { openHelp(): void; closeHelp(): void; toggleHelp(): void };
    expect(typeof api.openHelp).toBe('function');

    const panel = () => document.querySelector('[data-guide-help]')?.shadowRoot?.querySelector<HTMLElement>('.panel');
    await vi.waitFor(() => expect(panel()?.hidden).toBe(false)); // the queued openHelp ran
    api.toggleHelp();
    expect(panel()?.hidden).toBe(true);
    // helpButton:false: no floating button
    expect(document.querySelector('[data-guide-help]')!.shadowRoot!.querySelector<HTMLElement>('.launcher')!.hidden).toBe(true);
  });
});

describe('hash-routed apps', () => {
  // Agents from earlier tests still listen for hashchange (only the history
  // patches are undone between tests), so count only this test's own agent:
  // the calls carrying its visitor id.
  const guidesCallsBy = (f: ReturnType<typeof mockApi>, visitorId: string) =>
    guidesCalls(f).filter((c) => body(c as [string, RequestInit?]).visitor?.id === visitorId);

  it('matches routes on the hash path and follows hash navigation when the app says routeMode: hash', async () => {
    const guide = {
      id: 'g1',
      versionId: 'v1',
      name: 'Team',
      type: 'modal',
      routeMatch: { type: 'exact', value: '/team' },
      steps: [{ id: 's1', order: 0, type: 'modal', content: '<p>Hi</p>', actions: [] }],
    };
    const fetchMock = vi.fn(async (url: string) =>
      new Response(
        JSON.stringify(
          String(url).endsWith('/help')
            ? { enabled: true, routeMode: 'hash', button: { label: 'Help', color: '#4f46e5' }, guides: [] }
            : { enabled: true, routeMode: 'hash', guides: [guide] }
        ),
        { status: 200 }
      )
    );
    vi.stubGlobal('fetch', fetchMock);
    window.history.replaceState({}, '', '/app/#/home');
    installSnippet([['initialize', { visitor: { id: 'hash-user' } }]]);
    await import('../src/index');
    await vi.waitFor(() => expect(guidesCallsBy(fetchMock, 'hash-user')).toHaveLength(1));
    expect(document.querySelector('[data-guide-host]')).toBeNull(); // /home: no guide

    window.location.hash = '#/team'; // a hashchange, no pushState
    await vi.waitFor(() => expect(guidesCallsBy(fetchMock, 'hash-user')).toHaveLength(2));
    await vi.waitFor(() => expect(document.querySelector('[data-guide-host]')).not.toBeNull());
  });

  it('ignores hash changes for path-routed apps (no re-evaluation on anchor links)', async () => {
    const fetchMock = mockApi();
    window.history.replaceState({}, '', '/docs');
    installSnippet([['initialize', { visitor: { id: 'path-user' } }]]);
    await import('../src/index');
    await vi.waitFor(() => expect(guidesCallsBy(fetchMock, 'path-user')).toHaveLength(1));
    window.location.hash = '#section-2';
    await new Promise((r) => setTimeout(r, 50));
    expect(guidesCallsBy(fetchMock, 'path-user')).toHaveLength(1);
  });
});
