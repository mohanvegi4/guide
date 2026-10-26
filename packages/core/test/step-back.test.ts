import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDomRenderer } from '../src';
import { makeGuide, makeStep } from './helpers';

afterEach(() => {
  document.body.innerHTML = '';
});

function setup(html: string, position?: 'bottom' | 'top' | 'left' | 'right') {
  document.body.insertAdjacentHTML('beforeend', html);
  const target = document.querySelector<HTMLElement>('#target')!;
  const renderer = createDomRenderer({ advanceStep: vi.fn(), previousStep: vi.fn(), dismissGuide: vi.fn() });
  const step = makeStep({ targetSelector: '[data-guide-id="target"]', position });
  const guide = makeGuide({ id: 'g', steps: [step] });
  const render = () => renderer.renderStep(guide, step, target);
  render();
  const [card, spotlight] = Array.from(document.querySelectorAll<HTMLElement>('[data-guide-host="g"]'));
  const faded = () => card.style.opacity === '0.25' && card.style.pointerEvents === 'none';
  return { target, render, card, spotlight, faded, renderer };
}

/** Pretends `el` sits at this place on screen (jsdom has no layout). */
function placeAt(el: Element, rect: Partial<DOMRect>): void {
  const full = { top: 0, left: 0, width: 0, height: 0, ...rect };
  const box = { ...full, right: full.left + full.width, bottom: full.top + full.height, x: full.left, y: full.top };
  el.getBoundingClientRect = () => ({ ...box, toJSON: () => box }) as DOMRect;
}

describe('the spotlight and open popups', () => {
  it('rings the element and never dims the page, focused or not', () => {
    const { target, spotlight } = setup('<input id="target" data-guide-id="target" />');
    const dimmed = () => spotlight.style.boxShadow.includes('100vmax');
    expect(spotlight.style.boxShadow).toContain('var(--ge-primary');
    expect(dimmed()).toBe(false);
    target.focus();
    expect(dimmed()).toBe(false);
  });

  it('while a popup is open the card stays readable, fading only if it would cover the options', () => {
    const { target, render, card, faded } = setup(`
      <button id="target" data-guide-id="target" aria-haspopup="listbox" aria-expanded="false"
        aria-controls="options">Branch</button>
      <ul id="options" role="listbox"><li>Branch 1400</li></ul>`);
    const options = document.getElementById('options')!;
    placeAt(options, { top: 240, left: 100, width: 220, height: 120 }); // opens below the control
    target.setAttribute('aria-expanded', 'true');

    placeAt(card, { top: 60, left: 100, width: 320, height: 140 }); // the card above it
    render(); // the engine re-renders on the attribute change
    expect(faded()).toBe(false);

    placeAt(card, { top: 200, left: 100, width: 320, height: 140 }); // no room: the card ends up over the list
    render();
    expect(faded()).toBe(true);

    target.setAttribute('aria-expanded', 'false');
    render();
    expect(faded()).toBe(false);
  });

  it('never fades the centered card of an untargeted step', () => {
    const renderer = createDomRenderer({ advanceStep: vi.fn(), previousStep: vi.fn(), dismissGuide: vi.fn() });
    const step = makeStep();
    renderer.renderStep(makeGuide({ id: 'u', steps: [step] }), step, null);
    const card = document.querySelector<HTMLElement>('[data-guide-host="u"]:not([data-guide-spotlight])')!;
    expect(card.style.opacity).toBe('');
  });
});

describe('placing the card next to a control that opens popups', () => {
  it('goes above an input (its list opens below), when there is room', () => {
    const { card, render } = setup('<input id="target" data-guide-id="target" />');
    placeAt(document.getElementById('target')!, { top: 400, left: 100, width: 200, height: 32 });
    render();
    expect(card.style.transform).toBe('translateY(-100%)');
    expect(card.style.top).toBe('392px');
  });

  it('goes beside it when there is no room above, and keeps an author-chosen side', () => {
    const { card, render } = setup('<select id="target" data-guide-id="target"></select>');
    placeAt(document.getElementById('target')!, { top: 20, left: 100, width: 200, height: 32 });
    render();
    expect(card.style.left).toBe('308px'); // right of it: 100 + 200 + 8
    expect(card.style.transform).toBe('');

    document.body.innerHTML = '';
    const chosen = setup('<input id="target" data-guide-id="target" />', 'left');
    placeAt(document.getElementById('target')!, { top: 400, left: 500, width: 200, height: 32 });
    chosen.render();
    expect(chosen.card.style.transform).toBe('translateX(-100%)');
  });

  it('leaves other elements below, as before', () => {
    const { card, render } = setup('<button id="target" data-guide-id="target">Save</button>');
    placeAt(document.getElementById('target')!, { top: 400, left: 100, width: 80, height: 32 });
    render();
    expect(card.style.top).toBe('440px');
    expect(card.style.transform).toBe('');
  });
});
