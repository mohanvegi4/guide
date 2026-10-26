import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AgentClient,
  EventQueue,
  Guide,
  GuideEngine,
  GuideEventPayload,
  anonymousVisitorId,
  createDomRenderer,
  matchesRoute,
} from '../src';
import {
  API,
  KEY,
  R,
  baseOptions,
  bodyOf,
  callsTo,
  eventsSent,
  fakeRenderer,
  flushPromises,
  makeGuide,
  makeStep,
  mockFetch,
  serving,
} from './helpers';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
  window.history.replaceState({}, '', '/');
  localStorage.clear();
});

describe('matchesRoute', () => {
  it.each([
    [{ type: 'exact', value: '/dashboard' }, '/dashboard', true],
    [{ type: 'exact', value: '/dashboard' }, '/dashboard/x', false],
    [{ type: 'pattern', value: '/projects/*' }, '/projects/42', true],
    [{ type: 'pattern', value: '/projects/*' }, '/projects', false],
    [{ type: 'pattern', value: '/a/*/settings' }, '/a/7/settings', true],
    [{ type: 'pattern', value: '/v1.0/*' }, '/v1x0/a', false], // regex metachars are escaped
  ] as const)('%o vs %s -> %s', (rm, path, expected) => {
    expect(matchesRoute(rm, path)).toBe(expected);
  });
});

