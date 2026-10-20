import type { Guide, GuideRenderer, Step } from './engine';

const SPOTLIGHT_RING = '#4f46e5';
const SPOTLIGHT_DIM = 'rgba(15, 23, 42, 0.3)';
const SPOTLIGHT_PAD = 4;

/**
 * Minimal default renderer using Shadow DOM for style isolation from the
 * host app. This covers tooltip/banner/modal well enough to ship an MVP;
 * swap in a framework-specific renderer later if you want guides built
 * from real Angular/Vue components instead of raw HTML strings.
 *
 * A targeted step also puts the visitor's focus on its element: it is
 * scrolled into view (once per step, so we never fight their scrolling) and
 * spotlighted — a ring around it with the rest of the page dimmed. The
 * spotlight ignores pointer events, so the element stays clickable.
 */
export function createDomRenderer(engine: {
  advanceStep(guideId: string): void;
  previousStep(guideId: string): void;
  dismissGuide(guideId: string): void;
}): GuideRenderer {
  const hosts = new Map<string, { host: HTMLElement; spotlight: HTMLElement }>();
  /** guideId -> step id last scrolled to, so re-renders (the target moving) don't scroll again. */
  const scrolledTo = new Map<string, string>();
  /**
   * Targeted steps on screen, so the card and spotlight can follow their
   * element when the page scrolls or the window resizes. Both are
   * position:fixed, placed from the element's rect at render time: without
   * this, a scroll — including the smooth scrollIntoView that brings the
   * element into view, which animates over several frames — leaves them
   * where the element used to be, often off screen.
   */
  const tracked = new Map<string, { step: Step; target: Element; renderedAt: number; rescrolled: boolean }>();
  let listening = false;
  let repositionScheduled = false;
  /** How long after rendering a step the page's own scrolling may still move the anchor away (ms). */
  const SETTLE_MS = 2000;

  function reposition(): void {
    for (const [guideId, entry] of tracked) {
      const hostEntry = hosts.get(guideId);
      const { step, target } = entry;
      if (!hostEntry || !target.isConnected) continue;
      spotlightTarget(hostEntry.spotlight, target);
      positionNear(hostEntry.host, target, step.position);
      // Host pages often scroll right after a page renders (restoring a
      // position, bringing a results table into view). If that takes the
      // anchor off screen within moments of the step appearing, bring it back
      // — once, so we never fight the visitor's own scrolling.
      if (!entry.rescrolled && Date.now() - entry.renderedAt < SETTLE_MS && !inViewport(target)) {
        entry.rescrolled = true;
        target.scrollIntoView?.({ block: 'center', inline: 'nearest' });
      }
    }
  }
  function inViewport(el: Element): boolean {
    const r = el.getBoundingClientRect();
    return r.top >= 0 && r.left >= 0 && r.bottom <= window.innerHeight && r.right <= window.innerWidth;
  }
  function onViewportChange(): void {
    if (repositionScheduled) return;
    repositionScheduled = true;
    requestAnimationFrame(() => {
      repositionScheduled = false;
      reposition();
    });
  }
  function track(guideId: string, step: Step, target: Element | null): void {
    const previous = tracked.get(guideId);
    if (!target) tracked.delete(guideId);
    else if (previous && previous.step === step && previous.target === target)
      return; // a re-render, not a new step
    else tracked.set(guideId, { step, target, renderedAt: Date.now(), rescrolled: false });
    syncListeners();
  }
  function untrack(guideId: string): void {
    tracked.delete(guideId);
    syncListeners();
  }
  function syncListeners(): void {
    if (tracked.size > 0 && !listening) {
      // Capture: scroll events of inner scroll containers don't bubble.
      window.addEventListener('scroll', onViewportChange, { capture: true, passive: true });
      window.addEventListener('resize', onViewportChange, { passive: true });
      listening = true;
    } else if (tracked.size === 0 && listening) {
      window.removeEventListener('scroll', onViewportChange, { capture: true });
      window.removeEventListener('resize', onViewportChange);
      listening = false;
    }
  }

  function ensureHost(guideId: string): { host: HTMLElement; spotlight: HTMLElement; shadow: ShadowRoot } {
    let entry = hosts.get(guideId);
    if (!entry) {
      const host = document.createElement('div');
      host.setAttribute('data-guide-host', guideId);
      host.style.position = 'fixed';
      host.style.zIndex = '2147483000'; // stay above host app UI without going full max
      // The spotlight is a sibling (the card host is transformed, which would
      // break position:fixed inside it). It carries data-guide-host too, so
      // the engine's target observer ignores its style writes like the card's.
      const spotlight = document.createElement('div');
      spotlight.setAttribute('data-guide-host', guideId);
      spotlight.setAttribute('data-guide-spotlight', '');
      spotlight.setAttribute('aria-hidden', 'true');
      Object.assign(spotlight.style, {
        position: 'fixed',
        zIndex: '2147482999', // just under the card
        pointerEvents: 'none',
        borderRadius: '6px',
        boxShadow: `0 0 0 3px ${SPOTLIGHT_RING}, 0 0 0 100vmax ${SPOTLIGHT_DIM}`,
        transition: 'top .15s, left .15s, width .15s, height .15s',
        display: 'none',
      } satisfies Partial<CSSStyleDeclaration>);
      document.body.appendChild(host);
      document.body.appendChild(spotlight);
      entry = { host, spotlight };
      hosts.set(guideId, entry);
    }
    const shadow = entry.host.shadowRoot ?? entry.host.attachShadow({ mode: 'open' });
    return { ...entry, shadow };
  }

  /** Draws the ring around the target (with 4px of breathing room), or hides it for untargeted steps. */
  function spotlightTarget(spotlight: HTMLElement, targetEl: Element | null): void {
    if (!targetEl) {
      spotlight.style.display = 'none';
      return;
    }
    const rect = targetEl.getBoundingClientRect();
    Object.assign(spotlight.style, {
      display: 'block',
      top: `${rect.top - SPOTLIGHT_PAD}px`,
      left: `${rect.left - SPOTLIGHT_PAD}px`,
      width: `${rect.width + SPOTLIGHT_PAD * 2}px`,
      height: `${rect.height + SPOTLIGHT_PAD * 2}px`,
    });
  }

  /** Brings an off-screen target into view, once per step. */
  function scrollToTarget(guide: Guide, step: Step, targetEl: Element): void {
    if (scrolledTo.get(guide.id) === step.id) return;
    scrolledTo.set(guide.id, step.id);
    const rect = targetEl.getBoundingClientRect();
    const visible =
      rect.top >= 0 && rect.left >= 0 && rect.bottom <= window.innerHeight && rect.right <= window.innerWidth;
    if (!visible) targetEl.scrollIntoView?.({ block: 'center', inline: 'nearest' });
  }

  function positionNear(host: HTMLElement, targetEl: Element | null, position: Step['position']): void {
    if (!targetEl) {
      // center of viewport for modals / untargeted steps
      host.style.top = '50%';
      host.style.left = '50%';
      host.style.transform = 'translate(-50%, -50%)';
      return;
    }
    const rect = targetEl.getBoundingClientRect();
    host.style.transform = '';
    switch (position) {
      case 'top':
        host.style.top = `${rect.top - 8}px`;
        host.style.left = `${rect.left}px`;
        host.style.transform = 'translateY(-100%)';
        break;
      case 'bottom':
      default:
        host.style.top = `${rect.bottom + 8}px`;
        host.style.left = `${rect.left}px`;
        break;
      case 'left':
        host.style.top = `${rect.top}px`;
        host.style.left = `${rect.left - 8}px`;
        host.style.transform = 'translateX(-100%)';
        break;
      case 'right':
        host.style.top = `${rect.top}px`;
        host.style.left = `${rect.right + 8}px`;
        break;
    }
    keepOnScreen(host);
  }

  /**
   * Nudges the card back inside the viewport. An anchor near an edge would
   * otherwise push the card off screen, and an anchor the host page scrolled
   * out of view (a scroll container moving after render, say) would take the
   * card with it — leaving the visitor with no buttons to press. The
   * spotlight stays on the element; only the card is kept reachable.
   */
  function keepOnScreen(host: HTMLElement): void {
    const margin = 8;
    const r = host.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return; // not laid out (tests, display:none)
    const dx = Math.min(0, window.innerWidth - margin - r.right) + Math.max(0, margin - r.left);
    const dy = Math.min(0, window.innerHeight - margin - r.bottom) + Math.max(0, margin - r.top);
    if (dx) host.style.left = `${parseFloat(host.style.left) + dx}px`;
    if (dy) host.style.top = `${parseFloat(host.style.top) + dy}px`;
  }

  /** guideId -> the step whose card is currently built in the shadow root. */
  const builtStep = new Map<string, string>();

  return {
    renderStep(guide: Guide, step: Step, targetEl: Element | null) {
      const { host, spotlight, shadow } = ensureHost(guide.id);
      if (targetEl) scrollToTarget(guide, step, targetEl);
      spotlightTarget(spotlight, targetEl);
      positionNear(host, targetEl, step.position);
      track(guide.id, step, targetEl);

      // The engine re-renders a step whenever the host page's DOM changes, so
      // the card can follow an element that moved or was re-mounted. That must
      // only move the card: rebuilding it would replace its buttons under the
      // visitor's cursor, and a page that mutates constantly (ripples, timers,
      // live regions) would make a real click — mousedown, then mouseup on
      // what is by then a different button — never register.
      if (builtStep.get(guide.id) === step.id) return;
      builtStep.set(guide.id, step.id);

      // NOTE: step.content is expected to already be sanitized server-side
      // (see docx/authoring-studio sanitization requirement in the scope doc).
      // Do not relax this assumption in the renderer.
      shadow.innerHTML = `
        <style>
          .card { font-family: system-ui, sans-serif; background: #fff; color: #111;
                  border-radius: 8px; box-shadow: 0 4px 20px rgba(0,0,0,0.15);
                  padding: 16px; max-width: 320px; }
          .actions { display: flex; gap: 8px; margin-top: 12px; justify-content: flex-end; }
          button { border: none; border-radius: 6px; padding: 6px 12px; cursor: pointer; font-size: 14px; }
          .primary { background: #4f46e5; color: #fff; }
          .secondary { background: #f3f4f6; color: #111; }
          button:disabled { opacity: .5; cursor: default; }
          .preview-badge { display: inline-block; margin-bottom: 8px; padding: 1px 8px; border-radius: 999px;
                           background: #fef0c7; color: #7a2e0e; font-size: 11px; font-weight: 600; }
          .close { position: absolute; top: 6px; right: 6px; width: 28px; height: 28px; padding: 0;
                   border-radius: 999px; background: none; color: #6b7280; font-size: 18px; line-height: 1; }
          .close:hover, .close:focus-visible { background: #f3f4f6; color: #111; outline: none; }
          .card { position: relative; padding-right: 36px; }
        </style>
        <div class="card">
          ${guide.preview ? '<div class="preview-badge">Preview — only you can see this</div>' : ''}
          <div class="content">${step.content}</div>
          <div class="actions"></div>
        </div>
      `;

      // Every step has a way out, whatever buttons the author chose: a close
      // control in the corner, and Escape. Both dismiss the guide (it's
      // remembered as dismissed, like a "Maybe later" button).
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'close';
      close.setAttribute('aria-label', 'Close guide');
      close.title = 'Close guide';
      close.textContent = '×';
      close.addEventListener('click', () => engine.dismissGuide(guide.id));
      shadow.querySelector('.card')!.prepend(close);
      host.onkeydown = (e: KeyboardEvent) => {
        if (e.key === 'Escape') engine.dismissGuide(guide.id);
      };

      // Buttons are built with DOM APIs, not string interpolation: labels and
      // action names come from guide data, and interpolating them into
      // innerHTML would bypass the server-side content sanitization.
      const actionsEl = shadow.querySelector('.actions');
      // On the first step a "Back" button is shown but disabled: authors
      // usually give every step the same buttons, and a button that vanishes
      // on one step would shift the others around.
      const firstStep = guide.steps[0]?.id === step.id;
      for (const a of step.actions) {
        const btn = document.createElement('button');
        btn.className = a.action === 'dismiss' || a.action === 'back' ? 'secondary' : 'primary';
        btn.textContent = a.label;
        if (a.action === 'back' && firstStep) btn.disabled = true;
        btn.addEventListener('click', () => {
          if (a.action === 'dismiss') engine.dismissGuide(guide.id);
          else if (a.action === 'next' || a.action === 'complete') engine.advanceStep(guide.id);
          else if (a.action === 'back') engine.previousStep(guide.id);
          // 'custom' left as an exercise — wire up per your actions schema
        });
        actionsEl?.appendChild(btn);
      }
    },

    clear(guideId: string) {
      const entry = hosts.get(guideId);
      entry?.host.remove();
      entry?.spotlight.remove();
      hosts.delete(guideId);
      scrolledTo.delete(guideId);
      builtStep.delete(guideId);
      untrack(guideId);
    },
  };
}
