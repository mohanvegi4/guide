import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventQueue, GuideEngine } from '../src';
import {
  API,
  baseOptions,
  callsTo,
  fakeRenderer,
  flagsOn,
  flushPromises,
  makeGuide,
  mockFetch,
} from './helpers';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  window.history.replaceState({}, '', '/');
});

describe('finished guides', () => {
  it('does not re-show a dismissed guide on the next navigation, even before the backend knows', async () => {
    window.history.replaceState({}, '', '/dashboard');
    // The backend keeps returning the guide (its user_guide_state write hasn't landed yet).
    mockFetch({
      '/system/flag': flagsOn,
      '/guides/active': () => ({ body: [makeGuide()] }),
      '/events': () => ({ status: 202 }),
    });
    const { renderer, rendered } = fakeRenderer();
    const engine = new GuideEngine();
    await engine.init(baseOptions, renderer);
    expect(rendered).toHaveLength(1);

    engine.dismissGuide('guide-1');
    await engine.onRouteChange('/dashboard');
    expect(rendered).toHaveLength(1);
  });

  it('shows a newer version of a guide the user finished earlier in the session', async () => {
    window.history.replaceState({}, '', '/dashboard');
    let version = 'version-1';
    mockFetch({
      '/system/flag': flagsOn,
      '/guides/active': () => ({ body: [makeGuide({ versionId: version })] }),
      '/events': () => ({ status: 202 }),
    });
    const { renderer, rendered } = fakeRenderer();
    const engine = new GuideEngine();
    await engine.init(baseOptions, renderer);
    engine.advanceStep('guide-1'); // single step → completed

    version = 'version-2';
    await engine.onRouteChange('/dashboard');
    expect(rendered.map((r) => r.guide.versionId)).toEqual(['version-1', 'version-2']);
  });
});

describe('EventQueue urgent flush', () => {
  it.each(['guide_dismissed', 'guide_completed'] as const)(
    '%s is sent immediately, not after the 5s batch',
    async (eventType) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const fetchMock = mockFetch({ '/events': () => ({ status: 202 }) });
      const q = new EventQueue(API, () => 'tok');
      const base = {
        tenantId: 't',
        guideId: 'g',
        guideVersionId: 'v',
        userId: 'u',
        sessionId: 's',
        occurredAt: '',
      };
      q.push({ ...base, eventType: 'guide_shown' });
      q.push({ ...base, eventType });
      await flushPromises();

      const calls = callsTo(fetchMock, '/events');
      expect(calls).toHaveLength(1);
      expect(
        JSON.parse(String(calls[0][1]!.body)).events.map((e: { eventType: string }) => e.eventType),
      ).toEqual(['guide_shown', eventType]);
    },
  );

  it('flushes queued events on pagehide', async () => {
    const fetchMock = mockFetch({ '/events': () => ({ status: 202 }) });
    const q = new EventQueue(API, () => 'tok');
    q.push({
      tenantId: 't',
      guideId: 'g',
      guideVersionId: 'v',
      userId: 'u',
      sessionId: 'pagehide-test',
      occurredAt: '',
      eventType: 'guide_shown',
    });
    window.dispatchEvent(new Event('pagehide'));
    await flushPromises();
    // Other suites' engines may flush their own leftovers too; look for ours.
    const ours = callsTo(fetchMock, '/events').filter(([, init]) => String(init!.body).includes('pagehide-test'));
    expect(ours).toHaveLength(1);
  });
});
