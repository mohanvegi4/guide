import { matchesRoute } from './engine';
import type { HelpButtonSettings, HelpItem, HelpPosition, HelpUi } from './engine';

const POSITIONS: ReadonlySet<string> = new Set([
  'bottom-right',
  'bottom-left',
  'top-right',
  'top-left',
  'center',
]);

/**
 * Default help-center UI: a floating "Help" button (bottom right) that opens
 * a dialog listing the visitor's help guides, with search. Picking one calls
 * onSelect (the engine then starts it here, or sends the visitor to its page).
 *
 * Topics that live on another page say so in the list ("Opens on /team"),
 * and picking one shows a confirmation modal first — leaving is a page load,
 * which can drop unsaved work — with "Take me there" / "Stay here"; staying
 * returns to the list.
 *
 * Placement comes from the app's settings (data-ge-pos on the host): the list
 * and the confirmation sit in one of the four corners, or mid-screen; the
 * floating button sits in that corner (bottom right when centered).
 *
 * Lives in a Shadow DOM so host-page CSS can't break it (or vice versa).
 * Everything from the server goes in via textContent — never innerHTML — and
 * the button color is applied only if it's a plain hex value.
 *
 * Accessible: role="dialog" + aria-modal, labelled; focus moves into the
 * search box on open and back to whatever opened it on close; ↑/↓ move
 * through results, Enter starts one, Esc closes; clicking outside closes.
 * The confirmation is an alertdialog with focus on "Take me there".
 */
