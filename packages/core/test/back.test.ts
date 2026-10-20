import { afterEach, describe, expect, it, vi } from 'vitest';
import { GuideEngine, createDomRenderer } from '../src';
import { R, baseOptions, eventsSent, fakeRenderer, makeGuide, makeStep, mockFetch, serving } from './helpers';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
  window.history.replaceState({}, '', '/');
});

const BACK = { label: 'Back', action: 'back' } as const;
const NEXT = { label: 'Next', action: 'next' } as const;

function threeSteps() {
  return makeGuide({
    steps: [
      makeStep({ id: 's1', actions: [BACK, NEXT] }),
      makeStep({ id: 's2', actions: [BACK, NEXT] }),
      makeStep({ id: 's3', actions: [BACK, { label: 'Done', action: 'complete' }] }),
    ],
  });
}

describe('previousStep', () => {
  it('shows the previous step again as a step view, never as a completion or a new start', async () => {
    window.history.replaceState({}, '', '/dashboard');
    const fetchMock = mockFetch({ [R.guides]: serving(threeSteps()), [R.events]: () => ({ status: 202 }) });
    const { renderer, rendered, cleared } = fakeRenderer();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const engine = new GuideEngine();
    await engine.init(baseOptions, renderer);

    engine.advanceStep('guide-1');
    engine.advanceStep('guide-1');
    engine.previousStep('guide-1');
    engine.previousStep('guide-1');
    engine.previousStep('guide-1'); // on the first step: nothing to go back to
    await vi.advanceTimersByTimeAsync(5000);

    expect(rendered.map((r) => r.step.id)).toEqual(['s1', 's2', 's3', 's2', 's1']);
    expect(cleared).toEqual([]); // the guide is still running
    expect(eventsSent(fetchMock).map((e) => [e.eventType, e.stepId])).toEqual([
      ['guide_shown', 's1'],
      ['guide_step_completed', 's1'],
      ['guide_step_viewed', 's2'],
      ['guide_step_completed', 's2'],
      ['guide_step_viewed', 's3'],
      ['guide_step_viewed', 's2'],
      ['guide_step_viewed', 's1'], // back on the first step: a view, not a second guide_shown
    ]);

    // Going forward again completes the step as usual.
    engine.advanceStep('guide-1');
    expect(rendered.map((r) => r.step.id).slice(-1)).toEqual(['s2']);
  });

  it('ignores unknown guides', () => {
    expect(() => new GuideEngine().previousStep('nope')).not.toThrow();
  });

  it('shows a targeted previous step whose anchor is gone centered, then re-anchors when it returns', async () => {
    window.history.replaceState({}, '', '/dashboard');
    const anchor = document.createElement('button');
    anchor.setAttribute('data-guide-id', 'a');
    document.body.appendChild(anchor);
    const guide = makeGuide({
      steps: [
        makeStep({ id: 's1', targetSelector: '[data-guide-id="a"]', actions: [NEXT] }),
        makeStep({ id: 's2', actions: [BACK] }),
      ],
    });
    mockFetch({ [R.guides]: serving(guide), [R.events]: () => ({ status: 202 }) });
    const { renderer, rendered } = fakeRenderer();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const engine = new GuideEngine();
    await engine.init(baseOptions, renderer);
    engine.advanceStep('guide-1');
    anchor.remove();

    engine.previousStep('guide-1');
    // The visitor asked for it, so it shows at once — centered, the anchor being gone.
    expect(rendered.map((r) => [r.step.id, r.target])).toEqual([
      ['s1', anchor],
      ['s2', null],
      ['s1', null],
    ]);
    vi.useRealTimers();
    document.body.appendChild(anchor);
    await vi.waitFor(() => expect(rendered).toHaveLength(4));
    expect(rendered[3]).toMatchObject({ step: { id: 's1' }, target: anchor });
  });
});

describe('DOM renderer back button', () => {
  function render(guide = threeSteps(), stepIndex = 0) {
    const engine = { advanceStep: vi.fn(), previousStep: vi.fn(), dismissGuide: vi.fn() };
    createDomRenderer(engine).renderStep(guide, guide.steps[stepIndex], null);
    const shadow = document.querySelector('[data-guide-host]')!.shadowRoot!;
    const back = Array.from(shadow.querySelectorAll('button')).find((b) => b.textContent === 'Back')!;
    return { engine, back };
  }

  it('is disabled on the first step and does nothing when clicked', () => {
    const { engine, back } = render();
    expect(back.disabled).toBe(true);
    expect(back.className).toBe('secondary');
    back.click();
    expect(engine.previousStep).not.toHaveBeenCalled();
  });

  it('goes back from any later step', () => {
    const { engine, back } = render(threeSteps(), 1);
    expect(back.disabled).toBe(false);
    back.click();
    expect(engine.previousStep).toHaveBeenCalledWith('guide-1');
    expect(engine.advanceStep).not.toHaveBeenCalled();
  });

  it('end to end: clicking Back re-renders the previous step', async () => {
    window.history.replaceState({}, '', '/dashboard');
    mockFetch({ [R.guides]: serving(threeSteps()), [R.events]: () => ({ status: 202 }) });
    const engine = new GuideEngine();
    const renderer = createDomRenderer({
      advanceStep: (id) => engine.advanceStep(id),
      previousStep: (id) => engine.previousStep(id),
      dismissGuide: (id) => engine.dismissGuide(id),
    });
    await engine.init(baseOptions, renderer);
    const shadow = () => document.querySelector('[data-guide-host]')!.shadowRoot!;
    const button = (label: string) =>
      Array.from(shadow().querySelectorAll('button')).find((b) => b.textContent === label)!;

    button('Next').click();
    expect(button('Back').disabled).toBe(false);
    button('Back').click();
    expect(button('Back').disabled).toBe(true); // first step again
    expect(button('Next')).toBeDefined();
  });
});
