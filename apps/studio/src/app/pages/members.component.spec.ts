import { TestBed } from '@angular/core/testing';
import { HttpHeaders, provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Router, provideRouter } from '@angular/router';
import { MembersComponent } from './members.component';
import { AuthService } from '../core/auth.service';
import { OrgRole } from '../core/models';

/** The Members page's danger zone: export and delete the organization (owners only). */
describe('MembersComponent danger zone', () => {
  let http: HttpTestingController;

  async function render(role: OrgRole) {
    TestBed.configureTestingModule({
      imports: [MembersComponent],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
    });
    http = TestBed.inject(HttpTestingController);
    const auth = TestBed.inject(AuthService);
    auth.token.set('t');
    auth.me.set({
      user: { id: 'u1', email: 'olivia@acme.test', name: 'Olivia', platformAdmin: false },
      orgs: [
        {
          id: 'o1',
          name: 'Acme',
          role,
          suspendedAt: null,
          apps: [{ id: 'a1', name: 'Web', role: 'app_admin' }],
        },
      ],
    });
    const fixture = TestBed.createComponent(MembersComponent);
    fixture.componentRef.setInput('orgId', 'o1');
    fixture.detectChanges();
    await fixture.whenStable();
    http.expectOne('/api/v1/orgs/o1/members').flush([]);
    http.expectOne('/api/v1/orgs/o1/invitations').flush([]);
    http
      .expectOne('/api/v1/orgs/o1/support-access')
      .flush({ active: false, until: null, grantedBy: null, maxDays: 90, log: [] });
    await fixture.whenStable();
    fixture.detectChanges();
    return fixture;
  }

  const dangerZone = (el: HTMLElement) => el.querySelector('section.danger-zone');
  const button = (scope: Element, label: string) =>
    Array.from(scope.querySelectorAll('button')).find((b) => b.textContent?.trim() === label)!;

  afterEach(() => http.verify());

  it('is shown to owners only', async () => {
    expect(dangerZone((await render('manager')).nativeElement)).toBeNull();
    TestBed.resetTestingModule();
    expect(dangerZone((await render('owner')).nativeElement)).not.toBeNull();
  });

  it('downloads the export under the name the backend gives it', async () => {
    const fixture = await render('owner');
    const el = fixture.nativeElement as HTMLElement;
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:export');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);

    button(dangerZone(el)!, 'Export organization data').click();
    const req = http.expectOne('/api/v1/orgs/o1/export');
    expect(req.request.responseType).toBe('blob');
    req.flush(new Blob(['{}'], { type: 'application/json' }), {
      headers: new HttpHeaders({
        'content-disposition': 'attachment; filename="guide-engine-acme-2026-10-19.json"',
      }),
    });
    await fixture.whenStable();
    fixture.detectChanges();

    expect(anchorClick).toHaveBeenCalledTimes(1);
    const anchor = anchorClick.mock.instances[0] as HTMLAnchorElement;
    expect(anchor.download).toBe('guide-engine-acme-2026-10-19.json');
    expect(dangerZone(el)!.textContent).toContain('Downloaded guide-engine-acme-2026-10-19.json');
  });

  it('deletes only after the exact name is typed, then leaves the organization', async () => {
    const fixture = await render('owner');
    const el = fixture.nativeElement as HTMLElement;
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    const zone = dangerZone(el)!;
    const input = zone.querySelector<HTMLInputElement>('input[name="confirmName"]')!;
    const submit = button(zone, 'Delete organization');
    expect(submit.disabled).toBe(true);

    input.value = 'acme';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(submit.disabled).toBe(true);

    input.value = 'Acme';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(submit.disabled).toBe(false);
    zone.querySelector('form')!.dispatchEvent(new Event('submit'));
    const req = http.expectOne('/api/v1/orgs/o1');
    expect(req.request.method).toBe('DELETE');
    expect(req.request.body).toEqual({ confirmName: 'Acme' });
    req.flush(null, { status: 204, statusText: 'No Content' });
    await fixture.whenStable();
    // /me is re-read before leaving, so the home path no longer points at the deleted org.
    http
      .expectOne('/api/v1/me')
      .flush({ user: { id: 'u1', email: null, name: null, platformAdmin: false }, orgs: [] });
    await new Promise((resolve) => setTimeout(resolve)); // let the refresh() continuation run
    expect(navigate).toHaveBeenCalledWith('/welcome');
  });
});
