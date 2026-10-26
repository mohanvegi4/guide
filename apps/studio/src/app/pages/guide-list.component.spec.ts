import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { GuideListComponent } from './guide-list.component';
import { AuthService } from '../core/auth.service';
import { AppAnalytics, AppRole, Environment, GuideSummary } from '../core/models';

const production: Environment = {
  id: 'env-prod',
  name: 'Production',
  position: 1,
  websites: ['https://app.acme.test'],
  analyticsEnabled: true,
};

const guide: GuideSummary = {
  id: 'g1',
  name: 'Welcome',
  status: 'published',
  enabled: false,
  current_version_id: 'v1',
  current_version_number: 1,
  activation: 'auto',
  updated_at: '2026-10-07T00:00:00Z',
  page_id: 'p1',
  page_name: 'Team settings',
  releases: [{ environmentId: 'env-prod', versionNumber: 1 }],
};

const noEvents: AppAnalytics = {
  guides: [{ guideId: 'g1', name: 'Welcome', shown: 0, completed: 0, dismissed: 0, completionRate: 0 }],
  visitors: 0,
  accounts: 0,
  windowDays: 30,
  environmentId: 'env-prod',
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

  async function render(analytics: AppAnalytics = noEvents) {
    const fixture = TestBed.createComponent(GuideListComponent);
    fixture.componentRef.setInput('orgId', 'o1');
    fixture.componentRef.setInput('appId', 'a1');
    fixture.detectChanges();
    await fixture.whenStable();
    http.expectOne('/api/v1/apps/a1/environments').flush([production]);
    http.expectOne('/api/v1/apps/a1/guides').flush([guide]);
    http.expectOne('/api/v1/apps/a1/analytics').flush(analytics);
    await fixture.whenStable();
    // The analytics card's environment picker (hidden with one environment).
    http.match('/api/v1/apps/a1/environments').forEach((r) => r.flush([production]));
    await fixture.whenStable();
    return fixture;
  }

  afterEach(() => http.verify());

  it('deletes a guide after confirmation and drops it from the list', async () => {
    setup('app_admin');
    const fixture = await render();
    const el = fixture.nativeElement as HTMLElement;
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    el.querySelector<HTMLButtonElement>('button[aria-label="Delete Welcome"]')!.click();
    const req = http.expectOne('/api/v1/apps/a1/guides/g1');
    expect(req.request.method).toBe('DELETE');
    req.flush(null, { status: 204, statusText: 'No Content' });
    await fixture.whenStable();
    fixture.detectChanges();
    expect(el.textContent).not.toContain('Welcome');
  });

  it('shows no Delete to viewers', async () => {
    setup('viewer');
    const el = (await render()).nativeElement as HTMLElement;
    expect(el.querySelector('button[aria-label="Delete Welcome"]')).toBeNull();
  });

  it("lists the app's guides with their live version", async () => {
    setup('app_admin');
    const text = ((await render()).nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Welcome');
    expect(text).toContain('v1');
    expect(text).toContain('Team settings');
  });

  it('toggles enabled optimistically and reverts when the backend rejects it', async () => {
    setup('app_admin');
    const fixture = await render();
    const checkbox = (fixture.nativeElement as HTMLElement).querySelector<HTMLInputElement>(
      'input[type=checkbox]',
    )!;
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

  it('shows the analytics overview with completion rates as percentages', async () => {
    setup('viewer');
    const fixture = await render({
      guides: [
        { guideId: 'g1', name: 'Welcome', shown: 8, completed: 3, dismissed: 2, completionRate: 0.375 },
        { guideId: 'g2', name: 'Never shown', shown: 0, completed: 0, dismissed: 0, completionRate: 0 },
      ],
      visitors: 5,
      accounts: 2,
      windowDays: 30,
      environmentId: 'env-prod',
    });
    const el = fixture.nativeElement as HTMLElement;
    const card = el.querySelector('section.card')!;
    expect(card.textContent).toContain('Last 30 days: 5 visitors, 2 accounts');
    const rows = [...card.querySelectorAll('tbody tr')].map((r) =>
      [...r.querySelectorAll('th, td')]
        .map((c) => c.textContent?.trim())
        .join(' ')
        .trim(),
    );
    expect(rows).toEqual(['Welcome 8 3 38%']);
  });

  it('says so when nothing was recorded, and hides the card if the rollup fails', async () => {
    setup('viewer');
    const el = (await render()).nativeElement as HTMLElement;
    expect(el.querySelector('section.card')!.textContent).toContain('No events recorded yet.');

    TestBed.resetTestingModule();
    setup('viewer');
    const fixture = TestBed.createComponent(GuideListComponent);
    fixture.componentRef.setInput('orgId', 'o1');
    fixture.componentRef.setInput('appId', 'a1');
    fixture.detectChanges();
    await fixture.whenStable();
    http.expectOne('/api/v1/apps/a1/environments').flush([production]);
    http.expectOne('/api/v1/apps/a1/guides').flush([guide]);
    http
      .expectOne('/api/v1/apps/a1/analytics')
      .flush({ error: 'internal_error' }, { status: 500, statusText: 'Server Error' });
    await fixture.whenStable();
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Welcome');
    expect(text).not.toContain('No events recorded yet.');
  });

  it('shows each guide\'s version per environment once the app has several', async () => {
    setup('viewer');
    const fixture = TestBed.createComponent(GuideListComponent);
    fixture.componentRef.setInput('orgId', 'o1');
    fixture.componentRef.setInput('appId', 'a1');
    fixture.detectChanges();
    await fixture.whenStable();
    const test: Environment = { ...production, id: 'env-test', name: 'Test', position: 1, websites: [] };
    const prod: Environment = { ...production, position: 2 };
    http.expectOne('/api/v1/apps/a1/environments').flush([test, prod]);
    http
      .expectOne('/api/v1/apps/a1/guides')
      .flush([{ ...guide, releases: [{ environmentId: 'env-test', versionNumber: 2 }, ...guide.releases] }]);
    http.expectOne('/api/v1/apps/a1/analytics').flush(noEvents);
    await fixture.whenStable();
    http.match('/api/v1/apps/a1/environments').forEach((r) => r.flush([test, prod]));
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    expect([...el.querySelectorAll('.release-chip')].map((c) => c.textContent?.trim())).toEqual([
      'Test v2',
      'Production v1',
    ]);

    // The analytics card can switch environments; production is the default.
    const select = el.querySelector<HTMLSelectElement>('select[aria-label="Environment"]')!;
    expect(select.value).toBe('');
    select.value = 'env-test';
    select.dispatchEvent(new Event('change'));
    await fixture.whenStable();
    http.expectOne('/api/v1/apps/a1/analytics?environment=env-test').flush(noEvents);
  });

  it('is read-only for viewers: no create form, no enable toggle', async () => {
    setup('viewer');
    const el = (await render()).nativeElement as HTMLElement;
    expect(el.textContent).not.toContain('New guide');
    expect(el.querySelector<HTMLInputElement>('input[type=checkbox]')!.disabled).toBe(true);
  });
});
