import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventQueue, GuideEngine, GuideEventPayload, createDomRenderer, matchesRoute } from '../src';
import {
  API,
  baseOptions,
  callsTo,
  eventsSent,
  fakeRenderer,
  flagsOn,
  flushPromises,
  makeGuide,
  makeStep,
  mockFetch,
} from './helpers';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
  window.history.replaceState({}, '', '/');
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

describe('kill switches (fail closed)', () => {
  it.each([
    ['global switch off', () => ({ body: { globalEnabled: false, tenantEnabled: true } })],
    ['tenant switch off', () => ({ body: { globalEnabled: true, tenantEnabled: false } })],
    ['401 from flag endpoint', () => ({ status: 401, body: { error: 'invalid_token' } })],
    ['500 from flag endpoint', () => ({ status: 500, body: { error: 'internal_error' } })],
    ['malformed flag body', () => ({ body: { something: 'else' } })],
    ['network failure', () => Promise.reject(new TypeError('Failed to fetch'))],
  ])('%s → no guides fetched or rendered, init resolves', async (_name, flagRoute) => {
    window.history.replaceState({}, '', '/dashboard');
    const fetchMock = mockFetch({ '/system/flag': flagRoute, '/guides/active': () => ({ body: [makeGuide()] }) });
    const { renderer, rendered } = fakeRenderer();
    const engine = new GuideEngine();

    await expect(engine.init(baseOptions, renderer)).resolves.toBeUndefined();
    await engine.onRouteChange('/dashboard');

    expect(callsTo(fetchMock, '/guides/active')).toHaveLength(0);
    expect(rendered).toHaveLength(0);
  });

  it('sends the bearer token on every request', async () => {
    const fetchMock = mockFetch({ '/system/flag': flagsOn, '/guides/active': () => ({ body: [] }) });
    await new GuideEngine().init(baseOptions, fakeRenderer().renderer);
    for (const [, init] of fetchMock.mock.calls) {
      expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer token-123');
    }
  });
});

