import { afterEach, describe, expect, it, vi } from 'vitest';
import { ERROR_SAMPLE_RATE, GuideEngine, MAX_ERROR_REPORTS_PER_PAGE } from '../src';
import {
  API,
  R,
  baseOptions,
  bodyOf,
  callsTo,
  fakeRenderer,
  flushPromises,
  makeGuide,
  makeStep,
  mockFetch,
  serving,
} from './helpers';

/**
 * Error reporting: what the engine swallows (fail silent) it also reports,
 * sampled and capped, without ever throwing into the host page.
 */

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
  window.history.replaceState({}, '', '/');
  localStorage.clear();
});

/** A renderer whose renderStep throws; clear() works. */
function throwingRenderer(message = 'boom') {
  const { renderer, cleared } = fakeRenderer();
  renderer.renderStep = () => {
    throw new Error(message);
  };
  return { renderer, cleared };
}

const sampledIn = () => vi.spyOn(Math, 'random').mockReturnValue(0);
const sampledOut = () => vi.spyOn(Math, 'random').mockReturnValue(ERROR_SAMPLE_RATE);

describe('error reporting', () => {
  it('reports a renderer failure (sampled in) with message, stack, url and agent version, keepalive', async () => {
    window.history.replaceState({}, '', '/dashboard?tab=1');
    const fetchMock = mockFetch({ [R.guides]: serving(makeGuide()), [R.errors]: () => ({ status: 202 }) });
    sampledIn();
    const { renderer, cleared } = throwingRenderer('renderer exploded');
    const engine = new GuideEngine();
    await expect(engine.init({ ...baseOptions, agentVersion: '9.9.9' }, renderer)).resolves.toBeUndefined();
    await flushPromises();

    const reports = callsTo(fetchMock, R.errors);
    expect(reports).toHaveLength(1);
    const [, init] = reports[0];
    expect(init).toMatchObject({ method: 'POST', keepalive: true, credentials: 'omit' });
    const body = bodyOf(reports[0]);
    expect(body.message).toBe('render: renderer exploded');
    expect(String(body.stack)).toContain('renderer exploded');
    expect(body.url).toBe(`${window.location.origin}/dashboard?tab=1`);
    expect(body.agentVersion).toBe('9.9.9');
    // The identity rides along like on every agent request.
    expect(body.visitor).toEqual({ id: 'user-1' });
    // The broken guide was taken down, not left half-drawn.
    expect(cleared).toEqual(['guide-1']);
  });

  it('sends nothing when sampled out', async () => {
    window.history.replaceState({}, '', '/dashboard');
    const fetchMock = mockFetch({ [R.guides]: serving(makeGuide()), [R.errors]: () => ({ status: 202 }) });
    sampledOut();
    await new GuideEngine().init(baseOptions, throwingRenderer().renderer);
    await flushPromises();
    expect(callsTo(fetchMock, R.errors)).toHaveLength(0);
  });

  it(`sends at most ${MAX_ERROR_REPORTS_PER_PAGE} reports per page load`, async () => {
    window.history.replaceState({}, '', '/dashboard');
    const fetchMock = mockFetch({ [R.guides]: serving(makeGuide()), [R.errors]: () => ({ status: 202 }) });
    sampledIn();
    const engine = new GuideEngine();
    await engine.init(baseOptions, throwingRenderer().renderer);
    // Every navigation re-serves the guide, which fails to render again.
    for (let i = 0; i < 20; i++) await engine.onRouteChange('/dashboard');
    await flushPromises();
    expect(callsTo(fetchMock, R.errors)).toHaveLength(MAX_ERROR_REPORTS_PER_PAGE);
  });

  it('reports a malformed /guides response (e.g. a proxy error page)', async () => {
    const fetchMock = mockFetch({ [R.errors]: () => ({ status: 202 }) });
    fetchMock.mockImplementation(async (input: string | URL | Request) => {
      if (String(input).startsWith(API + R.errors)) return new Response('{}', { status: 202 });
      return new Response('<html>502 Bad Gateway</html>', { status: 200 });
    });
    sampledIn();
    await new GuideEngine().init(baseOptions, fakeRenderer().renderer);
    await flushPromises();
    const reports = callsTo(fetchMock, R.errors);
    expect(reports).toHaveLength(1);
    expect(bodyOf(reports[0]).message).toMatch(/^guides: /);
  });

  it('reports a failure in the renderer click path without throwing', async () => {
    window.history.replaceState({}, '', '/dashboard');
    const guide = makeGuide({ steps: [makeStep(), makeStep()] });
    const fetchMock = mockFetch({ [R.guides]: serving(guide), [R.errors]: () => ({ status: 202 }) });
    sampledIn();
    const { renderer } = fakeRenderer();
    const engine = new GuideEngine();
    await engine.init(baseOptions, renderer);
    renderer.renderStep = () => {
      throw new TypeError('host page replaced document.querySelector');
    };
    expect(() => engine.advanceStep('guide-1')).not.toThrow();
    await flushPromises();
    expect(bodyOf(callsTo(fetchMock, R.errors)[0]).message).toContain('host page replaced');
  });

  it('never throws, even when fetch itself is broken', async () => {
    window.history.replaceState({}, '', '/dashboard');
    const fetchMock = mockFetch({ [R.guides]: serving(makeGuide()) });
    sampledIn();
    const { renderer } = fakeRenderer();
    const engine = new GuideEngine();
    await engine.init(baseOptions, renderer);
    fetchMock.mockImplementation(() => {
      throw new Error('fetch is gone');
    });
    expect(() => engine.reportError(new Error('x'), 'test')).not.toThrow();
    // A rejecting fetch is swallowed too.
    fetchMock.mockImplementation(() => Promise.reject(new Error('offline')));
    expect(() => engine.reportError('a string, not an Error', 'test')).not.toThrow();
    await flushPromises();
  });

  it('does nothing before init (no client yet)', () => {
    const fetchMock = mockFetch({});
    sampledIn();
    expect(() => new GuideEngine().reportError(new Error('early'), 'test')).not.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
