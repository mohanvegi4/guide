import type { HelpButtonSettings, HelpItem, HelpUi } from './engine';

/**
 * Default help-center UI: a floating "Help" button (bottom right) that opens
 * a dialog listing the visitor's help guides, with search. Picking one calls
 * onSelect (the engine then starts it here, or sends the visitor to its page).
 *
 * Lives in a Shadow DOM so host-page CSS can't break it (or vice versa).
 * Everything from the server goes in via textContent — never innerHTML — and
 * the button color is applied only if it's a plain hex value.
 *
 * Accessible: role="dialog" + aria-modal, labelled; focus moves into the
 * search box on open and back to whatever opened it on close; ↑/↓ move
 * through results, Enter starts one, Esc closes; clicking outside closes.
 */
export function createHelpWidget(options: { onSelect(item: HelpItem): void }): HelpUi {
  let items: HelpItem[] = [];
  let button: HelpButtonSettings = { label: 'Help', color: '#4f46e5' };
  let showButton = false;
  let open = false;
  let query = '';
  let active = 0;
  let returnFocus: HTMLElement | null = null;

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
      @media (max-width: 480px) { .panel { right: 16px; left: 16px; bottom: 16px; width: auto; max-height: calc(100vh - 32px); } }
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
      .empty { padding: 12px 20px 20px; color: #555; font-size: 14px; }
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
  `;

  const launcher = shadow.querySelector<HTMLButtonElement>('.launcher')!;
  const label = shadow.querySelector<HTMLSpanElement>('.label')!;
  const backdrop = shadow.querySelector<HTMLDivElement>('.backdrop')!;
  const panel = shadow.querySelector<HTMLDivElement>('.panel')!;
  const close = shadow.querySelector<HTMLButtonElement>('.close')!;
  const search = shadow.querySelector<HTMLInputElement>('.search')!;
  const list = shadow.querySelector<HTMLUListElement>('ul')!;
  const empty = shadow.querySelector<HTMLParagraphElement>('.empty')!;

  function attach(): void {
    if (!host.isConnected) document.body.appendChild(host);
  }

  function results(): HelpItem[] {
    return filterHelpItems(items, query);
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
        li.addEventListener('click', () => select(item));
        li.addEventListener('mousemove', () => {
          if (active !== i) {
            active = i;
            renderList();
          }
        });
        return li;
      })
    );
    search.setAttribute('aria-activedescendant', found.length ? `ge-help-${active}` : '');
    empty.hidden = found.length > 0;
    empty.textContent = items.length === 0 ? 'No help topics yet.' : `No topics match “${query}”.`;
  }

  function renderButton(): void {
    label.textContent = button.label;
    host.style.setProperty('--ge-color', /^#[0-9a-fA-F]{6}$/.test(button.color) ? button.color : '#4f46e5');
    launcher.hidden = !showButton || open;
    launcher.setAttribute('aria-expanded', String(open));
  }

  function select(item: HelpItem): void {
    ui.close();
    options.onSelect(item);
  }

  function onOutsidePointer(e: PointerEvent): void {
    if (!open) return;
    const path = e.composedPath();
    if (!path.includes(panel) && !path.includes(launcher)) ui.close();
  }

  launcher.addEventListener('click', () => ui.open());
  close.addEventListener('click', () => ui.close());
  backdrop.addEventListener('click', () => ui.close());
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
      open = true;
      returnFocus = (document.activeElement as HTMLElement | null) ?? null;
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
      if (!open) return;
      open = false;
      panel.hidden = true;
      backdrop.hidden = true;
      renderButton();
      document.removeEventListener('pointerdown', onOutsidePointer, true);
      (showButton ? launcher : returnFocus)?.focus?.();
    },
    isOpen: () => open,
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
