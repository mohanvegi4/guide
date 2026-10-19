import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { AuthService } from './auth.service';
import { Me } from './models';

const me = (orgs: Me['orgs'] = []): Me => ({ user: { id: 'u1', email: 'a@example.com', name: 'Alice' }, orgs });

describe('AuthService', () => {
  let auth: AuthService;
  let http: HttpTestingController;

  beforeEach(() => {
    sessionStorage.clear();
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    auth = TestBed.inject(AuthService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  /** Starts a paste login and answers the backend's /v1/me probe. */
  async function pasteLogin(raw: string, reply: Me | { status: number }) {
    const result = auth.loginWithToken(raw);
    const req = http.expectOne('/api/v1/me');
    if ('status' in reply) req.flush({ error: 'invalid_token' }, { status: reply.status, statusText: 'x' });
    else req.flush(reply);
    return { result: await result, req };
  }

  it('verifies a pasted token with the backend and adopts the identity it returns', async () => {
    const { result, req } = await pasteLogin('Bearer abc.def.ghi', me());
    expect(req.request.headers.get('Authorization')).toBe('Bearer abc.def.ghi');
    expect(result).toBeNull();
    expect(auth.token()).toBe('abc.def.ghi');
    expect(auth.me()?.user.name).toBe('Alice');
    expect(sessionStorage.getItem('guide-studio-token')).toBe('abc.def.ghi');
  });

  it('rejects tokens the backend rejects', async () => {
    expect((await pasteLogin('bad', { status: 401 })).result).toMatch(/rejected/);
    expect(auth.token()).toBeNull();
  });

  it('sends new users to onboarding, members to their first app', async () => {
    await pasteLogin('t1', me());
    expect(auth.homePath()).toBe('/welcome');
    await pasteLogin(
      't2',
      me([
        { id: 'o-empty', name: 'Empty', role: 'member', apps: [] },
        { id: 'o1', name: 'Acme', role: 'owner', apps: [{ id: 'a1', name: 'Web', role: 'app_admin' }] },
      ])
    );
    expect(auth.homePath()).toBe('/o/o1/apps/a1/guides');
    expect(auth.appRole('a1')).toBe('app_admin');
    expect(auth.orgRole('o-empty')).toBe('member');
  });

  it('init() restores a stored token only if the backend still accepts it', async () => {
    sessionStorage.setItem('guide-studio-token', 'stale');
    const done = auth.init();
    http.expectOne('/api/auth/config').flush({ oidc: null, tokenPaste: true });
    await Promise.resolve();
    await Promise.resolve();
    http.expectOne('/api/v1/me').flush({}, { status: 401, statusText: 'Unauthorized' });
    await done;
    expect(auth.token()).toBeNull();
    expect(sessionStorage.getItem('guide-studio-token')).toBeNull();
  });

  it('logout clears the session', async () => {
    await pasteLogin('t', me());
    auth.logout();
    expect([auth.token(), auth.me()]).toEqual([null, null]);
  });
});
