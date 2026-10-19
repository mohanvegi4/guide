import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { OperatorComponent } from './operator.component';
import { AuthService } from '../core/auth.service';
import { PlatformOrg } from '../core/models';

const acme: PlatformOrg = {
  id: 'o1',
  name: 'Acme',
  createdAt: '2026-10-01T00:00:00Z',
  suspendedAt: null,
  supportAccessUntil: null,
  owners: [{ name: 'Olivia Owner', email: 'olivia@acme.test' }],
  usage: { members: 3, apps: 2, guides: 5, events30d: 1234 },
};
const globex: PlatformOrg = {
  ...acme,
  id: 'o2',
  name: 'Globex',
  suspendedAt: '2026-10-10T00:00:00Z',
  supportAccessUntil: '2026-12-01T00:00:00Z',
  owners: [{ name: null, email: 'hank@globex.test' }],
};

describe('OperatorComponent', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [OperatorComponent],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
    });
    http = TestBed.inject(HttpTestingController);
    TestBed.inject(AuthService).me.set({
      user: { id: 'root', email: 'root@ge.test', name: 'Root', platformAdmin: true },
      orgs: [],
    });
  });

  async function render() {
    const fixture = TestBed.createComponent(OperatorComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    http.expectOne('/api/v1/platform/orgs').flush([acme, globex]);
    http.expectOne('/api/v1/platform/admins').flush([
      { id: 'root', email: 'root@ge.test', name: 'Root', lastSeenAt: '2026-10-19T00:00:00Z' },
      { id: 'sam', email: 'sam@ge.test', name: null, lastSeenAt: '2026-10-19T00:00:00Z' },
    ]);
    http.expectOne('/api/v1/platform/kill-switch').flush({ enabled: true });
    await fixture.whenStable();
    fixture.detectChanges();
    return fixture;
  }

  const rows = (el: HTMLElement) => Array.from(el.querySelectorAll('tbody tr'));
  const button = (scope: Element, label: string) =>
    Array.from(scope.querySelectorAll('button')).find((b) => b.textContent?.trim() === label)!;

  afterEach(() => http.verify());

  it('lists organizations with owners, usage, status and support access', async () => {
    const el = (await render()).nativeElement as HTMLElement;
    const [a, g] = rows(el).map((r) => r.textContent?.replace(/\s+/g, ' ') ?? '');
    expect(a).toContain('Acme');
    expect(a).toContain('Olivia Owner');
    expect(a).toContain('1234');
    expect(a).toContain('active');
    expect(a).toContain('not granted');
    expect(g).toContain('suspended');
    expect(g).toContain('granted until');
  });

  it('"Open" is only possible with support access and no suspension', async () => {
    const el = (await render()).nativeElement as HTMLElement;
    const [a, g] = rows(el);
    expect(button(a, 'Open (read-only)').disabled).toBe(true); // not granted
    expect(button(g, 'Open (read-only)').disabled).toBe(true); // granted but suspended
  });

  it('suspends an organization after confirmation', async () => {
    const fixture = await render();
    const el = fixture.nativeElement as HTMLElement;
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    button(rows(el)[0], 'Suspend').click();
    const req = http.expectOne('/api/v1/platform/orgs/o1/suspension');
    expect(req.request.body).toEqual({ suspended: true });
    req.flush({ id: 'o1', suspendedAt: '2026-10-19T12:00:00Z' });
    await fixture.whenStable();
    fixture.detectChanges();
    expect(rows(el)[0].textContent).toContain('suspended');
    expect(button(rows(el)[0], 'Lift suspension')).toBeTruthy();
  });

  it('lists platform admins and cannot remove yourself', async () => {
    const el = (await render()).nativeElement as HTMLElement;
    const items = Array.from(el.querySelectorAll('.versions li'));
    expect(items).toHaveLength(2);
    expect(button(items[0], 'Remove').disabled).toBe(true); // root = me
    expect(button(items[1], 'Remove').disabled).toBe(false);
  });
});
