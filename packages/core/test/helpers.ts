import { vi } from 'vitest';
import type { Guide, GuideRenderer, SdkInitOptions, Step } from '../src/engine';

export const API = 'https://api.test';

export const baseOptions: SdkInitOptions = {
  tenantId: 'tenant-a',
  userId: 'user-1',
  apiBaseUrl: API,
  getAuthToken: () => 'token-123',
};

export function makeStep(overrides: Partial<Step> = {}): Step {
  return {
    id: `step-${Math.random().toString(36).slice(2)}`,
    order: 0,
    type: 'tooltip',
    content: '<p>Hi</p>',
    actions: [{ label: 'Next', action: 'next' }],
    ...overrides,
  };
}

export function makeGuide(overrides: Partial<Guide> = {}): Guide {
  return {
    id: 'guide-1',
    versionId: 'version-1',
    tenantId: 'tenant-a',
    isGlobal: false,
    name: 'Welcome',
    type: 'tooltip',
    steps: [makeStep()],
    routeMatch: { type: 'exact', value: '/dashboard' },
    ...overrides,
  };
}

/** Records renderer calls instead of touching the DOM. */
export function fakeRenderer() {
  const rendered: Array<{ guide: Guide; step: Step; target: Element | null }> = [];
  const cleared: string[] = [];
  const renderer: GuideRenderer = {
    renderStep: (guide, step, target) => rendered.push({ guide, step, target }),
    clear: (id) => cleared.push(id),
  };
  return { renderer, rendered, cleared };
}

type Route = (url: string, init?: RequestInit) => { status?: number; body?: unknown } | Promise<never>;

/**
 * Stubs global fetch with a tiny router: `routes` maps a path prefix (after
 * the API base) to a responder. Unmatched requests return 404.
 */
export function mockFetch(routes: Record<string, Route>) {
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const path = url.startsWith(API) ? url.slice(API.length) : url;
    const key = Object.keys(routes).find((k) => path.startsWith(k));
    const out = key ? await routes[key](url, init) : { status: 404, body: { error: 'not_found' } };
    const status = out.status ?? 200;
    return new Response(JSON.stringify(out.body ?? {}), { status, headers: { 'Content-Type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

export const flagsOn = () => ({ body: { globalEnabled: true, tenantEnabled: true } });

/** Calls made to a given path prefix. */
export function callsTo(fetchMock: ReturnType<typeof mockFetch>, prefix: string) {
  return fetchMock.mock.calls.filter(([u]) => String(u).startsWith(API + prefix));
}

/** Let pending promise callbacks (fetch -> json -> state updates) run. */
export async function flushPromises(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

/** All analytics events the SDK POSTed to /events, in order. */
export function eventsSent(fetchMock: ReturnType<typeof mockFetch>): Array<{ eventType: string; stepId?: string; metadata?: unknown }> {
  return callsTo(fetchMock, '/events').flatMap(([, init]) => JSON.parse(String(init!.body)).events);
}
