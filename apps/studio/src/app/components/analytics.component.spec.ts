import { TestBed } from '@angular/core/testing';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { AnalyticsComponent } from './analytics.component';
import { AuthService } from '../core/auth.service';
import { authInterceptor } from '../core/auth.interceptor';

describe('AnalyticsComponent', () => {
  it('fetches once per guide, not again when the auth token changes', async () => {
    TestBed.configureTestingModule({
      imports: [AnalyticsComponent],
      providers: [
        provideHttpClient(withInterceptors([authInterceptor])),
        provideHttpClientTesting(),
        provideRouter([]),
      ],
    });
    const http = TestBed.inject(HttpTestingController);
    const auth = TestBed.inject(AuthService);
    auth.token.set('t1');

    const fixture = TestBed.createComponent(AnalyticsComponent);
    fixture.componentRef.setInput('appId', 'a1');
    fixture.componentRef.setInput('guideId', 'g1');
    fixture.detectChanges();
    await fixture.whenStable();
    http.expectOne('/api/v1/apps/a1/guides/g1/analytics').flush({ guideId: 'g1', counts: [], steps: [] });
    http.expectOne('/api/v1/apps/a1/environments').flush([]);

    auth.token.set('t2'); // e.g. silent token renewal
    fixture.detectChanges();
    await fixture.whenStable();
    http.expectNone('/api/v1/apps/a1/guides/g1/analytics');
    http.verify();
  });

  it('loads the per-account breakdown only when "By account" is on, and renders it', async () => {
    TestBed.configureTestingModule({
      imports: [AnalyticsComponent],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
    });
    const http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(AnalyticsComponent);
    fixture.componentRef.setInput('appId', 'a1');
    fixture.componentRef.setInput('guideId', 'g1');
    fixture.detectChanges();
    await fixture.whenStable();
    http.expectOne('/api/v1/apps/a1/guides/g1/analytics').flush({
      guideId: 'g1',
      counts: [{ event_type: 'guide_shown', count: 3 }],
      steps: [],
      startedFromHelp: 0,
    });
    http.expectOne('/api/v1/apps/a1/environments').flush([]);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).not.toContain('No account');

    const toggle = el.querySelector<HTMLInputElement>('input[type=checkbox]')!;
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change'));
    await fixture.whenStable();
    http.expectOne('/api/v1/apps/a1/guides/g1/analytics?by=account').flush({
      guideId: 'g1',
      counts: [{ event_type: 'guide_shown', count: 3 }],
      steps: [],
      startedFromHelp: 0,
      accounts: [
        { accountId: 'acme', shown: 2, completed: 1, dismissed: 0, visitors: 2 },
        { accountId: null, shown: 1, completed: 0, dismissed: 1, visitors: 1 },
      ],
    });
    await fixture.whenStable();
    const rows = [...el.querySelectorAll('tbody tr')]
      .map((r) =>
        [...r.querySelectorAll('th, td')]
          .map((c) => c.textContent?.trim())
          .join(' ')
          .trim(),
      )
      .filter((t) => t.startsWith('acme') || t.startsWith('No account'));
    expect(rows).toEqual(['acme 2 1 0 2', 'No account 1 0 1 1']);

    toggle.checked = false;
    toggle.dispatchEvent(new Event('change'));
    await fixture.whenStable();
    http.expectNone('/api/v1/apps/a1/guides/g1/analytics');
    expect(el.textContent).not.toContain('No account');
    http.verify();
  });
});
