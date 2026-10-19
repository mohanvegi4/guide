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
      providers: [provideHttpClient(withInterceptors([authInterceptor])), provideHttpClientTesting(), provideRouter([])],
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

    auth.token.set('t2'); // e.g. silent token renewal
    fixture.detectChanges();
    await fixture.whenStable();
    http.expectNone('/api/v1/apps/a1/guides/g1/analytics');
    http.verify();
  });
});
