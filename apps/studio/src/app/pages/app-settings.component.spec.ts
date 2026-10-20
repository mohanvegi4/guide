import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Router, provideRouter } from '@angular/router';
import { AppSettingsComponent } from './app-settings.component';
import { AuthService } from '../core/auth.service';
import { AgentError, App, AppRole, HelpAnalytics } from '../core/models';

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
  let lastFixture: ComponentFixture<AppSettingsComponent>;

  async function render(
    overrides: Partial<App> = {},
    errors: AgentError[] = [],
    stats: HelpAnalytics = analytics,
    role: AppRole = 'app_admin',
  ) {
    TestBed.configureTestingModule({
      imports: [AppSettingsComponent],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
    });
    http = TestBed.inject(HttpTestingController);
    TestBed.inject(AuthService).me.set({
      user: { id: 'u', email: null, name: null, platformAdmin: false },
      orgs: [
        {
          id: 'o1',
          name: 'Acme',
          role: 'member',
          suspendedAt: null,
          apps: [{ id: 'a1', name: 'Web app', role }],
        },
      ],
    });
    const fixture = TestBed.createComponent(AppSettingsComponent);
    fixture.componentRef.setInput('appId', 'a1');
    fixture.detectChanges();
    await fixture.whenStable();
    http.expectOne('/api/v1/apps/a1').flush({ ...app, ...overrides });
    http.expectOne((r) => r.url === '/api/v1/apps/a1/errors').flush(errors);
    http.expectOne('/api/v1/apps/a1/help-analytics').flush(stats);
    await fixture.whenStable();
    lastFixture = fixture;
    return fixture.nativeElement as HTMLElement;
  }

  afterEach(() => http.verify());

  it('shows editors the install card only, read-only', async () => {
    const el = await render({}, [], analytics, 'editor');
    expect(el.querySelector('h1')?.textContent).toContain('install');
    expect(el.textContent).toContain('Copy snippet');
    expect(el.textContent).toContain("managed by this app's admins");
    expect(el.textContent).not.toContain('2. Websites');
    expect(el.querySelector('section.danger-zone')).toBeNull();
    expect(el.querySelector<HTMLInputElement>('.page-header input[type=checkbox]')!.disabled).toBe(true);
  });

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

  it('lists recent agent errors as text, and says so when there are none', async () => {
    const card = (el: HTMLElement) => el.querySelector('[data-testid="agent-errors"]')!;
    expect(card(await render()).textContent).toContain('None reported.');
    TestBed.resetTestingModule();
    const el = await render({}, [
      {
        id: 'e1',
        message: 'render: <img src=x onerror=alert(1)>',
        stack: null,
        agentVersion: '0.1.0',
        url: 'https://app.acme.test/dashboard',
        occurredAt: '2026-10-19T10:00:00Z',
      },
    ]);
    const rows = card(el).querySelectorAll('tbody tr');
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain('render: <img src=x onerror=alert(1)>');
    expect(rows[0].textContent).toContain('agent 0.1.0');
    expect(rows[0].textContent).toContain('https://app.acme.test/dashboard');
    expect(card(el).querySelector('img')).toBeNull(); // rendered as text, never as HTML
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

  it('deletes the app only after its exact name is typed, then goes back to the apps list', async () => {
    const el = await render();
    const fixture = lastFixture;
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    const zone = el.querySelector('section.danger-zone')!;
    const input = zone.querySelector<HTMLInputElement>('input[name="confirmName"]')!;
    const submit = [...Array.from(zone.querySelectorAll('button'))].find(
      (b) => b.textContent?.trim() === 'Delete app',
    )!;
    expect(submit.disabled).toBe(true);
    input.value = 'Web app';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(submit.disabled).toBe(false);
    input.closest('form')!.dispatchEvent(new Event('submit'));
    const req = http.expectOne('/api/v1/apps/a1');
    expect(req.request.method).toBe('DELETE');
    expect(req.request.body).toEqual({ confirmName: 'Web app' });
    req.flush(null, { status: 204, statusText: 'No Content' });
    await fixture.whenStable();
    expect(navigate).toHaveBeenCalledWith(['/o', 'o1', 'apps']);
  });

  it('forgets a visitor after confirmation and reports what was deleted', async () => {
    const el = await render();
    const fixture = lastFixture;
    const zone = el.querySelector('section.danger-zone')!;
    const input = zone.querySelector<HTMLInputElement>('input[name="visitorId"]')!;
    const forget = [...Array.from(zone.querySelectorAll('button'))].find(
      (b) => b.textContent?.trim() === 'Forget visitor',
    )!;
    expect(forget.disabled).toBe(true);
    input.value = 'user/42';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(forget.disabled).toBe(false);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    forget.closest('form')!.dispatchEvent(new Event('submit'));
    const req = http.expectOne('/api/v1/apps/a1/visitors/user%2F42');
    expect(req.request.method).toBe('DELETE');
    req.flush({ visitorId: 'user/42', events: 3, guideState: 1 });
    await fixture.whenStable();
    fixture.detectChanges();
    expect(el.querySelector('[role="status"]')?.textContent).toContain(
      '3 events and 1 guide state row deleted',
    );
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
    const el = await render({}, [], { days: 30, opens: 0, searches: 0, guidesStarted: 0, topQueries: [] });
    expect(el.querySelector('.help-analytics')!.textContent).toContain(
      'No help-center opens or searches recorded yet.',
    );
  });
});
