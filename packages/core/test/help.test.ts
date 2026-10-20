import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GuideEngine, HelpItem, HelpUi, createHelpWidget, filterHelpItems } from '../src';
import {
  R,
  baseOptions,
  bodyOf,
  callsTo,
  eventsSent,
  fakeRenderer,
  makeGuide,
  makeStep,
  mockFetch,
  serving,
} from './helpers';

const HELP = R.guides.replace(/\/guides$/, '/help');

function helpItem(
  id: string,
  title: string,
  overrides: Partial<HelpItem['help']> = {},
  route = '/team',
): HelpItem {
  return {
    ...makeGuide({
      id,
      versionId: `${id}-v1`,
      routeMatch: { type: 'exact', value: route },
      steps: [makeStep({ id: `${id}-s1` })],
    }),
    help: { title, description: '', keywords: [], startPath: route, ...overrides },
  };
}

const helpBody =
  (...guides: HelpItem[]) =>
  () => ({
    body: { enabled: true, button: { label: 'Need help?', color: '#0ea5e9' }, guides },
  });

/** Records what the engine tells the help UI. */
function fakeHelpUi() {
  const updates: Array<Parameters<HelpUi['update']>[0]> = [];
  let isOpen = false;
  const ui: HelpUi = {
    update: (s) => void updates.push(s),
    open: () => void (isOpen = true),
    close: () => void (isOpen = false),
    isOpen: () => isOpen,
  };
  return { ui, updates, opened: () => isOpen };
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
  window.history.replaceState({}, '', '/');
});

describe('filterHelpItems', () => {
  const items = [
    helpItem('a', 'Export a report', { keywords: ['csv', 'download'] }),
    helpItem('b', 'Invite a colleague', { description: 'Add people to your team' }),
    helpItem('c', 'Team settings', { keywords: ['members'] }),
  ];
  it('matches title, description and keywords, every word, case-insensitively', () => {
    expect(filterHelpItems(items, 'CSV').map((i) => i.id)).toEqual(['a']);
    expect(filterHelpItems(items, 'add people').map((i) => i.id)).toEqual(['b']);
    expect(filterHelpItems(items, 'invite nothing')).toEqual([]);
    expect(filterHelpItems(items, '  ')).toHaveLength(3);
  });
  it('ranks title matches first', () => {
    expect(filterHelpItems(items, 'team').map((i) => i.id)).toEqual(['c', 'b']);
  });
});

