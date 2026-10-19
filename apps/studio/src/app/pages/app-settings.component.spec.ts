import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { AppSettingsComponent } from './app-settings.component';
import { AgentError, App } from '../core/models';

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
  created_at: '2026-10-19T00:00:00Z',
  role: 'app_admin',
  snippet: "<script>…'ge_pk_0123'…</script>",
};

describe('AppSettingsComponent', () => {
  let http: HttpTestingController;

  async function render(overrides: Partial<App> = {}, errors: AgentError[] = []) {
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
    http.expectOne((r) => r.url === '/api/v1/apps/a1/errors').flush(errors);
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
});
