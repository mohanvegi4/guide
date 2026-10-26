import { afterEach, describe, expect, it, vi } from 'vitest';
import { GuideEngine, HelpItem, HelpUi } from '../src';
import { KEY, R, baseOptions, fakeRenderer, makeGuide, makeStep, mockFetch, serving } from './helpers';

/**
 * One guide at a time. When several guides match a page, the engine shows
 * one and queues the rest; the queue advances when a guide completes or
 * fails, is emptied when the visitor dismisses one, and is rebuilt on every
 * navigation.
 */

const HELP = `/v1/agent/${KEY}/help`;
const accepted = () => ({ status: 202 });

const tip = makeGuide({
  id: 'tip',
  versionId: 'tip-v1',
  name: 'Invite tip',
  steps: [makeStep({ id: 'tip-s1' })],
});
const tour = makeGuide({
  id: 'tour',
  versionId: 'tour-v1',
  name: 'Welcome tour',
  steps: [makeStep({ id: 'tour-s1' }), makeStep({ id: 'tour-s2' })],
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
  window.history.replaceState({}, '', '/');
  localStorage.clear();
});

async function start(guides: ReturnType<typeof makeGuide>[], help: HelpItem[] = [], helpUi?: HelpUi) {
  window.history.replaceState({}, '', '/dashboard');
  mockFetch({
    [R.guides]: serving(...guides),
    [R.events]: accepted,
    [HELP]: () => ({ body: { enabled: true, button: { label: 'Help', color: '#000' }, guides: help } }),
  });
  const { renderer, rendered, cleared } = fakeRenderer();
  const engine = new GuideEngine();
  await engine.init(baseOptions, renderer, helpUi);
  return { engine, cleared, shown: () => rendered.map((r) => `${r.guide.id}:${r.step.id}`) };
}

describe('one guide at a time', () => {
  it('shows the walkthrough first, whatever order the server sent, and the tip once it completes', async () => {
    const { engine, shown } = await start([tip, tour]);
    expect(shown()).toEqual(['tour:tour-s1']);

    engine.advanceStep('tour');
    expect(shown()).toEqual(['tour:tour-s1', 'tour:tour-s2']);
    engine.advanceStep('tour'); // completes the tour
    expect(shown()).toEqual(['tour:tour-s1', 'tour:tour-s2', 'tip:tip-s1']);
  });

  it('after a dismissal nothing else pops up until the next navigation', async () => {
    const { engine, shown } = await start([tour, tip]);
    engine.dismissGuide('tour');
    expect(shown()).toEqual(['tour:tour-s1']);

    await engine.onRouteChange('/dashboard');
    expect(shown()).toEqual(['tour:tour-s1', 'tip:tip-s1']); // the tour stays dismissed
  });

  it('a guide whose target never appears gives its turn to the next one', async () => {
    vi.useFakeTimers();
    const orphan = makeGuide({
      id: 'orphan',
      versionId: 'orphan-v1',
      steps: [makeStep({ id: 'o-s1', targetSelector: '[data-guide-id="never"]' })],
    });
    const { shown } = await start([orphan, tip]);
    expect(shown()).toEqual([]); // waiting for the orphan's target

    await vi.advanceTimersByTimeAsync(20_000); // past the retry window
    expect(shown()).toEqual(['tip:tip-s1']);
  });

  it('a tour that spans pages keeps the screen; the next page’s tip waits for it', async () => {
    const teamTip = makeGuide({
      id: 'team-tip',
      versionId: 'team-tip-v1',
      routeMatch: { type: 'exact', value: '/team' },
      steps: [makeStep({ id: 'team-s1' })],
    });
    const { engine, shown } = await start([tour, teamTip]);
    expect(shown()).toEqual(['tour:tour-s1']);

    await engine.onRouteChange('/team');
    expect(shown()).toEqual(['tour:tour-s1']); // tour still up, team tip queued

    engine.advanceStep('tour');
    engine.advanceStep('tour');
    expect(shown()).toEqual(['tour:tour-s1', 'tour:tour-s2', 'team-tip:team-s1']);
  });

  it('an explicit help launch takes the screen, and the automatic guide returns once it is done', async () => {
    const item: HelpItem = {
      ...makeGuide({ id: 'how-to', versionId: 'how-to-v1', steps: [makeStep({ id: 'h-s1' })] }),
      help: { title: 'How to invite', description: '', keywords: [], startPath: '/dashboard' },
    };
    const ui: HelpUi = {
      update: () => undefined,
      open: () => undefined,
      close: () => undefined,
      isOpen: () => false,
    };
    const { engine, cleared, shown } = await start([tour], [item], ui);
    expect(shown()).toEqual(['tour:tour-s1']);

    engine.launchHelpGuide('how-to');
    expect(cleared).toEqual(['tour']);
    expect(shown()).toEqual(['tour:tour-s1', 'how-to:h-s1']);

    engine.advanceStep('how-to'); // completes the help guide
    expect(shown()).toEqual(['tour:tour-s1', 'how-to:h-s1', 'tour:tour-s1']);
  });
});
