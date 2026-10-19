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
  }

  return {
    renderStep(guide: Guide, step: Step, targetEl: Element | null) {
      const { host, spotlight, shadow } = ensureHost(guide.id);
      if (targetEl) scrollToTarget(guide, step, targetEl);
      spotlightTarget(spotlight, targetEl);
      positionNear(host, targetEl, step.position);

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
        </style>
        <div class="card">
          ${guide.preview ? '<div class="preview-badge">Preview — only you can see this</div>' : ''}
          <div class="content">${step.content}</div>
          <div class="actions"></div>
        </div>
      `;

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
    },
  };
}
