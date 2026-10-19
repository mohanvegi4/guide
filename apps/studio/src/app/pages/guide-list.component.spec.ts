import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { GuideListComponent } from './guide-list.component';
import { AuthService } from '../core/auth.service';
import { AppAnalytics, AppRole, GuideSummary } from '../core/models';

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

const noEvents: AppAnalytics = {
  guides: [{ guideId: 'g1', name: 'Welcome', shown: 0, completed: 0, dismissed: 0, completionRate: 0 }],
  visitors: 0,
  accounts: 0,
  windowDays: 30,
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
          role: 'member',
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
    http.expectOne('/api/v1/apps/a1/guides').flush([guide]);
    http.expectOne('/api/v1/apps/a1/analytics').flush(analytics);
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
    http.expectOne('/api/v1/apps/a1/guides').flush([guide]);
    http
      .expectOne('/api/v1/apps/a1/analytics')
      .flush({ error: 'internal_error' }, { status: 500, statusText: 'Server Error' });
    await fixture.whenStable();
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Welcome');
    expect(text).not.toContain('No events recorded yet.');
  });

  it('is read-only for viewers: no create form, no enable toggle', async () => {
    setup('viewer');
    const el = (await render()).nativeElement as HTMLElement;
    expect(el.textContent).not.toContain('New guide');
    expect(el.querySelector<HTMLInputElement>('input[type=checkbox]')!.disabled).toBe(true);
  });
});
