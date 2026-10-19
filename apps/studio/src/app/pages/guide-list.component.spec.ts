import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ActivatedRoute, provideRouter } from '@angular/router';
import { GuideListComponent } from './guide-list.component';
import { GuideSummary } from '../core/models';

const guide: GuideSummary = {
  id: 'g1',
  name: 'Welcome',
  type: 'tooltip',
  status: 'published',
  enabled: false,
  current_version_id: 'v1',
  current_version_number: 1,
  updated_at: '2026-10-07T00:00:00Z',
};

describe('GuideListComponent', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [GuideListComponent],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  async function render() {
    const fixture = TestBed.createComponent(GuideListComponent);
    fixture.detectChanges();
    http.expectOne('/api/guides').flush([guide]);
    await fixture.whenStable();
    return fixture;
  }

  it('lists guides with their live version', async () => {
    const fixture = await render();
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Welcome');
    expect(text).toContain('v1');
  });

  it('toggles enabled optimistically and reverts when the backend rejects it', async () => {
    const fixture = await render();
    const checkbox = (fixture.nativeElement as HTMLElement).querySelector<HTMLInputElement>('input[type=checkbox]')!;

    checkbox.checked = true;
    checkbox.dispatchEvent(new Event('change'));
    await fixture.whenStable();
    expect(checkbox.checked).toBe(true); // optimistic

    const req = http.expectOne('/api/guides/g1/flag');
    expect(req.request.method).toBe('PATCH');
    expect(req.request.body).toEqual({ enabled: true });
    req.flush({ error: 'not_found' }, { status: 404, statusText: 'Not Found' });
    await fixture.whenStable();

    expect(checkbox.checked).toBe(false); // reverted
    expect((fixture.nativeElement as HTMLElement).querySelector('.error')?.textContent).toContain('Not found');
  });
});

describe('GuideListComponent (global scope)', () => {
  it('uses the platform API and labels the page', async () => {
    TestBed.configureTestingModule({
      imports: [GuideListComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: ActivatedRoute, useValue: { snapshot: { data: { scope: 'global' } } } },
      ],
    });
    const http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(GuideListComponent);
    fixture.detectChanges();
    http.expectOne('/api/platform/guides').flush([{ ...guide, id: 'glob' }]);
    await fixture.whenStable();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Global guides');
    http.verify();
  });
});