describe('default help widget', () => {
  function mount(
    showButton = true,
    items = [helpItem('a', 'Invite a teammate'), helpItem('b', 'Export a report')],
  ) {
    const onSelect = vi.fn();
    const ui = createHelpWidget({ onSelect });
    ui.update({ items, button: { label: 'Need help?', color: '#0ea5e9' }, showButton });
    const root = document.querySelector('[data-guide-help]')!.shadowRoot!;
    const $ = <T extends Element>(sel: string) => root.querySelector<T>(sel)!;
    return { ui, onSelect, root, $ };
  }

  it('shows the floating button with the app’s label and color, or hides it', () => {
    const { $ } = mount();
    expect($<HTMLButtonElement>('.launcher').hidden).toBe(false);
    expect($('.label').textContent).toBe('Need help?');
    expect(
      (document.querySelector('[data-guide-help]') as HTMLElement).style.getPropertyValue('--ge-color'),
    ).toBe('#0ea5e9');
    document.body.innerHTML = '';
    expect(mount(false).$<HTMLButtonElement>('.launcher').hidden).toBe(true);
  });

  it('opens a labelled dialog with focus in the search box, and searching filters the list', () => {
    const { $, root } = mount();
    $<HTMLButtonElement>('.launcher').click();
    const panel = $<HTMLElement>('.panel');
    expect(panel.hidden).toBe(false);
    expect(panel.getAttribute('role')).toBe('dialog');
    expect(root.activeElement).toBe($('.search'));
    expect(root.querySelectorAll('li')).toHaveLength(2);

    const search = $<HTMLInputElement>('.search');
    search.value = 'export';
    search.dispatchEvent(new Event('input'));
    expect(Array.from(root.querySelectorAll('li .title')).map((t) => t.textContent)).toEqual([
      'Export a report',
    ]);
    search.value = 'zzz';
    search.dispatchEvent(new Event('input'));
    expect($('.empty').textContent).toContain('No topics match');
  });

  it('↓ and Enter pick a topic; Esc closes', () => {
    const { ui, $, onSelect } = mount();
    ui.open();
    const key = (k: string) =>
      $('.search').dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
    key('ArrowDown');
    key('Enter');
    // The engine decides what happens next (start here, or ask before leaving), so the list stays.
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'b' }));
    expect(ui.isOpen()).toBe(true);
    key('Escape');
    expect(ui.isOpen()).toBe(false);
  });

  it('says which topics open on another page', () => {
    window.history.replaceState({}, '', '/team');
    const { ui, root } = mount(true, [
      helpItem('here', 'Invite a teammate'), // lives on /team
      helpItem('there', 'Export a report', { startPath: '/reports/2026' }, '/reports/*'),
    ]);
    ui.open();
    const where = Array.from(root.querySelectorAll('li')).map(
      (li) => li.querySelector('.where')?.textContent ?? null,
    );
    expect(where).toEqual([null, 'Opens on /reports/2026']);
  });

  it('asks before leaving the page: Stay here returns to the list, Take me there goes', () => {
    const { ui, $, root } = mount();
    const item = helpItem('b', 'Export a report', { startPath: '/reports' }, '/reports');
    const go = vi.fn();
    ui.open();
    ui.confirmNavigation!(item, go);

    const confirm = $<HTMLElement>('.confirm');
    expect(confirm.hidden).toBe(false);
    expect(confirm.getAttribute('role')).toBe('alertdialog');
    expect($<HTMLElement>('.panel:not(.confirm)').hidden).toBe(true);
    expect(root.activeElement).toBe($('.go'));
    expect($('#ge-help-confirm-text').textContent).toBe(
      '“Export a report” starts on /reports. Any unsaved changes on this page may be lost.',
    );
    expect(ui.isOpen()).toBe(true);

    $<HTMLButtonElement>('.stay').click();
    expect(go).not.toHaveBeenCalled();
    expect(confirm.hidden).toBe(true);
    expect($<HTMLElement>('.panel:not(.confirm)').hidden).toBe(false); // back to the list
    expect(root.activeElement).toBe($('.search'));

    ui.confirmNavigation!(item, go);
    $('.go').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(go).not.toHaveBeenCalled();
    expect($<HTMLElement>('.panel:not(.confirm)').hidden).toBe(false);

    ui.confirmNavigation!(item, go);
    $<HTMLButtonElement>('.go').click();
    expect(go).toHaveBeenCalledTimes(1);
    expect(ui.isOpen()).toBe(false);
    expect($<HTMLElement>('.launcher').hidden).toBe(false);
  });

  it('renders server text as text, never HTML', () => {
    const { ui, root } = mount(true, [
      helpItem('x', '<img src=x onerror="window.__pwned=1">Evil', { description: '<b>bold</b>' }),
    ]);
    ui.open();
    expect(root.querySelector('li img')).toBeNull();
    expect(root.querySelector('li .title')!.textContent).toBe('<img src=x onerror="window.__pwned=1">Evil');
  });

  it('places the list (and the confirmation with it) in the app’s corner or mid-screen', () => {
    const { ui } = mount();
    const host = document.querySelector('[data-guide-help]') as HTMLElement;
    const place = (position: string) =>
      ui.update({
        items: [],
        button: { label: 'Help', color: '#4f46e5', position: position as never },
        showButton: true,
      });
    expect(host.dataset.gePos).toBe('bottom-right');
    place('top-left');
    expect(host.dataset.gePos).toBe('top-left');
    place('center');
    expect(host.dataset.gePos).toBe('center');
    // An unknown value falls back to the default corner.
    place('middle');
    expect(host.dataset.gePos).toBe('bottom-right');
  });

  it('ignores a non-hex button color', () => {
    const onSelect = vi.fn();
    createHelpWidget({ onSelect }).update({
      items: [],
      button: { label: 'Help', color: 'red; background: url(x)' },
      showButton: true,
    });
    expect(
      (document.querySelector('[data-guide-help]') as HTMLElement).style.getPropertyValue('--ge-color'),
    ).toBe('#4f46e5');
  });
});

