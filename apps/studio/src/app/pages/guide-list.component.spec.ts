import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { GuideListComponent } from './guide-list.component';
import { AuthService } from '../core/auth.service';
import { AppRole, GuideSummary } from '../core/models';

const guide: GuideSummary = {
  id: 'g1',
  name: 'Welcome',
  type: 'tooltip',
  status: 'published',
  enabled: false,
  current_version_id: 'v1',
  current_version_number: 1,
  updated_at: '2026-10-07T00:00:00Z',
  page_id: 'p1',
  page_name: 'Team settings',
};

describe('GuideListComponent', () => {
  let http: HttpTestingController;

  function setup(role: AppRole) {
    TestBed.configureTestingModule({
      imports: [GuideListComponent],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
    });
    http = TestBed.inject(HttpTestingController);
    TestBed.inject(AuthService).me.set({
      user: { id: 'u', email: null, name: null },
      orgs: [{ id: 'o1', name: 'Acme', role: 'member', apps: [{ id: 'a1', name: 'Web', role }] }],
    });
  }

  async function render() {
    const fixture = TestBed.createComponent(GuideListComponent);
    fixture.componentRef.setInput('orgId', 'o1');
    fixture.componentRef.setInput('appId', 'a1');
    fixture.detectChanges();
    await fixture.whenStable();
    http.expectOne('/api/v1/apps/a1/guides').flush([guide]);
    await fixture.whenStable();
    return fixture;
  }

  afterEach(() => http.verify());

  it("lists the app's guides with their live version", async () => {
    setup('publisher');
    const text = ((await render()).nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Welcome');
    expect(text).toContain('v1');
    expect(text).toContain('Team settings');
  });

  it('toggles enabled optimistically and reverts when the backend rejects it', async () => {
    setup('publisher');
    const fixture = await render();
    const checkbox = (fixture.nativeElement as HTMLElement).querySelector<HTMLInputElement>('input[type=checkbox]')!;
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event('change'));
    await fixture.whenStable();
    expect(checkbox.checked).toBe(true);

    const req = http.expectOne('/api/v1/apps/a1/guides/g1/flag');
    expect(req.request.body).toEqual({ enabled: true });
    req.flush({ error: 'not_found' }, { status: 404, statusText: 'Not Found' });
    await fixture.whenStable();
    expect(checkbox.checked).toBe(false);
  });

  it('is read-only for viewers: no create form, no enable toggle', async () => {
    setup('viewer');
    const el = (await render()).nativeElement as HTMLElement;
    expect(el.textContent).not.toContain('New guide');
    expect(el.querySelector<HTMLInputElement>('input[type=checkbox]')!.disabled).toBe(true);
  });
});