describe('route matching → showing', () => {
  it('renders a guide whose route matches and emits guide_shown', async () => {
    window.history.replaceState({}, '', '/dashboard');
    const guide = makeGuide();
    const fetchMock = mockFetch({
      '/system/flag': flagsOn,
      '/guides/active': () => ({ body: [guide, makeGuide({ id: 'other', routeMatch: { type: 'exact', value: '/settings' } })] }),
      '/events': () => ({ status: 202 }),
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
    const fetchMock = mockFetch({ '/system/flag': flagsOn, '/guides/active': () => ({ body: [makeGuide()] }) });
    const { renderer, rendered } = fakeRenderer();
    const engine = new GuideEngine();

    await engine.init(baseOptions, renderer);
    expect(rendered).toHaveLength(0);

    await engine.onRouteChange('/dashboard?tab=team#x');
    expect(rendered).toHaveLength(1);

    await engine.onRouteChange('/dashboard');
    expect(rendered).toHaveLength(1);
    expect(callsTo(fetchMock, '/guides/active')).toHaveLength(3);
  });

  it('shows nothing (and never throws) when /guides/active returns a non-array', async () => {
    window.history.replaceState({}, '', '/dashboard');
    mockFetch({ '/system/flag': flagsOn, '/guides/active': () => ({ body: { error: 'oops' } }) });
    const { renderer, rendered } = fakeRenderer();
    await expect(new GuideEngine().init(baseOptions, renderer)).resolves.toBeUndefined();
    expect(rendered).toHaveLength(0);
  });
});

describe('step progression', () => {
  it('next → complete emits the full funnel and tears down', async () => {
    window.history.replaceState({}, '', '/dashboard');
    const s1 = makeStep({ id: 's1' });
    const s2 = makeStep({ id: 's2', actions: [{ label: 'Done', action: 'complete' }] });
    const fetchMock = mockFetch({
      '/system/flag': flagsOn,
      '/guides/active': () => ({ body: [makeGuide({ steps: [s1, s2] })] }),
      '/events': () => ({ status: 202 }),
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
      '/system/flag': flagsOn,
      '/guides/active': () => ({ body: [makeGuide({ steps: [makeStep({ id: 's1' })] })] }),
      '/events': () => ({ status: 202 }),
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
    const fetchMock = mockFetch({
      '/system/flag': flagsOn,
      '/guides/active': () => ({ body: [targeted()] }),
      '/events': () => ({ status: 202 }),
    });
    const { renderer, rendered } = fakeRenderer();
    const engine = new GuideEngine();
    await engine.init(baseOptions, renderer);

    // Backoff is 300ms * attempt: 300 + 600 + ... + 3000 = 16.5s for 10 attempts.
    await vi.advanceTimersByTimeAsync(16_000);
    expect(eventsSent(fetchMock).filter((e) => e.eventType === 'guide_error')).toHaveLength(0); // still retrying

    await vi.advanceTimersByTimeAsync(500 + 5000); // final attempt + event flush
    expect(rendered).toHaveLength(0);
    const errors = eventsSent(fetchMock).filter((e) => e.eventType === 'guide_error');
    expect(errors).toEqual([expect.objectContaining({ stepId: 's1', metadata: { reason: 'target_not_found' } })]);

    // Torn down: the guide can be picked up again on a later navigation.
    await engine.onRouteChange('/dashboard');
    expect(callsTo(fetchMock, '/guides/active')).toHaveLength(2);
  });

  it('renders as soon as the target appears mid-retry', async () => {
    mockFetch({ '/system/flag': flagsOn, '/guides/active': () => ({ body: [targeted()] }), '/events': () => ({ status: 202 }) });
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

describe('EventQueue', () => {
  const event = (i: number): GuideEventPayload => ({
    tenantId: 't',
    guideId: 'g',
    guideVersionId: 'v',
    userId: 'u',
    sessionId: 's',
    eventType: 'guide_shown',
    occurredAt: new Date(0).toISOString(),
    metadata: { i },
  });

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });

  it('batches events and flushes once after 5s', async () => {
    const fetchMock = mockFetch({ '/events': () => ({ status: 202 }) });
    const q = new EventQueue(API, () => 'tok');
    q.push(event(1));
    q.push(event(2));
    q.push(event(3));

    await vi.advanceTimersByTimeAsync(4999);
    expect(callsTo(fetchMock, '/events')).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);

    const calls = callsTo(fetchMock, '/events');
    expect(calls).toHaveLength(1);
    expect(JSON.parse(String(calls[0][1]!.body)).events).toHaveLength(3);
    expect((calls[0][1]!.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    expect(calls[0][1]!.keepalive).toBe(true);
  });

  it('flushes immediately at 20 events, in a single POST', async () => {
    const fetchMock = mockFetch({ '/events': () => ({ status: 202 }) });
    const q = new EventQueue(API, () => 'tok');
    for (let i = 0; i < 20; i++) q.push(event(i));
    await flushPromises();

    const calls = callsTo(fetchMock, '/events');
    expect(calls).toHaveLength(1);
    expect(JSON.parse(String(calls[0][1]!.body)).events.map((e: GuideEventPayload) => e.metadata)).toEqual(
      Array.from({ length: 20 }, (_, i) => ({ i }))
    );

    await vi.advanceTimersByTimeAsync(10_000); // the pending timer was cleared: no empty extra POST
    expect(callsTo(fetchMock, '/events')).toHaveLength(1);
  });

  it('drops a batch on network failure without throwing, and keeps working', async () => {
    let fail = true;
    const fetchMock = mockFetch({
      '/events': () => (fail ? Promise.reject(new TypeError('offline')) : { status: 202 }),
    });
    const q = new EventQueue(API, () => 'tok');
    q.push(event(1));
    await expect(vi.advanceTimersByTimeAsync(5000)).resolves.not.toThrow();

    fail = false;
    q.push(event(2));
    await vi.advanceTimersByTimeAsync(5000);
    const last = callsTo(fetchMock, '/events').slice(-1)[0];
    expect(JSON.parse(String(last[1]!.body)).events).toEqual([event(2)]); // failed batch not retried
  });
});

describe('DOM renderer', () => {
  it('renders labels as text, never as HTML', () => {
    const renderer = createDomRenderer({ advanceStep: vi.fn(), dismissGuide: vi.fn() });
    renderer.renderStep(
      makeGuide(),
      makeStep({ actions: [{ label: '<img src=x onerror="window.__pwned=1">Next', action: 'next' }] }),
      null
    );
    const shadow = document.querySelector('[data-guide-host]')!.shadowRoot!;
    const button = shadow.querySelector('button')!;
    expect(button.textContent).toBe('<img src=x onerror="window.__pwned=1">Next');
    expect(shadow.querySelector('.actions img')).toBeNull();
  });

  it('does not re-render in a loop from its own style writes (observer feedback)', async () => {
    window.history.replaceState({}, '', '/dashboard');
    const target = document.createElement('button');
    target.setAttribute('data-guide-id', 'invite-button');
    document.body.appendChild(target);
    mockFetch({
      '/system/flag': flagsOn,
      '/guides/active': () => ({
        // 'top' matters: positionNear() resets then re-sets host.style.transform on
        // every render, so each render genuinely mutates a <body> descendant.
        body: [makeGuide({ steps: [makeStep({ targetSelector: '[data-guide-id="invite-button"]', position: 'top' })] })],
      }),
    });

    const engine = new GuideEngine();
    const real = createDomRenderer({ advanceStep: (id) => engine.advanceStep(id), dismissGuide: (id) => engine.dismissGuide(id) });
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

describe('step change vs. target observer (regression)', () => {
  it("does not re-render the next, untargeted step next to the previous step's target", async () => {
    window.history.replaceState({}, '', '/dashboard');
    const target = document.createElement('button');
    target.setAttribute('data-guide-id', 'invite-button');
    document.body.appendChild(target);
    mockFetch({
      '/system/flag': flagsOn,
      '/guides/active': () => ({
        body: [
          makeGuide({
            steps: [
              makeStep({ id: 's1', targetSelector: '[data-guide-id="invite-button"]' }),
              makeStep({ id: 's2', type: 'modal', position: 'center' }),
            ],
          }),
        ],
      }),
      '/events': () => ({ status: 202 }),
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
      '/system/flag': flagsOn,
      '/guides/active': () => ({
        body: [makeGuide({ steps: [makeStep({ targetSelector: '[data-guide-id="invite-button"]' })] })],
      }),
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
