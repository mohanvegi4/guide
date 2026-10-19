import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { AppSettingsComponent } from './app-settings.component';
import { App } from '../core/models';

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
  created_at: '2026-10-19T00:00:00Z',
  role: 'app_admin',
  snippet: "<script>…'ge_pk_0123'…</script>",
};

describe('AppSettingsComponent', () => {
  let http: HttpTestingController;

  async function render(overrides: Partial<App> = {}) {
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
        i.parentElement?.textContent?.includes('Require signed identity')
      )!;
    expect(toggle(await render()).disabled).toBe(true);
    TestBed.resetTestingModule();
    expect(toggle(await render({ has_signing_secret: true })).disabled).toBe(false);
  });

  it('saves the help button label and color', async () => {
    const el = await render();
    const card = [...Array.from(el.querySelectorAll('section.card'))].find((c) => c.textContent?.includes('Help center'))!;
    const [label, color] = Array.from(card.querySelectorAll<HTMLInputElement>('.inline-form input'));
    label.value = 'Need help?';
    label.dispatchEvent(new Event('input'));
    color.value = '#0ea5e9';
    color.dispatchEvent(new Event('input'));
    [...Array.from(card.querySelectorAll('button'))].find((b) => b.textContent?.includes('Save button'))!.click();
    const req = http.expectOne('/api/v1/apps/a1');
    expect(req.request.method).toBe('PATCH');
    expect(req.request.body).toEqual({ helpButtonLabel: 'Need help?', helpButtonColor: '#0ea5e9' });
    req.flush({ ...app, help_button_label: 'Need help?', help_button_color: '#0ea5e9' });
  });
});
