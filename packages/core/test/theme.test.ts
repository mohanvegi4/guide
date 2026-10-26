import { afterEach, describe, expect, it, vi } from 'vitest';
import { GuideEngine, GuideRenderer, GuideTheme, createDomRenderer, themeProperties } from '../src';
import { R, baseOptions, makeGuide, mockFetch, serving } from './helpers';

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('themeProperties', () => {
  it("matching the site: each value is the page's Bootstrap variable, with ours as the fallback", () => {
    expect(themeProperties({ color: '#1174c3', matchSite: true })).toEqual({
      '--ge-primary': 'var(--bs-primary, #1174c3)',
      '--ge-font': 'var(--bs-body-font-family, system-ui, -apple-system, "Segoe UI", sans-serif)',
      '--ge-text': 'var(--bs-body-color, #111)',
      '--ge-bg': 'var(--bs-body-bg, #fff)',
      '--ge-radius': 'var(--bs-border-radius, 6px)',
    });
  });

  it("not matching: the app's color and Guide Engine's own look", () => {
    expect(themeProperties({ color: '#1174c3', matchSite: false })).toMatchObject({
      '--ge-primary': '#1174c3',
      '--ge-font': 'system-ui, -apple-system, "Segoe UI", sans-serif',
      '--ge-radius': '6px',
    });
  });

  it('never lets anything but a hex color into a style declaration', () => {
    for (const color of ['red; background: url(x)', 'var(--x)', '#12345', '']) {
      expect(themeProperties({ color, matchSite: true })['--ge-primary']).toBe('var(--bs-primary, #4f46e5)');
    }
    expect(themeProperties(null)['--ge-primary']).toBe('#4f46e5');
  });
});

describe('the engine applies the theme from the API', () => {
  it('hands it to the renderer once, and again only when it changes', async () => {
    let theme: GuideTheme = { color: '#1174c3', matchSite: true };
    const answer = () => ({ body: { ...serving(makeGuide({ id: 'a' }))().body, theme } });
    mockFetch({ [R.guides]: answer });
    const setTheme = vi.fn();
    const renderer: GuideRenderer = { renderStep: vi.fn(), clear: vi.fn(), setTheme };
    const engine = new GuideEngine();
    await engine.init(baseOptions, renderer);
    expect(setTheme).toHaveBeenCalledWith({ color: '#1174c3', matchSite: true });

    await engine.onRouteChange();
    expect(setTheme).toHaveBeenCalledTimes(1); // same theme: nothing to redo
    theme = { color: '#1174c3', matchSite: false };
    await engine.onRouteChange();
    expect(setTheme).toHaveBeenLastCalledWith({ color: '#1174c3', matchSite: false });
  });

  it('the DOM renderer puts the variables on the card host and the spotlight, before and after rendering', () => {
    const renderer = createDomRenderer({ advanceStep: vi.fn(), previousStep: vi.fn(), dismissGuide: vi.fn() });
    renderer.setTheme!({ color: '#236192', matchSite: true });
    const guide = makeGuide({ id: 'g' });
    renderer.renderStep(guide, guide.steps[0], null);
    const [card, spotlight] = Array.from(document.querySelectorAll<HTMLElement>('[data-guide-host="g"]'));
    for (const el of [card, spotlight]) {
      expect(el.style.getPropertyValue('--ge-primary')).toBe('var(--bs-primary, #236192)');
    }
    renderer.setTheme!({ color: '#236192', matchSite: false });
    expect(card.style.getPropertyValue('--ge-primary')).toBe('#236192');
  });
});
