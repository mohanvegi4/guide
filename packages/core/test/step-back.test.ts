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
  const dimmed = () => spotlight.style.boxShadow.includes('100vmax');
  const faded = () => card.style.opacity === '0.25' && card.style.pointerEvents === 'none';
  return { target, render, card, spotlight, dimmed, faded, renderer };
}

/** Pretends `el` sits at this place on screen (jsdom has no layout). */
function placeAt(el: Element, rect: Partial<DOMRect>): void {
  const full = { top: 0, left: 0, width: 0, height: 0, ...rect };
  const box = { ...full, right: full.left + full.width, bottom: full.top + full.height, x: full.left, y: full.top };
  el.getBoundingClientRect = () => ({ ...box, toJSON: () => box }) as DOMRect;
}

describe('the guide steps back while the visitor uses the element', () => {
  it('lifts the dim while focus is in the element, and brings it back when focus leaves', () => {
    const { target, dimmed, faded } = setup('<input id="target" data-guide-id="target" />');
    expect(dimmed()).toBe(true);
    target.focus();
    expect(dimmed()).toBe(false);
    expect(faded()).toBe(false); // typing alone: the card stays readable
    target.blur();
    expect(dimmed()).toBe(true);
  });

  it('fades the card and lets clicks through while a popup is open, and restores both when it closes', () => {
    const { target, render, dimmed, faded } = setup(
      '<button id="target" data-guide-id="target" aria-haspopup="listbox" aria-expanded="false">Branch</button>',
    );
    target.setAttribute('aria-expanded', 'true');
    render(); // the engine re-renders on the attribute change
    expect(faded()).toBe(true);
    expect(dimmed()).toBe(false);
    target.setAttribute('aria-expanded', 'false');
    render();
    expect(faded()).toBe(false);
    expect(dimmed()).toBe(true);
  });

  it('counts focus inside a popup the element owns (options rendered elsewhere, like a CDK overlay)', () => {
    const { dimmed } = setup(`
      <input id="target" data-guide-id="target" role="combobox" aria-controls="options" />
      <div id="elsewhere"><ul id="options" role="listbox"><li tabindex="-1" id="opt">Branch 1400</li></ul></div>`);
    document.getElementById('opt')!.focus();
    expect(dimmed()).toBe(false);
  });

  it('a press on a part that takes no focus engages it; a press elsewhere releases it', () => {
    const { target, dimmed } = setup('<div id="target" data-guide-id="target"><span id="inner">Pick</span></div><p id="out">x</p>');
    document.getElementById('inner')!.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(dimmed()).toBe(false);
    document.getElementById('out')!.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(dimmed()).toBe(true);
    expect(target.isConnected).toBe(true);
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
