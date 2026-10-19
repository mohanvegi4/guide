import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GuideEngine } from '../src/engine';
import { R, baseOptions, bodyOf, callsTo, fakeRenderer, makeGuide, mockFetch, serving } from './helpers';

describe('preview mode', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/somewhere-else?guidePreview=signed-token');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    window.history.replaceState({}, '', '/');
  });

  it('force-renders the previewed guide regardless of route and active list, and sends no events', async () => {
    const previewGuide = makeGuide({
      id: 'draft-guide',
      routeMatch: { type: 'exact', value: '/not-this-page' },
    });
    const fetchMock = mockFetch({
      [R.preview]: () => ({ body: previewGuide }),
      [R.guides]: serving(),
      [R.events]: () => ({ status: 202 }),
    });
    const { renderer, rendered } = fakeRenderer();
    const engine = new GuideEngine();

    await engine.init(baseOptions, renderer);

    expect(bodyOf(callsTo(fetchMock, R.preview)[0])).toMatchObject({ token: 'signed-token' });
    expect(rendered).toHaveLength(1);
    expect(rendered[0].guide).toMatchObject({ id: 'draft-guide', preview: true });
    expect(callsTo(fetchMock, R.guides)).toHaveLength(0); // normal evaluation skipped

    // Click through the whole guide — analytics must stay clean.
    engine.advanceStep('draft-guide');
    await vi.waitFor(() => expect(callsTo(fetchMock, R.events)).toHaveLength(0));
    await engine.onRouteChange('/dashboard');
    expect(callsTo(fetchMock, R.guides)).toHaveLength(0);
  });

  it.each([
    ['rejected token', () => ({ status: 403, body: { error: 'invalid_preview_token' } })],
    ['kill switch / other app (404)', () => ({ status: 404, body: { error: 'not_found' } })],
  ])('falls back silently to normal mode: %s', async (_name, previewRoute) => {
    const active = makeGuide({ routeMatch: { type: 'exact', value: '/somewhere-else' } });
    const fetchMock = mockFetch({ [R.preview]: previewRoute, [R.guides]: serving(active) });
    const { renderer, rendered } = fakeRenderer();

    await expect(new GuideEngine().init(baseOptions, renderer)).resolves.toBeUndefined();

    expect(callsTo(fetchMock, R.guides)).toHaveLength(1);
    expect(rendered).toHaveLength(1);
    expect(rendered[0].guide.preview).toBeUndefined();
  });
});