describe('talking to the agent API', () => {
  it('POSTs JSON as text/plain (no CORS preflight), with only the ids of visitor and account', async () => {
    window.history.replaceState({}, '', '/dashboard');
    const fetchMock = mockFetch({ [R.guides]: serving() });
    await new GuideEngine().init(baseOptions, fakeRenderer().renderer);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${API}/v1/agent/${KEY}/guides`);
    expect(init).toMatchObject({
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      credentials: 'omit',
    });
    expect(bodyOf(fetchMock.mock.calls[0])).toEqual({ visitor: { id: 'user-1' }, account: { id: 'acme' } });
  });

  it('sends visitor tags, dropping malformed and duplicate ones', async () => {
    const fetchMock = mockFetch({ [R.guides]: serving() });
    await new GuideEngine().init(
      {
        ...baseOptions,
        visitor: { id: 'user-1', tags: ['POS', 'POS', 'CUSTOMERS:edit', 'has space', '', 7 as unknown as string] },
      },
      fakeRenderer().renderer,
    );
    expect(bodyOf(fetchMock.mock.calls[0])).toEqual({
      visitor: { id: 'user-1', tags: ['POS', 'CUSTOMERS:edit'] },
      account: { id: 'acme' },
    });
  });

  it('sends tags for an anonymous visitor, with the per-browser id', async () => {
    const fetchMock = mockFetch({ [R.guides]: serving() });
    await new GuideEngine().init(
      { apiBaseUrl: API, appKey: KEY, visitor: { tags: ['anonymous'] } },
      fakeRenderer().renderer,
    );
    expect(bodyOf(fetchMock.mock.calls[0])).toEqual({ visitor: { id: anonymousVisitorId(), tags: ['anonymous'] } });
  });

  it('leaves tags to the signed token when there is one', async () => {
    const fetchMock = mockFetch({ [R.guides]: serving() });
    await new GuideEngine().init(
      { apiBaseUrl: API, appKey: KEY, jwt: 'signed.jwt.here', visitor: { id: 'u', tags: ['POS'] } },
      fakeRenderer().renderer,
    );
    expect(bodyOf(fetchMock.mock.calls[0])).toEqual({ jwt: 'signed.jwt.here', visitor: { id: 'u' } });
  });

  it('sends a signed identity when given one', async () => {
    const fetchMock = mockFetch({ [R.guides]: serving() });
    await new GuideEngine().init(
      { apiBaseUrl: API, appKey: KEY, jwt: 'signed.jwt.here' },
      fakeRenderer().renderer,
    );
    expect(bodyOf(fetchMock.mock.calls[0])).toEqual({ jwt: 'signed.jwt.here' });
  });

  it('gives unidentified visitors a stable anonymous id per browser', async () => {
    const fetchMock = mockFetch({ [R.guides]: serving() });
    await new GuideEngine().init({ apiBaseUrl: API, appKey: KEY }, fakeRenderer().renderer);
    await new GuideEngine().init({ apiBaseUrl: `${API}/`, appKey: KEY }, fakeRenderer().renderer);
    const [a, b] = fetchMock.mock.calls.map((c) => (bodyOf(c).visitor as { id: string }).id);
    expect(a).toMatch(/^anon-[0-9a-f-]{36}$/);
    expect(b).toBe(a);
    expect(anonymousVisitorId()).toBe(a);
  });
});

describe('kill switches and failures (fail closed)', () => {
  it('enabled:false disables the agent for the rest of the page', async () => {
    window.history.replaceState({}, '', '/dashboard');
    const fetchMock = mockFetch({ [R.guides]: () => ({ body: { enabled: false, guides: [makeGuide()] } }) });
    const { renderer, rendered } = fakeRenderer();
    const engine = new GuideEngine();
    await engine.init(baseOptions, renderer);
    await engine.onRouteChange('/dashboard');

    expect(rendered).toHaveLength(0);
    expect(callsTo(fetchMock, R.guides)).toHaveLength(1); // no further requests
  });

  it.each([
    [
      '401 (e.g. signed identity required)',
      () => ({ status: 401, body: { error: 'signed_identity_required' } }),
    ],
    ['500', () => ({ status: 500, body: { error: 'internal_error' } })],
    ['malformed body', () => ({ body: { something: 'else' } })],
    ['guides not an array', () => ({ body: { enabled: true, guides: 'nope' } })],
    ['network failure', () => Promise.reject(new TypeError('Failed to fetch'))],
  ])('%s → nothing rendered, init resolves', async (_name, route) => {
    window.history.replaceState({}, '', '/dashboard');
    mockFetch({ [R.guides]: route });
    const { renderer, rendered } = fakeRenderer();
    await expect(new GuideEngine().init(baseOptions, renderer)).resolves.toBeUndefined();
    expect(rendered).toHaveLength(0);
  });
});

describe('route matching → showing', () => {
  it('renders a guide whose route matches and emits guide_shown', async () => {
    window.history.replaceState({}, '', '/dashboard');
    const fetchMock = mockFetch({
      [R.guides]: serving(
        makeGuide(),
        makeGuide({ id: 'other', routeMatch: { type: 'exact', value: '/settings' } }),
      ),
      [R.events]: () => ({ status: 202 }),
    });
    const { renderer, rendered } = fakeRenderer();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    await new GuideEngine().init(baseOptions, renderer);

    expect(rendered.map((r) => r.guide.id)).toEqual(['guide-1']); // only the matching guide
    await vi.advanceTimersByTimeAsync(5000);
    expect(eventsSent(fetchMock).map((e) => e.eventType)).toEqual(['guide_shown']);
  });

  it('re-evaluates on route change, ignoring query strings, and does not restart a showing guide', async () => {
    window.history.replaceState({}, '', '/home');
    const fetchMock = mockFetch({ [R.guides]: serving(makeGuide()) });
    const { renderer, rendered } = fakeRenderer();
    const engine = new GuideEngine();

    await engine.init(baseOptions, renderer);
    expect(rendered).toHaveLength(0);

    await engine.onRouteChange('/dashboard?tab=team#x');
    expect(rendered).toHaveLength(1);

    await engine.onRouteChange('/dashboard');
    expect(rendered).toHaveLength(1);
    expect(callsTo(fetchMock, R.guides)).toHaveLength(3);
  });
});

describe('identify()', () => {
  it('switches users: clears what the old user saw and re-evaluates as the new one', async () => {
    window.history.replaceState({}, '', '/dashboard');
    const fetchMock = mockFetch({ [R.guides]: serving(makeGuide()), [R.events]: () => ({ status: 202 }) });
    const { renderer, rendered, cleared } = fakeRenderer();
    const engine = new GuideEngine();
    await engine.init({ apiBaseUrl: API, appKey: KEY }, renderer); // anonymous first
    expect(rendered).toHaveLength(1);

    await engine.identify({ visitor: { id: 'u-42' }, account: { id: 'globex' } });

    expect(cleared).toEqual(['guide-1']);
    expect(rendered).toHaveLength(2); // shown again for the new user
    const last = callsTo(fetchMock, R.guides).slice(-1)[0];
    expect(bodyOf(last)).toEqual({ visitor: { id: 'u-42' }, account: { id: 'globex' } });
  });

  it('re-evaluates with new tags, so guides for the new permissions are fetched', async () => {
    const fetchMock = mockFetch({ [R.guides]: serving(), [R.events]: () => ({ status: 202 }) });
    const engine = new GuideEngine();
    await engine.init(baseOptions, fakeRenderer().renderer);
    await engine.identify({ visitor: { id: 'user-1', tags: ['POS'] } });
    const last = callsTo(fetchMock, R.guides).slice(-1)[0];
    expect(bodyOf(last)).toMatchObject({ visitor: { id: 'user-1', tags: ['POS'] } });
  });
});

describe('step progression', () => {
  it('next → complete emits the full funnel and tears down', async () => {
    window.history.replaceState({}, '', '/dashboard');
    const s1 = makeStep({ id: 's1' });
    const s2 = makeStep({ id: 's2', actions: [{ label: 'Done', action: 'complete' }] });
    const fetchMock = mockFetch({
      [R.guides]: serving(makeGuide({ steps: [s1, s2] })),
      [R.events]: () => ({ status: 202 }),
    });
    const { renderer, rendered, cleared } = fakeRenderer();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const engine = new GuideEngine();
    await engine.init(baseOptions, renderer);

    engine.advanceStep('guide-1');
    engine.advanceStep('guide-1');
    await vi.advanceTimersByTimeAsync(5000);

    expect(rendered.map((r) => r.step.id)).toEqual(['s1', 's2']);
    expect(cleared).toEqual(['guide-1']);
    expect(eventsSent(fetchMock).map((e) => [e.eventType, e.stepId])).toEqual([
      ['guide_shown', 's1'],
      ['guide_step_completed', 's1'],
      ['guide_step_viewed', 's2'],
      ['guide_step_completed', 's2'],
      ['guide_completed', undefined],
    ]);
  });

  it('dismiss emits guide_dismissed for the current step and tears down', async () => {
    window.history.replaceState({}, '', '/dashboard');
    const fetchMock = mockFetch({
      [R.guides]: serving(makeGuide({ steps: [makeStep({ id: 's1' })] })),
      [R.events]: () => ({ status: 202 }),
    });
    const { renderer, cleared } = fakeRenderer();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const engine = new GuideEngine();
    await engine.init(baseOptions, renderer);

    engine.dismissGuide('guide-1');
    await vi.advanceTimersByTimeAsync(5000);

    expect(cleared).toEqual(['guide-1']);
    expect(eventsSent(fetchMock).slice(-1)[0]).toMatchObject({ eventType: 'guide_dismissed', stepId: 's1' });
  });
});

describe('target-not-found retries', () => {
  const targeted = () =>
    makeGuide({ steps: [makeStep({ id: 's1', targetSelector: '[data-guide-id="invite-button"]' })] });

  beforeEach(() => {
    window.history.replaceState({}, '', '/dashboard');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });

  it('retries with backoff, then errors and tears down after max attempts', async () => {
    const fetchMock = mockFetch({ [R.guides]: serving(targeted()), [R.events]: () => ({ status: 202 }) });
    const { renderer, rendered } = fakeRenderer();
    const engine = new GuideEngine();
    await engine.init(baseOptions, renderer);

    // Backoff is 300ms * attempt: 300 + 600 + ... + 3000 = 16.5s for 10 attempts.
    await vi.advanceTimersByTimeAsync(16_000);
    expect(eventsSent(fetchMock).filter((e) => e.eventType === 'guide_error')).toHaveLength(0); // still retrying

    await vi.advanceTimersByTimeAsync(500 + 5000); // final attempt + event flush
    expect(rendered).toHaveLength(0);
    const errors = eventsSent(fetchMock).filter((e) => e.eventType === 'guide_error');
    expect(errors).toEqual([
      expect.objectContaining({ stepId: 's1', metadata: { reason: 'target_not_found' } }),
    ]);

    // Torn down: the guide can be picked up again on a later navigation.
    await engine.onRouteChange('/dashboard');
    expect(callsTo(fetchMock, R.guides)).toHaveLength(2);
  });

  it('renders as soon as the target appears mid-retry', async () => {
    mockFetch({ [R.guides]: serving(targeted()), [R.events]: () => ({ status: 202 }) });
    const { renderer, rendered } = fakeRenderer();
    await new GuideEngine().init(baseOptions, renderer);

    await vi.advanceTimersByTimeAsync(300 + 600); // attempts 1-2: nothing there
    expect(rendered).toHaveLength(0);

    const button = document.createElement('button');
    button.setAttribute('data-guide-id', 'invite-button');
    document.body.appendChild(button);
    await vi.advanceTimersByTimeAsync(900); // attempt 3 finds it

    expect(rendered).toHaveLength(1);
    expect(rendered[0].target).toBe(button);
  });
});

describe('a later step whose anchor appears after the visitor acts', () => {
  beforeEach(() => window.history.replaceState({}, '', '/dashboard'));

  it('shows the card centered at once, then moves it onto the element when it appears', async () => {
    const guide = makeGuide({
      steps: [
        makeStep({ id: 's1' }),
        makeStep({ id: 's2', targetSelector: '[data-guide-id="item-scanner"]' }),
      ],
    });
    const fetchMock = mockFetch({ [R.guides]: serving(guide), [R.events]: () => ({ status: 202 }) });
    const { renderer, rendered } = fakeRenderer();
    const engine = new GuideEngine();
    await engine.init(baseOptions, renderer);
    expect(rendered.map((r) => r.step.id)).toEqual(['s1']);

    // "Next" with the scanner not on the page yet: the step still shows (centered).
    engine.advanceStep('guide-1');
    expect(rendered.map((r) => [r.step.id, r.target])).toEqual([
      ['s1', null],
      ['s2', null],
    ]);

    // The visitor picks a customer; the scanner renders. The card re-anchors,
    // with no second analytics event for the step.
    const scanner = document.createElement('input');
    scanner.setAttribute('data-guide-id', 'item-scanner');
    document.body.appendChild(scanner);
    await vi.waitFor(() => expect(rendered).toHaveLength(3));
    expect(rendered[2]).toMatchObject({ step: { id: 's2' }, target: scanner });

    engine.advanceStep('guide-1'); // completes
    await vi.waitFor(() =>
      expect(eventsSent(fetchMock).map((e) => e.eventType)).toEqual([
        'guide_shown',
        'guide_step_completed',
        'guide_step_viewed',
        'guide_step_completed',
        'guide_completed',
      ]),
    );
    expect(eventsSent(fetchMock).some((e) => e.eventType === 'guide_error')).toBe(false);
  });
});

describe('EventQueue', () => {
  const event = (i: number): GuideEventPayload => ({
    guideId: 'g',
    guideVersionId: 'v',
    sessionId: 's',
    eventType: 'guide_shown',
    occurredAt: new Date(0).toISOString(),
    metadata: { i },
  });
  const client = () => new AgentClient(API, KEY, () => ({ visitor: { id: 'u' } }));

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });

  it('batches events and flushes once after 5s, with the identity and keepalive', async () => {
    const fetchMock = mockFetch({ [R.events]: () => ({ status: 202 }) });
    const q = new EventQueue(client());
    q.push(event(1));
    q.push(event(2));
    q.push(event(3));

    await vi.advanceTimersByTimeAsync(4999);
    expect(callsTo(fetchMock, R.events)).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);

    const calls = callsTo(fetchMock, R.events);
    expect(calls).toHaveLength(1);
    expect(bodyOf(calls[0])).toMatchObject({ visitor: { id: 'u' } });
    expect(bodyOf(calls[0]).events).toHaveLength(3);
    expect(calls[0][1]!.keepalive).toBe(true);
  });

  it('flushes immediately at 20 events, in a single POST', async () => {
    const fetchMock = mockFetch({ [R.events]: () => ({ status: 202 }) });
    const q = new EventQueue(client());
    for (let i = 0; i < 20; i++) q.push(event(i));
    await flushPromises();

    const calls = callsTo(fetchMock, R.events);
    expect(calls).toHaveLength(1);
    expect((bodyOf(calls[0]).events as GuideEventPayload[]).map((e) => e.metadata)).toEqual(
      Array.from({ length: 20 }, (_, i) => ({ i })),
    );

    await vi.advanceTimersByTimeAsync(10_000); // the pending timer was cleared: no empty extra POST
    expect(callsTo(fetchMock, R.events)).toHaveLength(1);
  });

  it('drops a batch on network failure without throwing, and keeps working', async () => {
    let fail = true;
    const fetchMock = mockFetch({
      [R.events]: () => (fail ? Promise.reject(new TypeError('offline')) : { status: 202 }),
    });
    const q = new EventQueue(client());
    q.push(event(1));
    await expect(vi.advanceTimersByTimeAsync(5000)).resolves.not.toThrow();

    fail = false;
    q.push(event(2));
    await vi.advanceTimersByTimeAsync(5000);
    const last = callsTo(fetchMock, R.events).slice(-1)[0];
    expect(bodyOf(last).events).toEqual([event(2)]); // failed batch not retried
  });
});

describe('DOM renderer', () => {
  it('renders labels as text, never as HTML', () => {
    const renderer = createDomRenderer({
      advanceStep: vi.fn(),
      previousStep: vi.fn(),
      dismissGuide: vi.fn(),
    });
    renderer.renderStep(
      makeGuide(),
      makeStep({ actions: [{ label: '<img src=x onerror="window.__pwned=1">Next', action: 'next' }] }),
      null,
    );
    const shadow = document.querySelector('[data-guide-host]')!.shadowRoot!;
    const button = shadow.querySelector('.actions button')!;
    expect(button.textContent).toBe('<img src=x onerror="window.__pwned=1">Next');
    expect(shadow.querySelector('.actions img')).toBeNull();
  });

  it('spotlights the target and scrolls it into view once per step; untargeted steps get no spotlight', () => {
    const renderer = createDomRenderer({
      advanceStep: vi.fn(),
      previousStep: vi.fn(),
      dismissGuide: vi.fn(),
    });
    const target = document.createElement('button');
    document.body.appendChild(target);
    // Off-screen (below the fold), 100x40 at (20, 900).
    let rect = { top: 900, left: 20, width: 100, height: 40, bottom: 940, right: 120 };
    target.getBoundingClientRect = () => rect as DOMRect;
    const scrollIntoView = vi.fn();
    target.scrollIntoView = scrollIntoView;
    const step = makeStep({ id: 's1', targetSelector: '[data-guide-id="x"]' });

    renderer.renderStep(makeGuide(), step, target);
    const spotlight = document.querySelector<HTMLElement>('[data-guide-spotlight]')!;
    expect(spotlight.style.display).toBe('block');
    expect([
      spotlight.style.top,
      spotlight.style.left,
      spotlight.style.width,
      spotlight.style.height,
    ]).toEqual(['896px', '16px', '108px', '48px']);
    expect(spotlight.style.pointerEvents).toBe('none'); // the element stays clickable
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center', inline: 'nearest' });

    // The target moved (now on screen): the ring follows, but no second scroll.
    rect = { ...rect, top: 100, bottom: 140 };
    renderer.renderStep(makeGuide(), step, target);
    expect(spotlight.style.top).toBe('96px');
    expect(scrollIntoView).toHaveBeenCalledTimes(1);

    // The next step is untargeted: ring hidden. Clearing removes it.
    renderer.renderStep(makeGuide(), makeStep({ id: 's2' }), null);
    expect(spotlight.style.display).toBe('none');
    renderer.clear(makeGuide().id);
    expect(document.querySelector('[data-guide-spotlight]')).toBeNull();
  });

  it('does not re-render in a loop from its own style writes (observer feedback)', async () => {
    window.history.replaceState({}, '', '/dashboard');
    const target = document.createElement('button');
    target.setAttribute('data-guide-id', 'invite-button');
    document.body.appendChild(target);
    // 'top' matters: positionNear() resets then re-sets host.style.transform on
    // every render, so each render genuinely mutates a <body> descendant.
    mockFetch({
      [R.guides]: serving(
        makeGuide({
          steps: [makeStep({ targetSelector: '[data-guide-id="invite-button"]', position: 'top' })],
        }),
      ),
    });

    const engine = new GuideEngine();
    const real = createDomRenderer({
      advanceStep: (id) => engine.advanceStep(id),
      previousStep: (id) => engine.previousStep(id),
      dismissGuide: (id) => engine.dismissGuide(id),
    });
    const renderSpy = vi.fn(real.renderStep);
    await engine.init(baseOptions, { renderStep: renderSpy, clear: real.clear });
    expect(renderSpy).toHaveBeenCalledTimes(1);

    await new Promise((r) => setTimeout(r, 200)); // several animation frames
    expect(renderSpy).toHaveBeenCalledTimes(1); // renderer's own mutations ignored

    target.setAttribute('class', 'moved'); // a genuine host-app change does reposition
    await new Promise((r) => setTimeout(r, 100));
    expect(renderSpy).toHaveBeenCalledTimes(2);
  });
});

describe('DOM renderer keeps the card on screen', () => {
  it('nudges a card back inside the viewport when its anchor is near an edge or scrolled away', async () => {
    const target = document.createElement('button');
    target.setAttribute('data-guide-id', 'own-anchor');
    document.body.appendChild(target);
    let rect = { top: 100, left: 20, right: 120, bottom: 130, width: 100, height: 30 };
    target.getBoundingClientRect = () => rect as DOMRect;
    const renderer = createDomRenderer({
      advanceStep: () => {},
      previousStep: () => {},
      dismissGuide: () => {},
    });
    const guide = makeGuide({
      steps: [makeStep({ id: 's1', targetSelector: '[data-guide-id="own-anchor"]' })],
    });
    renderer.renderStep(guide, guide.steps[0], target);
    const host = document.querySelector<HTMLElement>('[data-guide-host]:not([data-guide-spotlight])')!;
    // jsdom doesn't lay out: give the card a size that follows its own top/left.
    host.getBoundingClientRect = () => {
      const top = parseFloat(host.style.top);
      const left = parseFloat(host.style.left);
      return { top, left, right: left + 300, bottom: top + 120, width: 300, height: 120 } as DOMRect;
    };
    Object.defineProperty(window, 'innerWidth', { value: 800, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 600, configurable: true });

    // The anchor scrolls above the viewport: the card stays reachable at the top.
    rect = { ...rect, top: -200, bottom: -170 };
    window.dispatchEvent(new Event('scroll'));
    await vi.waitFor(() => expect(host.style.top).toBe('8px'));

    // The anchor sits at the right edge: the card is pulled back in.
    rect = { ...rect, top: 100, bottom: 130, left: 700, right: 780 };
    window.dispatchEvent(new Event('scroll'));
    await vi.waitFor(() => expect(host.style.left).toBe(`${800 - 8 - 300}px`));
  });
});

describe('DOM renderer brings a freshly rendered anchor back when the page scrolls it away', () => {
  it('scrolls the anchor into view once if it leaves the viewport right after rendering', async () => {
    const target = document.createElement('button');
    target.setAttribute('data-guide-id', 'settle-anchor');
    document.body.appendChild(target);
    let rect = { top: 100, left: 20, right: 120, bottom: 130, width: 100, height: 30 };
    target.getBoundingClientRect = () => rect as DOMRect;
    const scrollIntoView = vi.fn();
    target.scrollIntoView = scrollIntoView;
    const renderer = createDomRenderer({
      advanceStep: () => {},
      previousStep: () => {},
      dismissGuide: () => {},
    });
    const guide = makeGuide({
      steps: [makeStep({ id: 's1', targetSelector: '[data-guide-id="settle-anchor"]' })],
    });
    renderer.renderStep(guide, guide.steps[0], target);
    expect(scrollIntoView).not.toHaveBeenCalled(); // visible at render time

    // The host page scrolls its container right after render: the anchor leaves the viewport.
    rect = { ...rect, top: -200, bottom: -170 };
    window.dispatchEvent(new Event('scroll'));
    await vi.waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1));

    // Still off screen on a later scroll (the visitor's own): left alone.
    window.dispatchEvent(new Event('scroll'));
    await new Promise((r) => requestAnimationFrame(() => r(undefined)));
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });
});

describe('DOM renderer keeps the card’s DOM across re-renders of the same step', () => {
  it('only moves the card when the same step is rendered again, so its buttons survive a click', () => {
    const target = document.createElement('button');
    target.setAttribute('data-guide-id', 'stable-anchor');
    document.body.appendChild(target);
    let rect = { top: 100, left: 20, right: 120, bottom: 130, width: 100, height: 30 };
    target.getBoundingClientRect = () => rect as DOMRect;
    const advanceStep = vi.fn();
    const renderer = createDomRenderer({ advanceStep, previousStep: () => {}, dismissGuide: () => {} });
    const guide = makeGuide({
      steps: [
        makeStep({ id: 's1', targetSelector: '[data-guide-id="stable-anchor"]' }),
        makeStep({ id: 's2', targetSelector: '[data-guide-id="stable-anchor"]' }),
      ],
    });
    renderer.renderStep(guide, guide.steps[0], target);
    const host = document.querySelector<HTMLElement>('[data-guide-host]:not([data-guide-spotlight])')!;
    const nextBefore = host.shadowRoot!.querySelector<HTMLButtonElement>('.actions button')!;

    // The page mutated and the element moved: the engine renders the step again.
    rect = { ...rect, top: 300, bottom: 330 };
    renderer.renderStep(guide, guide.steps[0], target);
    expect(host.style.top).toBe('338px'); // followed the element…
    expect(host.shadowRoot!.querySelector('.actions button')).toBe(nextBefore); // …without rebuilding
    nextBefore.click();
    expect(advanceStep).toHaveBeenCalledWith('guide-1');

    // A different step does rebuild the card.
    renderer.renderStep(guide, guide.steps[1], target);
    expect(host.shadowRoot!.querySelector('.actions button')).not.toBe(nextBefore);
  });
});

describe('DOM renderer: a way out on every step', () => {
  it('shows a close control that dismisses the guide, whatever buttons the author chose', () => {
    const dismissGuide = vi.fn();
    const renderer = createDomRenderer({ advanceStep: () => {}, previousStep: () => {}, dismissGuide });
    const guide = makeGuide({
      steps: [makeStep({ id: 's1', actions: [{ label: 'Next', action: 'next' }] })],
    });
    renderer.renderStep(guide, guide.steps[0], null);
    const shadow = document.querySelector('[data-guide-host]')!.shadowRoot!;
    const close = shadow.querySelector<HTMLButtonElement>('button[aria-label="Close guide"]')!;
    expect(close).not.toBeNull();
    expect(Array.from(shadow.querySelectorAll('.actions button'), (b) => b.textContent)).toEqual(['Next']);
    close.click();
    expect(dismissGuide).toHaveBeenCalledWith('guide-1');
  });

  it('dismisses on Escape', () => {
    const dismissGuide = vi.fn();
    const renderer = createDomRenderer({ advanceStep: () => {}, previousStep: () => {}, dismissGuide });
    const guide = makeGuide();
    renderer.renderStep(guide, guide.steps[0], null);
    const host = document.querySelector<HTMLElement>('[data-guide-host]')!;
    host.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(dismissGuide).toHaveBeenCalledWith('guide-1');
  });
});

describe('DOM renderer follows its element', () => {
  it('repositions the card and spotlight when the page scrolls or the window resizes', async () => {
    const target = document.createElement('button');
    target.setAttribute('data-guide-id', 'own-anchor');
    document.body.appendChild(target);
    let rect = { top: 100, left: 20, right: 120, bottom: 130, width: 100, height: 30 };
    target.getBoundingClientRect = () => rect as DOMRect;
    const renderer = createDomRenderer({
      advanceStep: () => {},
      previousStep: () => {},
      dismissGuide: () => {},
    });
    const guide = makeGuide({
      steps: [makeStep({ id: 's1', targetSelector: '[data-guide-id="own-anchor"]' })],
    });
    renderer.renderStep(guide, guide.steps[0], target);
    const host = document.querySelector<HTMLElement>('[data-guide-host]:not([data-guide-spotlight])')!;
    const spotlight = document.querySelector<HTMLElement>('[data-guide-spotlight]')!;
    expect(host.style.top).toBe('138px'); // below the element

    // The page scrolls (or smooth-scrolls the element into view): the element moved up 80px.
    rect = { ...rect, top: 20, bottom: 50 };
    window.dispatchEvent(new Event('scroll'));
    await vi.waitFor(() => expect(host.style.top).toBe('58px'));
    expect(spotlight.style.top).toBe('16px');

    window.dispatchEvent(new Event('resize'));
    rect = { ...rect, left: 200, right: 300 };
    await vi.waitFor(() => expect(host.style.left).toBe('200px'));

    // Cleared: nothing follows anymore (and no error from a stale listener).
    renderer.clear(guide.id);
    rect = { ...rect, top: 0, bottom: 30 };
    window.dispatchEvent(new Event('scroll'));
    await new Promise((r) => requestAnimationFrame(() => r(undefined)));
    expect(document.querySelector('[data-guide-host]')).toBeNull();
  });
});

describe('step change vs. target observer (regression)', () => {
  it("does not re-render the next, untargeted step next to the previous step's target", async () => {
    window.history.replaceState({}, '', '/dashboard');
    const target = document.createElement('button');
    target.setAttribute('data-guide-id', 'invite-button');
    document.body.appendChild(target);
    mockFetch({
      [R.guides]: serving(
        makeGuide({
          steps: [
            makeStep({ id: 's1', targetSelector: '[data-guide-id="invite-button"]' }),
            makeStep({ id: 's2', position: 'center' }),
          ],
        }),
      ),
      [R.events]: () => ({ status: 202 }),
    });
    const { renderer, rendered } = fakeRenderer();
    const engine = new GuideEngine();
    await engine.init(baseOptions, renderer);
    engine.advanceStep('guide-1'); // now on the centered step 2

    document.body.appendChild(document.createElement('div')); // unrelated host-app change
    await new Promise((r) => setTimeout(r, 100));

    expect(rendered.map((r) => [r.step.id, r.target])).toEqual([
      ['s1', target],
      ['s2', null],
    ]);
  });

  it('re-renders against a re-mounted target element', async () => {
    window.history.replaceState({}, '', '/dashboard');
    const first = document.createElement('button');
    first.setAttribute('data-guide-id', 'invite-button');
    document.body.appendChild(first);
    mockFetch({
      [R.guides]: serving(
        makeGuide({ steps: [makeStep({ targetSelector: '[data-guide-id="invite-button"]' })] }),
      ),
    });
    const { renderer, rendered } = fakeRenderer();
    await new GuideEngine().init(baseOptions, renderer);

    first.remove(); // framework re-renders the button as a new element
    const second = document.createElement('button');
    second.setAttribute('data-guide-id', 'invite-button');
    document.body.appendChild(second);
    await new Promise((r) => setTimeout(r, 100));

    expect(rendered[rendered.length - 1].target).toBe(second);
  });
});

describe('identity changes and transport', () => {
  type Answer = { status?: number; body?: unknown };
  /** A fetch stub whose responder sees the parsed body and may wait. */
  function stubFetch(answer: (path: string, body: Record<string, unknown>, init?: RequestInit) => Promise<Answer> | Answer) {
    const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = String(input).slice(API.length);
      const out = await answer(path, init?.body ? JSON.parse(String(init.body)) : {}, init);
      return new Response(JSON.stringify(out.body ?? {}), { status: out.status ?? 200 });
    });
    vi.stubGlobal('fetch', fn);
    return fn;
  }

  it('sends tags only where guides are matched: ids to /events, nothing with error reports', async () => {
    window.history.replaceState({}, '', '/dashboard');
    const fetchMock = mockFetch({ [R.guides]: serving(makeGuide()), [R.events]: () => ({ status: 202 }) });
    const engine = new GuideEngine();
    await engine.init({ ...baseOptions, visitor: { id: 'user-1', tags: ['POS'] } }, fakeRenderer().renderer);
    engine.dismissGuide('guide-1'); // an urgent flush
    await flushPromises();

    expect(bodyOf(callsTo(fetchMock, R.guides)[0])).toMatchObject({ visitor: { id: 'user-1', tags: ['POS'] } });
    const events = callsTo(fetchMock, R.events);
    expect(events).toHaveLength(1);
    expect(bodyOf(events[0]).visitor).toEqual({ id: 'user-1' });
  });

  it('sends a body too large for keepalive as an ordinary request', async () => {
    const fetchMock = mockFetch({ [R.events]: () => ({ status: 202 }) });
    await new AgentClient(API, KEY, () => ({ jwt: 'x'.repeat(70_000) })).post('/events', { events: [] }, true);
    await new AgentClient(API, KEY, () => ({ jwt: 'small' })).post('/events', { events: [] }, true);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ keepalive: false });
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ keepalive: true });
  });

  it('measures the keepalive budget in bytes, not characters', async () => {
    const fetchMock = mockFetch({ [R.events]: () => ({ status: 202 }) });
    // 25,000 characters but about 62,500 bytes in UTF-8: over the 60 KiB budget.
    await new AgentClient(API, KEY, () => ({})).post('/events', { events: [], note: 'é€'.repeat(12_500) }, true);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ keepalive: false });
  });

  it('retries an event batch the browser refused as keepalive, once, without keepalive', async () => {
    const fn = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.keepalive) throw new TypeError('Failed to fetch');
      return new Response('{}', { status: 202 });
    });
    vi.stubGlobal('fetch', fn);
    const queue = new EventQueue(new AgentClient(API, KEY, () => ({ visitor: { id: 'u' } })));
    queue.push({ sessionId: 's', eventType: 'guide_dismissed', occurredAt: new Date().toISOString() });
    await flushPromises();
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn.mock.calls[1][1]).toMatchObject({ keepalive: false });
  });

  it('keeps the guide on screen when the same visitor gets new tags, and re-fetches with them', async () => {
    window.history.replaceState({}, '', '/dashboard');
    const fetchMock = mockFetch({ [R.guides]: serving(makeGuide()), [R.events]: () => ({ status: 202 }) });
    const { renderer, rendered, cleared } = fakeRenderer();
    const engine = new GuideEngine();
    await engine.init(baseOptions, renderer);
    expect(rendered).toHaveLength(1);

    await engine.identify({ visitor: { id: 'user-1', tags: ['POS'] } });

    expect(cleared).toEqual([]);
    expect(rendered).toHaveLength(1); // neither torn down nor shown twice
    expect(bodyOf(callsTo(fetchMock, R.guides).slice(-1)[0])).toEqual({
      visitor: { id: 'user-1', tags: ['POS'] },
      account: { id: 'acme' },
    });
  });

  it('drops a /guides answer requested for the previous identity', async () => {
    window.history.replaceState({}, '', '/dashboard');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    stubFetch(async (path, body) => {
      if (path !== R.guides) return { status: 404 };
      const tags = (body.visitor as { tags?: string[] } | undefined)?.tags ?? [];
      if (tags.includes('anonymous')) {
        await gate; // answered only after the visitor signed in
        return { body: { enabled: true, guides: [makeGuide({ id: 'anonymous-only' })] } };
      }
      return { body: { enabled: true, guides: [] } };
    });
    const { renderer, rendered } = fakeRenderer();
    const engine = new GuideEngine();
    const started = engine.init({ apiBaseUrl: API, appKey: KEY, visitor: { tags: ['anonymous'] } }, renderer);
    await flushPromises();
    await engine.identify({ visitor: { id: 'p1', tags: ['signed-in'] } });
    release();
    await started;

    expect(rendered).toEqual([]);
  });

  it('lets the latest of two overlapping identify() calls win', async () => {
    window.history.replaceState({}, '', '/dashboard');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const fetchMock = stubFetch(async (path) => {
      if (path === R.events) {
        await gate; // the first identify() waits here, flushing the old user's events
        return { status: 202 };
      }
      if (path === R.guides) return { body: { enabled: true, guides: [makeGuide()] } };
      return { status: 404 };
    });
    const engine = new GuideEngine();
    await engine.init(baseOptions, fakeRenderer().renderer); // shows guide-1: guide_shown is queued

    const first = engine.identify({ visitor: { id: 'u2' } });
    await flushPromises();
    const second = engine.identify({ visitor: { id: 'u3' } });
    await second;
    release();
    await first;

    const lastGuides = callsTo(fetchMock, R.guides).slice(-1)[0];
    expect(bodyOf(lastGuides).visitor).toEqual({ id: 'u3' });
  });

  it('does not bring back a guide torn down while it waited for its anchor', async () => {
    window.history.replaceState({}, '', '/dashboard');
    const waiting = makeGuide({
      id: 'late',
      steps: [makeStep({ targetSelector: '[data-guide-id="late"]' })],
    });
    let served: Guide[] = [waiting];
    stubFetch((path) => (path === R.guides ? { body: { enabled: true, guides: served } } : { status: 202 }));
    const { renderer, rendered } = fakeRenderer();
    const engine = new GuideEngine();
    await engine.init(baseOptions, renderer); // waits quietly for the anchor
    served = [];
    await engine.identify({ visitor: { id: 'someone-else' } });

    const anchor = document.createElement('button');
    anchor.setAttribute('data-guide-id', 'late');
    document.body.appendChild(anchor);
    await new Promise((resolve) => setTimeout(resolve, 700)); // past the first two polls

    expect(rendered).toEqual([]);
  });

  it('still starts a help link when identify() overlaps the first help answer', async () => {
    window.history.replaceState({}, '', '/dashboard?guideEngine=help:g1');
    const listed = { ...makeGuide({ id: 'g1' }), help: { title: 'T', description: '', keywords: [], startPath: '/dashboard' } };
    stubFetch((path) =>
      path.endsWith('/help')
        ? { body: { enabled: true, guides: [listed] } }
        : path === R.guides
          ? { body: { enabled: true, guides: [] } }
          : { status: 202 },
    );
    const { renderer, rendered } = fakeRenderer();
    const engine = new GuideEngine();
    const started = engine.init(baseOptions, renderer); // its /help answer will be stale
    await engine.identify({ visitor: { id: 'user-1', tags: ['POS'] } });
    await started;

    expect(rendered.map((r) => r.guide.id)).toEqual(['g1']);
    expect(window.location.search).toBe('');
  });

  it('treats another account as another context: events flushed first, guides reset', async () => {
    window.history.replaceState({}, '', '/dashboard');
    const fetchMock = mockFetch({ [R.guides]: serving(makeGuide()), [R.events]: () => ({ status: 202 }) });
    const { renderer, cleared } = fakeRenderer();
    const engine = new GuideEngine();
    await engine.init(baseOptions, renderer); // guide_shown queued under acme

    await engine.identify({ account: { id: 'globex' } });

    expect(bodyOf(callsTo(fetchMock, R.events)[0])).toMatchObject({ account: { id: 'acme' } });
    expect(cleared).toEqual(['guide-1']);
  });

  it('combines overlapping partial identify() calls', async () => {
    window.history.replaceState({}, '', '/dashboard');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const fetchMock = stubFetch(async (path) => {
      if (path === R.events) {
        await gate;
        return { status: 202 };
      }
      return path === R.guides ? { body: { enabled: true, guides: [makeGuide()] } } : { status: 404 };
    });
    const engine = new GuideEngine();
    await engine.init(baseOptions, fakeRenderer().renderer);

    const first = engine.identify({ visitor: { id: 'u2' } });
    await flushPromises();
    const second = engine.identify({ account: { id: 'globex' } });
    release();
    await Promise.all([first, second]);

    const last = bodyOf(callsTo(fetchMock, R.guides).slice(-1)[0]);
    expect(last).toMatchObject({ visitor: { id: 'u2' }, account: { id: 'globex' } });
  });

  it('drops an answer requested while identify() was still flushing the old identity', async () => {
    window.history.replaceState({}, '', '/dashboard');
    let releaseEvents!: () => void;
    const eventsGate = new Promise<void>((resolve) => (releaseEvents = resolve));
    let releaseRoute!: () => void;
    const routeGate = new Promise<void>((resolve) => (releaseRoute = resolve));
    let guidesCalls = 0;
    stubFetch(async (path, body) => {
      if (path === R.events) {
        await eventsGate;
        return { status: 202 };
      }
      if (path !== R.guides) return { status: 404 };
      guidesCalls++;
      const visitor = (body.visitor as { id: string }).id;
      if (guidesCalls === 1) return { body: { enabled: true, guides: [makeGuide()] } }; // init, as u1
      if (visitor === 'user-1') {
        await routeGate; // a navigation's answer for u1, arriving late
        return { body: { enabled: true, guides: [makeGuide({ id: 'u1-only' })] } };
      }
      return { body: { enabled: true, guides: [] } };
    });
    const { renderer, rendered } = fakeRenderer();
    const engine = new GuideEngine();
    await engine.init(baseOptions, renderer); // shows guide-1; guide_shown queued

    const switching = engine.identify({ visitor: { id: 'u2' } }); // waits on the flush
    await flushPromises();
    const navigating = engine.onRouteChange('/dashboard'); // still asks as u1
    await flushPromises();
    releaseEvents();
    await switching;
    releaseRoute();
    await navigating;

    expect(rendered.map((r) => r.guide.id)).toEqual(['guide-1']);
  });

  it('keeps the visitor id when identify() only updates tags; id: undefined makes them anonymous', async () => {
    window.history.replaceState({}, '', '/dashboard');
    const fetchMock = mockFetch({ [R.guides]: serving(), [R.events]: () => ({ status: 202 }) });
    const engine = new GuideEngine();
    await engine.init({ ...baseOptions, visitor: { id: 'u-42' } }, fakeRenderer().renderer);

    await engine.identify({ visitor: { tags: ['POS'] } });
    expect(bodyOf(callsTo(fetchMock, R.guides).slice(-1)[0]).visitor).toEqual({ id: 'u-42', tags: ['POS'] });

    await engine.identify({ visitor: { id: undefined, tags: ['anonymous'] } });
    expect(bodyOf(callsTo(fetchMock, R.guides).slice(-1)[0]).visitor).toEqual({
      id: anonymousVisitorId(),
      tags: ['anonymous'],
    });
  });

  it('identify(null) signs the visitor out: guides removed, nothing fetched until the next identify()', async () => {
    window.history.replaceState({}, '', '/dashboard');
    const fetchMock = mockFetch({ [R.guides]: serving(makeGuide()), [R.events]: () => ({ status: 202 }) });
    const { renderer, rendered, cleared } = fakeRenderer();
    const engine = new GuideEngine();
    await engine.init(baseOptions, renderer); // shows guide-1; guide_shown queued
    const guidesBefore = callsTo(fetchMock, R.guides).length;

    await engine.identify(null);
    expect(cleared).toEqual(['guide-1']);
    expect(eventsSent(fetchMock).map((e) => e.eventType)).toEqual(['guide_shown']); // sent as the old visitor
    await engine.onRouteChange('/dashboard');
    expect(callsTo(fetchMock, R.guides)).toHaveLength(guidesBefore);

    await engine.identify({ visitor: { id: 'next-user' } });
    expect(bodyOf(callsTo(fetchMock, R.guides).slice(-1)[0]).visitor).toEqual({ id: 'next-user' });
    expect(rendered).toHaveLength(2);
  });
});
