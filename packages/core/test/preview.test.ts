import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GuideEngine } from '../src/engine';
import { baseOptions, callsTo, fakeRenderer, flagsOn, makeGuide, mockFetch } from './helpers';

describe('preview mode', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/somewhere-else?guidePreview=signed-token');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    window.history.replaceState({}, '', '/');
  });

  it('force-renders the previewed guide regardless of route and active list, and sends no events', async () => {
    const previewGuide = makeGuide({ id: 'draft-guide', routeMatch: { type: 'exact', value: '/not-this-page' } });
    const fetchMock = mockFetch({
      '/system/flag': flagsOn,
      '/preview/guide': () => ({ body: previewGuide }),
      '/guides/active': () => ({ body: [] }),
      '/events': () => ({ status: 202 }),
    });
    const { renderer, rendered } = fakeRenderer();
    const engine = new GuideEngine();

    await engine.init(baseOptions, renderer);

    const [, init] = callsTo(fetchMock, '/preview/guide')[0];
    const headers = init!.headers as Record<string, string>;
    expect(headers['X-Guide-Preview']).toBe('signed-token');
    expect(headers.Authorization).toBe('Bearer token-123');

    expect(rendered).toHaveLength(1);
    expect(rendered[0].guide).toMatchObject({ id: 'draft-guide', preview: true });
    expect(callsTo(fetchMock, '/guides/active')).toHaveLength(0); // normal evaluation skipped

    // Click through the whole guide — analytics must stay clean.
    engine.advanceStep('draft-guide');
    await vi.waitFor(() => expect(callsTo(fetchMock, '/events')).toHaveLength(0));
    await engine.onRouteChange('/dashboard');
    expect(callsTo(fetchMock, '/guides/active')).toHaveLength(0);
  });

  it('falls back silently to normal mode when the backend rejects the token', async () => {
    const active = makeGuide({ routeMatch: { type: 'exact', value: '/somewhere-else' } });
    const fetchMock = mockFetch({
      '/system/flag': flagsOn,
      '/preview/guide': () => ({ status: 403, body: { error: 'invalid_preview_token' } }),
      '/guides/active': () => ({ body: [active] }),
    });
    const { renderer, rendered } = fakeRenderer();

    await expect(new GuideEngine().init(baseOptions, renderer)).resolves.toBeUndefined();

    expect(callsTo(fetchMock, '/guides/active')).toHaveLength(1);
    expect(rendered).toHaveLength(1);
    expect(rendered[0].guide.preview).toBeUndefined();
  });

  it('still honours the kill switch — no preview when the engine is disabled', async () => {
    const fetchMock = mockFetch({
      '/system/flag': () => ({ body: { globalEnabled: false, tenantEnabled: true } }),
      '/preview/guide': () => ({ body: makeGuide() }),
    });
    const { renderer, rendered } = fakeRenderer();
    await new GuideEngine().init(baseOptions, renderer);
    expect(callsTo(fetchMock, '/preview/guide')).toHaveLength(0);
    expect(rendered).toHaveLength(0);
  });
});
