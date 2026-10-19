import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { GuideEditorComponent } from './guide-editor.component';
import { AuthService } from '../core/auth.service';
import { AppPage, GuideDetail, GuideVersion, PublishPayload } from '../core/models';

const team: AppPage = {
  id: 'p1',
  name: 'Team settings',
  routeMatch: { type: 'exact', value: '/settings/team' },
  startPath: null,
  createdAt: '2026-10-19T00:00:00Z',
  updatedAt: '2026-10-19T00:00:00Z',
};

const version = (over: Partial<GuideVersion>): GuideVersion => ({
  id: 'v1',
  guide_id: 'g1',
  version_number: 1,
  steps: [{ id: 's1', order: 0, type: 'tooltip', content: '<p>Hi</p>', actions: [] }],
  route_match: { type: 'exact', value: '/dashboard' },
  page_id: null,
  start_at: null,
  end_at: null,
  account_ids: null,
  help: null,
  published_at: '2026-10-19T00:00:00Z',
  created_at: '2026-10-19T00:00:00Z',
  ...over,
});

const guide = (versions: GuideVersion[]): GuideDetail => ({
  id: 'g1',
  name: 'Welcome',
  type: 'tooltip',
  status: versions.length ? 'published' : 'draft',
  enabled: false,
  current_version_id: versions[0]?.id ?? null,
  versions,
});

describe('GuideEditorComponent', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [GuideEditorComponent],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
    });
    http = TestBed.inject(HttpTestingController);
    TestBed.inject(AuthService).me.set({
      user: { id: 'u', email: null, name: null, platformAdmin: false },
      orgs: [
        {
          id: 'o1',
          name: 'Acme',
          role: 'owner',
          suspendedAt: null,
          apps: [{ id: 'a1', name: 'Web', role: 'app_admin' }],
        },
      ],
    });
  });

  async function render(detail: GuideDetail, pages: AppPage[] = [team]) {
    const fixture = TestBed.createComponent(GuideEditorComponent);
    fixture.componentRef.setInput('orgId', 'o1');
    fixture.componentRef.setInput('appId', 'a1');
    fixture.componentRef.setInput('id', 'g1');
    fixture.detectChanges();
    await fixture.whenStable();
    http.expectOne('/api/v1/apps/a1/guides/g1').flush(detail);
    http.expectOne('/api/v1/apps/a1/pages').flush(pages);
    await fixture.whenStable();
    fixture.detectChanges();
    return fixture;
  }

  function publishBody(): PublishPayload {
    const req = http.expectOne('/api/v1/apps/a1/guides/g1/publish');
    req.flush({ id: 'v2', versionNumber: 2 });
    http.expectOne('/api/v1/apps/a1/guides/g1').flush(guide([]));
    return req.request.body as PublishPayload;
  }

  // The analytics panel loads on its own (after the guide arrives); not under test here.
  afterEach(() => {
    http
      .match('/api/v1/apps/a1/guides/g1/analytics')
      .forEach((r) => r.flush({ guideId: 'g1', counts: [], steps: [], startedFromHelp: 0 }));
    http.verify();
  });

  it('publishes a version on a saved page with pageId and no routeMatch', async () => {
    const fixture = await render(guide([version({ page_id: 'p1', route_match: team.routeMatch })]));
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector<HTMLInputElement>('input[value="page"]')!.checked).toBe(true);
    expect(el.querySelector<HTMLSelectElement>('select[aria-label="Saved page"]')!.value).toBe('p1');

    fixture.componentInstance.publish();
    const body = publishBody();
    expect(body.pageId).toBe('p1');
    expect(body.routeMatch).toBeUndefined();
  });

  it('publishes a custom route with routeMatch and no pageId', async () => {
    const fixture = await render(guide([version({})]));
    fixture.componentInstance.publish();
    const body = publishBody();
    expect(body.routeMatch).toEqual({ type: 'exact', value: '/dashboard' });
    expect(body.pageId).toBeUndefined();
  });

  it('ignores an invalid custom route once a saved page is chosen', async () => {
    const fixture = await render(guide([version({ route_match: { type: 'exact', value: 'not-a-path' } })]));
    const form = fixture.componentInstance['form'];
    expect(form.invalid).toBe(true);
    form.controls.where.setValue('page');
    form.controls.pageId.setValue('p1');
    expect(form.invalid).toBe(false);
    fixture.componentInstance.publish();
    expect(publishBody().pageId).toBe('p1');
  });

  it('starts a brand-new guide on a saved page when the app has pages, else on a custom route', async () => {
    let fixture = await render(guide([]));
    expect(fixture.componentInstance['form'].controls.where.value).toBe('page');
    fixture.destroy();
    fixture = await render(guide([]), []);
    expect(fixture.componentInstance['form'].controls.where.value).toBe('custom');
  });
});