describe('engine help center', () => {
  beforeEach(() => window.history.replaceState({}, '', '/team'));

  it('loads the help list after startup and shows the button only if there are topics', async () => {
    mockFetch({ [R.guides]: serving(), [HELP]: helpBody(helpItem('a', 'Invite')) });
    const help = fakeHelpUi();
    await new GuideEngine().init(baseOptions, fakeRenderer().renderer, help.ui);
    expect(help.updates.slice(-1)[0]).toMatchObject({
      showButton: true,
      button: { label: 'Need help?' },
      items: [{ id: 'a' }],
    });

    mockFetch({ [R.guides]: serving(), [HELP]: helpBody() });
    const empty = fakeHelpUi();
    await new GuideEngine().init(baseOptions, fakeRenderer().renderer, empty.ui);
    expect(empty.updates.slice(-1)[0]).toMatchObject({ showButton: false, items: [] });
  });

  it('helpButton:false hides the default button, but openHelp() still opens the help center', async () => {
    mockFetch({ [R.guides]: serving(), [HELP]: helpBody(helpItem('a', 'Invite')) });
    const help = fakeHelpUi();
    const engine = new GuideEngine();
    await engine.init({ ...baseOptions, helpButton: false }, fakeRenderer().renderer, help.ui);
    expect(help.updates.slice(-1)[0]?.showButton).toBe(false);
    engine.openHelp();
    expect(help.opened()).toBe(true);
    engine.toggleHelp();
    expect(help.opened()).toBe(false);
  });

  it('starts right away when the start page is this page, even if the route does not match', async () => {
    // A hold walkthrough that matches title pages, launched from the results page it starts on.
    const item = helpItem('hold', 'Place a hold', { startPath: '/team?qs=harry' }, '/title/*');
    mockFetch({ [R.guides]: serving(), [HELP]: helpBody(item), [R.events]: () => ({ status: 202 }) });
    const { renderer, rendered } = fakeRenderer();
    const engine = new GuideEngine();
    const navigate = vi.fn();
    engine.navigate = navigate;
    await engine.init(baseOptions, renderer, fakeHelpUi().ui);
    engine.launchHelpGuide('hold');
    expect(navigate).not.toHaveBeenCalled();
    expect(rendered.map((r) => r.guide.id)).toEqual(['hold']);
  });

  it('starts a guide for the current page right away — even one the visitor already finished — tagged source=help', async () => {
    const item = helpItem('a', 'Invite');
    const fetchMock = mockFetch({
      [R.guides]: serving(item),
      [HELP]: helpBody(item),
      [R.events]: () => ({ status: 202 }),
    });
    const { renderer, rendered } = fakeRenderer();
    const engine = new GuideEngine();
    await engine.init(baseOptions, renderer, fakeHelpUi().ui);
    engine.advanceStep('a'); // automatic run completed
    engine.launchHelpGuide('a');
    expect(rendered.map((r) => r.guide.id)).toEqual(['a', 'a']);
    engine.dismissGuide('a'); // flushes the queue (dismiss is sent immediately)

    await vi.waitFor(() =>
      expect(
        eventsSent(fetchMock)
          .filter((e) => e.eventType === 'guide_shown')
          .map((e) => e.metadata),
      ).toEqual([undefined, { source: 'help' }]),
    );
  });

  it('asks the help UI before leaving the page, and navigates only when the visitor agrees', async () => {
    const item = helpItem('b', 'Export', { startPath: '/reports' }, '/reports');
    window.history.replaceState({}, '', '/dashboard');
    mockFetch({ [R.guides]: serving(), [HELP]: helpBody(item, helpItem('a', 'Here', {}, '/dashboard')) });
    const engine = new GuideEngine();
    const navigate = vi.fn();
    engine.navigate = navigate;
    const asked: Array<{ item: HelpItem; go: () => void }> = [];
    const help = fakeHelpUi();
    help.ui.confirmNavigation = (i, go) => void asked.push({ item: i, go });
    await engine.init(baseOptions, fakeRenderer().renderer, help.ui);

    engine.launchHelpGuide('b');
    expect(navigate).not.toHaveBeenCalled();
    expect(asked.map((a) => a.item.id)).toEqual(['b']);
    asked[0].go();
    expect(navigate).toHaveBeenCalledWith('/reports?guideEngine=help%3Ab');

    // A guide for the current page never asks.
    engine.launchHelpGuide('a');
    expect(asked).toHaveLength(1);
  });

  it('a help UI without confirmNavigation gets sent straight to the start page (a page load, like Pendo)', async () => {
    const item = helpItem('b', 'Export', { startPath: '/reports/2026?tab=all' }, '/reports/*');
    mockFetch({ [R.guides]: serving(), [HELP]: helpBody(item) });
    const engine = new GuideEngine();
    const navigate = vi.fn();
    engine.navigate = navigate;
    await engine.init(baseOptions, fakeRenderer().renderer, fakeHelpUi().ui);
    engine.launchHelpGuide('b');
    expect(navigate).toHaveBeenCalledWith('/reports/2026?tab=all&guideEngine=help%3Ab');
  });

  it('never sends visitors off-site, even with a crafted start page', async () => {
    const item = helpItem('c', 'X', { startPath: '//evil.example/path' }, '/elsewhere');
    mockFetch({ [R.guides]: serving(), [HELP]: helpBody(item) });
    const engine = new GuideEngine();
    const navigate = vi.fn();
    engine.navigate = navigate;
    await engine.init(baseOptions, fakeRenderer().renderer, fakeHelpUi().ui);
    engine.launchHelpGuide('c');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('on arrival with ?guideEngine=help:<id>, starts that guide once, tags it, and removes the parameter', async () => {
    window.history.replaceState({}, '', '/team?tab=1&guideEngine=help%3Aa');
    const item = helpItem('a', 'Invite');
    const fetchMock = mockFetch({
      [R.guides]: serving(item),
      [HELP]: helpBody(item),
      [R.events]: () => ({ status: 202 }),
    });
    const { renderer, rendered } = fakeRenderer();
    await new GuideEngine().init(baseOptions, renderer, fakeHelpUi().ui);

    expect(rendered).toHaveLength(1); // not started again by automatic evaluation
    expect(window.location.search).toBe('?tab=1');
    expect(callsTo(fetchMock, HELP)).toHaveLength(1);
  });

  it('a plain ?guideEngine=<id> (a shared link) starts the guide tagged source=link', async () => {
    window.history.replaceState({}, '', '/team?guideEngine=a');
    const item = helpItem('a', 'Invite');
    const fetchMock = mockFetch({
      [R.guides]: serving(),
      [HELP]: helpBody(item),
      [R.events]: () => ({ status: 202 }),
    });
    const { renderer, rendered } = fakeRenderer();
    const engine = new GuideEngine();
    await engine.init(baseOptions, renderer, fakeHelpUi().ui);
    expect(rendered).toHaveLength(1);
    engine.dismissGuide('a');
    await vi.waitFor(() =>
      expect(eventsSent(fetchMock).map((e) => e.metadata)).toContainEqual({ source: 'link' }),
    );
  });

  it('re-loads the help list for a new user after identify()', async () => {
    const fetchMock = mockFetch({ [R.guides]: serving(), [HELP]: helpBody() });
    const engine = new GuideEngine();
    await engine.init(baseOptions, fakeRenderer().renderer, fakeHelpUi().ui);
    await engine.identify({ visitor: { id: 'other' }, account: { id: 'globex' } });
    const calls = callsTo(fetchMock, HELP);
    expect(calls).toHaveLength(2);
    expect(bodyOf(calls[1])).toMatchObject({ visitor: { id: 'other' }, account: { id: 'globex' } });
  });

  it('does nothing when the engine is switched off', async () => {
    mockFetch({
      [R.guides]: () => ({ body: { enabled: false, guides: [] } }),
      [HELP]: helpBody(helpItem('a', 'x')),
    });
    const help = fakeHelpUi();
    const engine = new GuideEngine();
    await engine.init(baseOptions, fakeRenderer().renderer, help.ui);
    engine.openHelp();
    expect(help.opened()).toBe(false);
    expect(help.updates).toEqual([]);
  });
});

describe('help-center analytics', () => {
  function mount(onOpen = vi.fn(), onSearch = vi.fn()) {
    const ui = createHelpWidget({ onSelect: vi.fn(), onOpen, onSearch });
    ui.update({
      items: [helpItem('a', 'Invite a teammate'), helpItem('b', 'Invoice history'), helpItem('c', 'Export')],
      button: { label: 'Help', color: '#4f46e5' },
      showButton: true,
    });
    const root = document.querySelector('[data-guide-help]')!.shadowRoot!;
    const search = root.querySelector<HTMLInputElement>('.search')!;
    const type = (value: string) => {
      search.value = value;
      search.dispatchEvent(new Event('input'));
    };
    return { ui, root, type, onOpen, onSearch };
  }

  it('reports an open from the button or openHelp(), but not "Stay here" bringing the list back', () => {
    const { ui, root, onOpen } = mount();
    root.querySelector<HTMLButtonElement>('.launcher')!.click();
    expect(onOpen).toHaveBeenCalledTimes(1);
    ui.close();
    ui.open();
    expect(onOpen).toHaveBeenCalledTimes(2);

    ui.confirmNavigation!(helpItem('b', 'Export', { startPath: '/reports' }, '/reports'), vi.fn());
    root.querySelector<HTMLButtonElement>('.stay')!.click();
    expect(ui.isOpen()).toBe(true);
    expect(onOpen).toHaveBeenCalledTimes(2);
  });

  it('reports a search once typing pauses for 500 ms, with the query and how many topics matched', () => {
    vi.useFakeTimers();
    try {
      const { ui, type, onSearch } = mount();
      ui.open();
      type('i');
      vi.advanceTimersByTime(1000);
      expect(onSearch).not.toHaveBeenCalled(); // one letter says nothing

      type('in');
      vi.advanceTimersByTime(200);
      type('inv');
      vi.advanceTimersByTime(200);
      type('invi');
      expect(onSearch).not.toHaveBeenCalled(); // still typing
      vi.advanceTimersByTime(500);
      expect(onSearch).toHaveBeenCalledTimes(1);
      expect(onSearch).toHaveBeenCalledWith('invi', 1);

      type('  zzz  ');
      vi.advanceTimersByTime(500);
      expect(onSearch).toHaveBeenLastCalledWith('zzz', 0);

      // Clearing the box, or closing the panel, cancels a pending report.
      type('inv');
      type('');
      vi.advanceTimersByTime(500);
      type('inv');
      ui.close();
      vi.advanceTimersByTime(500);
      expect(onSearch).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('the engine queues help events without a guide, with the query capped at 200 characters', async () => {
    const fetchMock = mockFetch({
      [R.guides]: serving(),
      [HELP]: helpBody(helpItem('a', 'Invite')),
      [R.events]: () => ({ status: 202 }),
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const engine = new GuideEngine();
      await engine.init(baseOptions, fakeRenderer().renderer, fakeHelpUi().ui);
      engine.trackHelpOpened();
      engine.trackHelpSearched('x'.repeat(300), 2);
      await vi.advanceTimersByTimeAsync(5000);
      const sent = callsTo(fetchMock, R.events).flatMap((c) => bodyOf(c).events as Record<string, unknown>[]);
      expect(sent).toEqual([
        expect.objectContaining({ eventType: 'help_opened', sessionId: expect.any(String) }),
        expect.objectContaining({
          eventType: 'help_searched',
          metadata: { query: 'x'.repeat(200), results: 2 },
        }),
      ]);
      expect(sent[0]).not.toHaveProperty('guideId');
      expect(sent[1]).not.toHaveProperty('guideVersionId');
    } finally {
      vi.useRealTimers();
    }
  });

  it('records nothing while the engine is off', async () => {
    const fetchMock = mockFetch({
      [R.guides]: () => ({ body: { enabled: false, guides: [] } }),
      [R.events]: () => ({ status: 202 }),
    });
    const engine = new GuideEngine();
    await engine.init(baseOptions, fakeRenderer().renderer, fakeHelpUi().ui);
    engine.trackHelpOpened();
    engine.trackHelpSearched('invite', 0);
    await new Promise((r) => setTimeout(r, 0));
    expect(callsTo(fetchMock, R.events)).toHaveLength(0);
  });
});
