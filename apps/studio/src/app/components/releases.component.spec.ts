import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ReleasesComponent } from './releases.component';
import { GuideDetail, GuideRelease, GuideVersion } from '../core/models';

const version = (n: number, published = true): GuideVersion => ({
  id: `v${n}`,
  guide_id: 'g1',
  version_number: n,
  steps: [],
  route_match: { type: 'exact', value: '/' },
  page_id: null,
  start_at: null,
  end_at: null,
  account_ids: null,
  visitor_tags: null,
  help: null,
  activation: 'auto',
  published_at: published ? '2026-10-20T00:00:00Z' : null,
  created_at: '2026-10-20T00:00:00Z',
});

const guide: GuideDetail = {
  id: 'g1',
  name: 'Welcome',
  type: 'tooltip',
  status: 'published',
  enabled: true,
  current_version_id: 'v1',
  versions: [version(1), version(2), version(3, false)],
};

const env = (
  environmentId: string,
  name: string,
  position: number,
  versionNumber: number | null,
): GuideRelease => ({
  environmentId,
  name,
  position,
  versionId: versionNumber ? `v${versionNumber}` : null,
  versionNumber,
  releasedAt: versionNumber ? '2026-10-21T00:00:00Z' : null,
  canRevert: versionNumber !== null,
  history: versionNumber
    ? [
        {
          action: 'release',
          versionNumber,
          at: '2026-10-21T00:00:00Z',
          by: 'Alice',
          reverted: false,
        },
      ]
    : [],
});

describe('ReleasesComponent', () => {
  let http: HttpTestingController;

  async function render(releases: GuideRelease[], canPublish = true) {
    TestBed.configureTestingModule({
      imports: [ReleasesComponent],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(ReleasesComponent);
    fixture.componentRef.setInput('appId', 'a1');
    fixture.componentRef.setInput('guide', guide);
    fixture.componentRef.setInput('canPublish', canPublish);
    fixture.detectChanges();
    await fixture.whenStable();
    http.expectOne('/api/v1/apps/a1/guides/g1/releases').flush(releases);
    await fixture.whenStable();
    return fixture;
  }

  const buttons = (el: HTMLElement) =>
    [...el.querySelectorAll('button')].map((b) => b.textContent?.trim());

  afterEach(() => http.verify());

  it('shows what each stage runs and offers the next promotion; drafts are never offered', async () => {
    const fixture = await render([
      env('t', 'Test', 1, 2),
      env('a', 'Accept', 2, 1),
      env('p', 'Production', 3, 1),
    ]);
    const el = fixture.nativeElement as HTMLElement;
    expect([...el.querySelectorAll('.release-row strong')].map((s) => s.textContent)).toEqual([
      'Test',
      'Accept',
      'Production',
    ]);
    // Accept already runs what Production runs: nothing to promote from there.
    expect(buttons(el).filter((b) => b?.startsWith('Promote'))).toEqual(['Promote to Accept']);
    const options = [...el.querySelector('select')!.querySelectorAll('option')].map(
      (o) => o.textContent?.trim(),
    );
    expect(options).toEqual(['v2', 'v1']);

    const changed = vi.fn();
    fixture.componentInstance.changed.subscribe(changed);
    [...el.querySelectorAll('button')]
      .find((b) => b.textContent?.includes('Promote to Accept'))!
      .click();
    const req = http.expectOne('/api/v1/apps/a1/guides/g1/promote');
    expect(req.request.body).toEqual({ from: 't' });
    req.flush([env('t', 'Test', 1, 2), env('a', 'Accept', 2, 2), env('p', 'Production', 3, 1)]);
    await fixture.whenStable();
    expect(changed).toHaveBeenCalled();
    expect(el.textContent).toContain('Promoted v2 to Accept.');
  });

  it('asks before changing production, and reverts or withdraws one environment', async () => {
    const fixture = await render([env('t', 'Test', 1, 2), env('p', 'Production', 2, 1)]);
    const el = fixture.nativeElement as HTMLElement;
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    [...el.querySelectorAll('button')]
      .find((b) => b.textContent?.includes('Promote to Production'))!
      .click();
    expect(confirm).toHaveBeenCalled();
    http.expectNone('/api/v1/apps/a1/guides/g1/promote');

    confirm.mockReturnValue(true);
    const reverts = [...el.querySelectorAll('button')].filter(
      (b) => b.textContent?.trim() === 'Revert',
    );
    reverts[0].click();
    http
      .expectOne('/api/v1/apps/a1/guides/g1/releases/t/revert')
      .flush([env('t', 'Test', 1, 1), env('p', 'Production', 2, 1)]);
    await fixture.whenStable();

    const withdraw = [...el.querySelectorAll('button')].filter(
      (b) => b.textContent?.trim() === 'Withdraw',
    )[1];
    withdraw.click();
    const req = http.expectOne('/api/v1/apps/a1/guides/g1/releases');
    expect(req.request.body).toEqual({ environmentId: 'p', versionId: null });
    req.flush([env('t', 'Test', 1, 1), env('p', 'Production', 2, null)]);
    await fixture.whenStable();
    expect(el.textContent).toContain('Nothing released');
  });

  it('is read-only without the publisher role', async () => {
    const fixture = await render([env('p', 'Production', 1, 1)], false);
    const el = fixture.nativeElement as HTMLElement;
    expect(buttons(el)).toEqual([]);
    expect(el.querySelector('select')).toBeNull();
    expect(el.textContent).toContain('History (1)');
  });
});
