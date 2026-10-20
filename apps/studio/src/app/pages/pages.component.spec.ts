import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { PagesComponent, toPayload } from './pages.component';
import { AuthService } from '../core/auth.service';
import { AppPage, AppRole } from '../core/models';

const team: AppPage = {
  id: 'p1',
  name: 'Team settings',
  routeMatch: { type: 'exact', value: '/settings/team' },
  startPath: null,
  createdAt: '2026-10-19T00:00:00Z',
  updatedAt: '2026-10-19T00:00:00Z',
  usage: { guides: 2, live: 1 },
};

describe('PagesComponent', () => {
  let http: HttpTestingController;

  function setup(role: AppRole) {
    TestBed.configureTestingModule({
      imports: [PagesComponent],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
    });
    http = TestBed.inject(HttpTestingController);
    TestBed.inject(AuthService).me.set({
      user: { id: 'u', email: null, name: null, platformAdmin: false },
      orgs: [
        {
          id: 'o1',
          name: 'Acme',
          role: 'editor',
          suspendedAt: null,
          apps: [{ id: 'a1', name: 'Web', role }],
        },
      ],
    });
  }

  async function render(pages: AppPage[] = [team]) {
    const fixture = TestBed.createComponent(PagesComponent);
    fixture.componentRef.setInput('orgId', 'o1');
    fixture.componentRef.setInput('appId', 'a1');
    fixture.detectChanges();
    await fixture.whenStable();
    http.expectOne('/api/v1/apps/a1/pages').flush(pages);
    await fixture.whenStable();
    return fixture;
  }

  const buttons = (el: HTMLElement, label: string) =>
    [...el.querySelectorAll('button')].filter((b) => b.textContent?.trim() === label);

  afterEach(() => http.verify());

  it('lists pages with their URL, default start page and usage', async () => {
    setup('editor');
    const text = ((await render()).nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Team settings');
    expect(text).toContain('/settings/team');
    expect(text).toContain('2 guides');
    expect(text).toContain('(1 live)');
  });

  it('creates a page from the form', async () => {
    setup('editor');
    const fixture = await render([]);
    const el = fixture.nativeElement as HTMLElement;
    const [name, url] = [...el.querySelectorAll<HTMLInputElement>('.page-form input')];
    name.value = 'Projects';
    name.dispatchEvent(new Event('input'));
    url.value = '/projects';
    url.dispatchEvent(new Event('input'));
    el.querySelector<HTMLFormElement>('.page-form')!.dispatchEvent(new Event('submit'));

    const req = http.expectOne('/api/v1/apps/a1/pages');
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({
      name: 'Projects',
      routeMatch: { type: 'exact', value: '/projects' },
      startPath: null,
    });
    req.flush({ ...team, id: 'p2', name: 'Projects' });
    http.expectOne('/api/v1/apps/a1/pages').flush([]);
  });

  it('editors can rename a page live guides use, but its URL is locked for them', async () => {
    setup('editor');
    const fixture = await render();
    const el = fixture.nativeElement as HTMLElement;
    buttons(el, 'Edit')[0].click();
    await fixture.whenStable();
    const [name, url] = [...el.querySelectorAll<HTMLInputElement>('tr.editing input')];
    expect(url.disabled).toBe(true);
    expect(name.disabled).toBe(false);
    expect(el.textContent).toContain('only publishers can change its URL');
  });

  it('disables Delete for editors while guides use the page', async () => {
    setup('editor');
    const el = (await render()).nativeElement as HTMLElement;
    expect(buttons(el, 'Delete')[0].disabled).toBe(true);
  });

  it('publishers can move a page; delete is disabled while guides use it', async () => {
    setup('publisher');
    const fixture = await render();
    const el = fixture.nativeElement as HTMLElement;
    expect(buttons(el, 'Delete')[0].disabled).toBe(true);
    buttons(el, 'Edit')[0].click();
    await fixture.whenStable();
    const url = el.querySelectorAll<HTMLInputElement>('tr.editing input')[1];
    expect(url.disabled).toBe(false);
    expect(el.textContent).toContain('moves 1 live guide immediately');
  });

  it('is read-only for viewers', async () => {
    setup('viewer');
    const el = (await render()).nativeElement as HTMLElement;
    expect(el.textContent).not.toContain('New page');
    expect(buttons(el, 'Edit')).toHaveLength(0);
  });
});

describe('toPayload', () => {
  const draft = { name: 'P', type: 'exact' as const, value: '/p', startPath: '' };

  it('builds the API body', () => {
    expect(toPayload({ ...draft, name: ' P ', startPath: ' /p?tab=1 ' })).toEqual({
      name: 'P',
      routeMatch: { type: 'exact', value: '/p' },
      startPath: '/p?tab=1',
    });
  });

  it('requires a name, a path, an on-site start page, and a start page for patterns', () => {
    expect(toPayload({ ...draft, name: ' ' })).toContain('name');
    expect(toPayload({ ...draft, value: 'p' })).toContain('starting with /');
    expect(toPayload({ ...draft, startPath: '//evil.example' })).toContain('path on your site');
    expect(toPayload({ ...draft, type: 'pattern', value: '/p/*' })).toContain('needs a start page');
  });
});
