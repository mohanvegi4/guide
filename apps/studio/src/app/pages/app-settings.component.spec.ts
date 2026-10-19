import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { AppSettingsComponent } from './app-settings.component';
import { App, HelpAnalytics } from '../core/models';

const app: App = {
  id: 'a1',
  org_id: 'o1',
  name: 'Web app',
  public_key: 'ge_pk_0123',
  allowed_origins: ['https://app.acme.test'],
  identity_mode: 'optional',
  has_signing_secret: false,
  enabled: true,
  help_enabled: true,
  help_button_label: 'Help',
  help_button_color: '#4f46e5',
  help_position: 'bottom-right',
  route_mode: 'path',
  created_at: '2026-10-19T00:00:00Z',
  role: 'app_admin',
  snippet: "<script>…'ge_pk_0123'…</script>",
};

const analytics: HelpAnalytics = {
  days: 30,
  opens: 12,
  searches: 5,
  guidesStarted: 3,
  topQueries: [
    { query: 'invite', count: 3, avgResults: 1 },
    { query: 'billing', count: 2, avgResults: 0 },
  ],
};

describe('AppSettingsComponent', () => {
  let http: HttpTestingController;

  async function render(overrides: Partial<App> = {}, stats: HelpAnalytics = analytics) {
    TestBed.configureTestingModule({
      imports: [AppSettingsComponent],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
    });
    http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(AppSettingsComponent);
    fixture.componentRef.setInput('appId', 'a1');
    fixture.detectChanges();
    await fixture.whenStable();
    http.expectOne('/api/v1/apps/a1').flush({ ...app, ...overrides });
    http.expectOne('/api/v1/apps/a1/help-analytics').flush(stats);
    await fixture.whenStable();
    return fixture.nativeElement as HTMLElement;
  }

  afterEach(() => http.verify());

  it('shows the install snippet with the app key, and the websites', async () => {
    const el = await render();
    expect(el.querySelector('pre.snippet')!.textContent).toContain('ge_pk_0123');
    expect((el.querySelector('textarea') as HTMLTextAreaElement).value).toBe('https://app.acme.test');
  });

  it('locks "require signed identity" until a signing secret exists', async () => {
    const toggle = (el: HTMLElement) =>
      [...el.querySelectorAll<HTMLInputElement>('input[type=checkbox]')].find((i) =>
        i.parentElement?.textContent?.includes('Require signed identity'),
      )!;
    expect(toggle(await render()).disabled).toBe(true);
    TestBed.resetTestingModule();
    expect(toggle(await render({ has_signing_secret: true })).disabled).toBe(false);
  });

  it('saves the help button label, color and placement', async () => {
    const el = await render();
    const card = [...Array.from(el.querySelectorAll('section.card'))].find((c) =>
      c.textContent?.includes('Help center'),
    )!;
    const [label, color] = Array.from(card.querySelectorAll<HTMLInputElement>('.inline-form input'));
    label.value = 'Need help?';
    label.dispatchEvent(new Event('input'));
    color.value = '#0ea5e9';
    color.dispatchEvent(new Event('input'));
    const position = card.querySelector<HTMLSelectElement>('select[aria-label="Help button position"]')!;
    position.value = 'center';
    position.dispatchEvent(new Event('change'));
    [...Array.from(card.querySelectorAll('button'))]
      .find((b) => b.textContent?.includes('Save help button'))!
      .click();
    const req = http.expectOne('/api/v1/apps/a1');
    expect(req.request.method).toBe('PATCH');
    expect(req.request.body).toEqual({
      helpButtonLabel: 'Need help?',
      helpButtonColor: '#0ea5e9',
      helpPosition: 'center',
    });
    req.flush({ ...app, help_button_label: 'Need help?', help_button_color: '#0ea5e9' });
  });

  it('offers path or hash routing and saves a change right away', async () => {
    const el = await render();
    const select = el.querySelector<HTMLSelectElement>('select[aria-label="Routing"]')!;
    expect(select.value).toBe('path');
    expect(Array.from(select.options).map((o) => o.textContent?.trim())).toEqual([
      'Path (/settings/team)',
      'Hash (/#/settings/team)',
    ]);
    select.value = 'hash';
    select.dispatchEvent(new Event('change'));
    const req = http.expectOne('/api/v1/apps/a1');
    expect(req.request.method).toBe('PATCH');
    expect(req.request.body).toEqual({ routeMode: 'hash' });
    req.flush({ ...app, route_mode: 'hash' });
  });

  it('shows the help-center analytics for the last 30 days, with the top searches', async () => {
    const el = await render();
    const card = el.querySelector('.help-analytics')!;
    expect(card.textContent).toContain('Last 30 days');
    const totals = Array.from(card.querySelectorAll('tbody tr')).map((tr) =>
      Array.from(tr.querySelectorAll('th, td')).map((c) => c.textContent?.trim()),
    );
    expect(totals).toEqual([
      ['Opened', '12'],
      ['Searches', '5'],
      ['Guides started from here', '3'],
      ['invite', '3', '1'],
      ['billing', '2', '0'],
    ]);
    // A search that found nothing is flagged.
    expect(card.querySelectorAll('tr.bad')).toHaveLength(1);
  });

  it('says so when the help center has not been used', async () => {
    const el = await render({}, { days: 30, opens: 0, searches: 0, guidesStarted: 0, topQueries: [] });
    expect(el.querySelector('.help-analytics')!.textContent).toContain('No help-center activity yet.');
  });
});
