import type { Guide, GuideRenderer, Step } from './engine';

/**
 * Minimal default renderer using Shadow DOM for style isolation from the
 * host app. This covers tooltip/banner/modal well enough to ship an MVP;
 * swap in a framework-specific renderer later if you want guides built
 * from real Angular/Vue components instead of raw HTML strings.
 */
export function createDomRenderer(engine: {
  advanceStep(guideId: string): void;
  dismissGuide(guideId: string): void;
}): GuideRenderer {
  const hosts = new Map<string, HTMLElement>();

  function ensureHost(guideId: string): { host: HTMLElement; shadow: ShadowRoot } {
    let host = hosts.get(guideId);
    if (!host) {
      host = document.createElement('div');
      host.setAttribute('data-guide-host', guideId);
      host.style.position = 'fixed';
      host.style.zIndex = '2147483000'; // stay above host app UI without going full max
      document.body.appendChild(host);
      hosts.set(guideId, host);
    }
    const shadow = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
    return { host, shadow };
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
      const { host, shadow } = ensureHost(guide.id);
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
      for (const a of step.actions) {
        const btn = document.createElement('button');
        btn.className = a.action === 'dismiss' ? 'secondary' : 'primary';
        btn.textContent = a.label;
        btn.addEventListener('click', () => {
          if (a.action === 'dismiss') engine.dismissGuide(guide.id);
          else if (a.action === 'next' || a.action === 'complete') engine.advanceStep(guide.id);
          // 'back' / 'custom' left as an exercise — wire up per your actions schema
        });
        actionsEl?.appendChild(btn);
      }
    },

    clear(guideId: string) {
      const host = hosts.get(guideId);
      host?.remove();
      hosts.delete(guideId);
    },
  };
}