export function createHelpWidget(options: { onSelect(item: HelpItem): void }): HelpUi {
  let items: HelpItem[] = [];
  let button: HelpButtonSettings = { label: 'Help', color: '#4f46e5' };
  let showButton = false;
  let open = false;
  let query = '';
  let active = 0;
  let returnFocus: HTMLElement | null = null;
  /** The pending "leave this page?" question, while the confirmation is showing. */
  let pending: { item: HelpItem; go: () => void } | null = null;

  const host = document.createElement('div');
  host.setAttribute('data-guide-help', '');
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
      .launcher { position: fixed; right: 20px; bottom: 20px; z-index: 2147482000;
        display: inline-flex; align-items: center; gap: 8px; padding: 12px 18px; border: none; border-radius: 999px;
        background: var(--ge-color); color: #fff; font-size: 15px; font-weight: 600; cursor: pointer;
        box-shadow: 0 6px 20px rgba(0,0,0,.18); }
      .launcher:focus-visible, button:focus-visible, input:focus-visible, li:focus-visible { outline: 3px solid #93c5fd; outline-offset: 2px; }
      .launcher .icon { display: inline-grid; place-items: center; width: 20px; height: 20px; border-radius: 50%;
        border: 2px solid currentColor; font-size: 12px; line-height: 1; }
      .backdrop { position: fixed; inset: 0; z-index: 2147482001; background: rgba(15,23,42,.25); }
      .panel { position: fixed; right: 20px; bottom: 80px; z-index: 2147482002;
        width: min(380px, calc(100vw - 32px)); max-height: min(560px, calc(100vh - 120px));
        display: flex; flex-direction: column; background: #fff; color: #111; border-radius: 12px;
        box-shadow: 0 12px 40px rgba(0,0,0,.25); overflow: hidden; }
      /* Corners: the button hugs the corner, the panel opens beside it (80px in from the vertical edge). */
      :host([data-ge-pos="bottom-left"]) .launcher, :host([data-ge-pos="top-left"]) .launcher,
      :host([data-ge-pos="bottom-left"]) .panel, :host([data-ge-pos="top-left"]) .panel { right: auto; left: 20px; }
      :host([data-ge-pos="top-right"]) .launcher, :host([data-ge-pos="top-left"]) .launcher { bottom: auto; top: 20px; }
      :host([data-ge-pos="top-right"]) .panel, :host([data-ge-pos="top-left"]) .panel { bottom: auto; top: 80px; }
      /* Center: the list and the confirmation sit mid-screen; the button keeps its bottom-right corner. */
      :host([data-ge-pos="center"]) .panel { top: 50%; left: 50%; right: auto; bottom: auto;
        transform: translate(-50%, -50%); max-height: calc(100vh - 32px); }
      @media (max-width: 480px) {
        /* Phones: the panel spans the width, hugging the top or bottom edge, or staying centered. */
        .panel { right: 16px; left: 16px; width: auto; max-height: calc(100vh - 32px); }
        :host(:not([data-ge-pos^="top"])) .panel { bottom: 16px; }
        :host([data-ge-pos^="top"]) .panel { top: 16px; }
        :host([data-ge-pos="center"]) .panel { top: 50%; bottom: auto; transform: translateY(-50%); }
      }
      header { display: flex; align-items: center; justify-content: space-between; padding: 16px 16px 8px; }
      h2 { margin: 0; font-size: 17px; }
      .close { border: none; background: none; font-size: 22px; line-height: 1; cursor: pointer; color: #555; padding: 4px 8px; border-radius: 6px; }
      .search { margin: 0 16px 8px; padding: 10px 12px; border: 1px solid #d0d5dd; border-radius: 8px; font-size: 14px; }
      ul { list-style: none; margin: 0; padding: 4px 8px 12px; overflow-y: auto; }
      li { padding: 10px 12px; border-radius: 8px; cursor: pointer; }
      li[aria-selected="true"] { background: #eef2ff; }
      li:hover { background: #f5f7ff; }
      .title { font-weight: 600; font-size: 14px; }
      .desc { font-size: 13px; color: #555; margin-top: 2px; }
      .where { font-size: 12px; color: #6b7280; margin-top: 4px; }
      .where code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
      .empty { padding: 12px 20px 20px; color: #555; font-size: 14px; }
      .confirm { padding: 0 16px 16px; }
      .confirm p { margin: 0 0 16px; font-size: 14px; line-height: 1.5; color: #333; }
      .confirm .buttons { display: flex; gap: 8px; justify-content: flex-end; }
      .confirm button { font: inherit; font-size: 14px; padding: 9px 14px; border-radius: 8px; cursor: pointer;
        border: 1px solid #d0d5dd; background: #fff; color: #111; }
      .confirm .go { background: var(--ge-color); border-color: var(--ge-color); color: #fff; font-weight: 600; }
      [hidden] { display: none !important; }
    </style>
    <button class="launcher" type="button" aria-haspopup="dialog" aria-expanded="false" hidden>
      <span class="icon" aria-hidden="true">?</span><span class="label"></span>
    </button>
    <div class="backdrop" hidden></div>
    <div class="panel" role="dialog" aria-modal="true" aria-labelledby="ge-help-title" hidden>
      <header>
        <h2 id="ge-help-title">How can we help?</h2>
        <button class="close" type="button" aria-label="Close help">×</button>
      </header>
      <input class="search" type="search" placeholder="Search help topics" aria-label="Search help topics"
        role="combobox" aria-controls="ge-help-list" aria-expanded="true" aria-autocomplete="list" />
      <ul id="ge-help-list" role="listbox" aria-label="Help topics"></ul>
      <p class="empty" role="status" hidden></p>
    </div>
    <div class="panel confirm" role="alertdialog" aria-modal="true" aria-labelledby="ge-help-confirm-title"
      aria-describedby="ge-help-confirm-text" hidden>
      <header><h2 id="ge-help-confirm-title">Go to another page?</h2></header>
      <p id="ge-help-confirm-text"></p>
      <div class="buttons">
        <button class="stay" type="button">Stay here</button>
        <button class="go" type="button">Take me there</button>
      </div>
    </div>
  `;

  const launcher = shadow.querySelector<HTMLButtonElement>('.launcher')!;
  const label = shadow.querySelector<HTMLSpanElement>('.label')!;
  const backdrop = shadow.querySelector<HTMLDivElement>('.backdrop')!;
  const panel = shadow.querySelector<HTMLDivElement>('.panel:not(.confirm)')!;
  const close = shadow.querySelector<HTMLButtonElement>('.close')!;
  const search = shadow.querySelector<HTMLInputElement>('.search')!;
  const list = shadow.querySelector<HTMLUListElement>('ul')!;
  const empty = shadow.querySelector<HTMLParagraphElement>('.empty')!;
  const confirm = shadow.querySelector<HTMLDivElement>('.confirm')!;
  const confirmText = shadow.querySelector<HTMLParagraphElement>('#ge-help-confirm-text')!;
  const stayButton = shadow.querySelector<HTMLButtonElement>('.stay')!;
  const goButton = shadow.querySelector<HTMLButtonElement>('.go')!;

  function attach(): void {
    if (!host.isConnected) document.body.appendChild(host);
  }

  function results(): HelpItem[] {
    return filterHelpItems(items, query);
  }

  /** Whether starting `item` means leaving the current page. */
  function elsewhere(item: HelpItem): boolean {
    return !matchesRoute(item.routeMatch, window.location.pathname);
  }

  function renderList(): void {
    const found = results();
    active = Math.min(active, Math.max(found.length - 1, 0));
    list.replaceChildren(
      ...found.map((item, i) => {
        const li = document.createElement('li');
        li.id = `ge-help-${i}`;
        li.setAttribute('role', 'option');
        li.setAttribute('aria-selected', String(i === active));
        const title = document.createElement('div');
        title.className = 'title';
        title.textContent = item.help.title;
        li.appendChild(title);
        if (item.help.description) {
          const desc = document.createElement('div');
          desc.className = 'desc';
          desc.textContent = item.help.description;
          li.appendChild(desc);
        }
        if (elsewhere(item)) {
          const where = document.createElement('div');
          where.className = 'where';
          where.textContent = 'Opens on ';
          const path = document.createElement('code');
          path.textContent = item.help.startPath;
          where.appendChild(path);
          li.appendChild(where);
        }
        li.addEventListener('click', () => select(item));
        li.addEventListener('mousemove', () => {
          if (active !== i) {
            active = i;
            renderList();
          }
        });
        return li;
      }),
    );
    search.setAttribute('aria-activedescendant', found.length ? `ge-help-${active}` : '');
    empty.hidden = found.length > 0;
    empty.textContent = items.length === 0 ? 'No help topics yet.' : `No topics match “${query}”.`;
  }

  function renderButton(): void {
    label.textContent = button.label;
    host.style.setProperty('--ge-color', /^#[0-9a-fA-F]{6}$/.test(button.color) ? button.color : '#4f46e5');
    // An unknown value (an older agent, a tampered response) falls back to the default corner.
    const pos: HelpPosition = POSITIONS.has(button.position ?? '') ? button.position! : 'bottom-right';
    host.setAttribute('data-ge-pos', pos);
    launcher.hidden = !showButton || open || pending !== null;
    launcher.setAttribute('aria-expanded', String(open || pending !== null));
  }

  function select(item: HelpItem): void {
    // The engine decides what happens next: start here, or confirmNavigation().
    options.onSelect(item);
  }

  function hideList(): void {
    open = false;
    panel.hidden = true;
    document.removeEventListener('pointerdown', onOutsidePointer, true);
  }

  function hideConfirm(): void {
    pending = null;
    confirm.hidden = true;
    document.removeEventListener('pointerdown', onOutsidePointer, true);
  }

  /** "Stay here": back to the list the visitor came from. */
  function stay(): void {
    if (!pending) return;
    hideConfirm();
    ui.open();
  }

  /** "Take me there": leave for the guide's start page. */
  function go(): void {
    const next = pending;
    if (!next) return;
    hideConfirm();
    backdrop.hidden = true;
    renderButton();
    next.go();
  }

  function onOutsidePointer(e: PointerEvent): void {
    const path = e.composedPath();
    if (pending) {
      if (!path.includes(confirm)) stay();
    } else if (open && !path.includes(panel) && !path.includes(launcher)) {
      ui.close();
    }
  }

  launcher.addEventListener('click', () => ui.open());
  close.addEventListener('click', () => ui.close());
  backdrop.addEventListener('click', () => (pending ? stay() : ui.close()));
  stayButton.addEventListener('click', stay);
  goButton.addEventListener('click', go);
  search.addEventListener('input', () => {
    query = search.value;
    active = 0;
    renderList();
  });
  panel.addEventListener('keydown', (e) => {
    const found = results();
    if (e.key === 'Escape') {
      e.preventDefault();
      ui.close();
    } else if (e.key === 'ArrowDown' && found.length) {
      e.preventDefault();
      active = (active + 1) % found.length;
      renderList();
    } else if (e.key === 'ArrowUp' && found.length) {
      e.preventDefault();
      active = (active - 1 + found.length) % found.length;
      renderList();
    } else if (e.key === 'Enter' && e.target === search && found[active]) {
      e.preventDefault();
      select(found[active]);
    } else if (e.key === 'Tab') {
      // Keep focus inside the dialog while it's open.
      const focusable = [close, search];
      const i = focusable.indexOf(shadow.activeElement as HTMLButtonElement);
      e.preventDefault();
      focusable[(i + (e.shiftKey ? -1 : 1) + focusable.length) % focusable.length].focus();
    }
  });
  confirm.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      stay();
    } else if (e.key === 'Tab') {
      // Two buttons; Tab and Shift+Tab just swap between them.
      e.preventDefault();
      (shadow.activeElement === goButton ? stayButton : goButton).focus();
    }
  });

  const ui: HelpUi = {
    update(state) {
      items = state.items;
      button = state.button;
      showButton = state.showButton;
      attach();
      renderButton();
      if (open) renderList();
    },
    open() {
      if (open) return;
      attach();
      if (pending) hideConfirm();
      else returnFocus = (document.activeElement as HTMLElement | null) ?? null;
      open = true;
      query = '';
      search.value = '';
      active = 0;
      panel.hidden = false;
      backdrop.hidden = false;
      renderList();
      renderButton();
      document.addEventListener('pointerdown', onOutsidePointer, true);
      search.focus();
    },
    close() {
      if (!open && !pending) return;
      hideList();
      hideConfirm();
      backdrop.hidden = true;
      renderButton();
      (showButton ? launcher : returnFocus)?.focus?.();
    },
    isOpen: () => open || pending !== null,
    confirmNavigation(item, onConfirm) {
      attach();
      if (open) hideList();
      else returnFocus = (document.activeElement as HTMLElement | null) ?? null;
      pending = { item, go: onConfirm };
      confirmText.replaceChildren();
      confirmText.append('“', item.help.title, '” starts on ');
      const path = document.createElement('code');
      path.textContent = item.help.startPath;
      confirmText.append(path, '. Any unsaved changes on this page may be lost.');
      confirm.hidden = false;
      backdrop.hidden = false;
      renderButton();
      document.addEventListener('pointerdown', onOutsidePointer, true);
      goButton.focus();
    },
  };
  return ui;
}

/**
 * Search: every word of the query must appear in the title, description or
 * keywords (case-insensitive). Title matches rank first; otherwise the
 * server's order (alphabetical by title) is kept.
 */
export function filterHelpItems(items: HelpItem[], query: string): HelpItem[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return items;
  const scored: Array<{ item: HelpItem; score: number; index: number }> = [];
  items.forEach((item, index) => {
    const title = item.help.title.toLowerCase();
    const haystack = `${title} ${item.help.description.toLowerCase()} ${item.help.keywords.join(' ').toLowerCase()}`;
    if (!words.every((w) => haystack.includes(w))) return;
    scored.push({ item, index, score: words.filter((w) => title.includes(w)).length });
  });
  return scored.sort((a, b) => b.score - a.score || a.index - b.index).map((s) => s.item);
}
