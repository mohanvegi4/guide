import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { AuthService } from './auth.service';

const tenantId = '3fa85f64-5717-4562-b3fc-2c963f66afa6';

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

  /** Starts a paste login and answers the backend's /auth/me probe. */
  async function pasteLogin(raw: string, me: object | { status: number }) {
    const result = auth.loginWithToken(raw);
    const req = http.expectOne('/api/auth/me');
    if ('status' in me) req.flush({ error: 'invalid_token' }, { status: me.status as number, statusText: 'x' });
    else req.flush(me);
    return { result: await result, req };
  }

  it('verifies a pasted token with the backend and adopts the identity it returns', async () => {
    const { result, req } = await pasteLogin('Bearer abc.def.ghi', { tenantId, userId: 'alice', roles: ['guide_admin'] });
    expect(req.request.headers.get('Authorization')).toBe('Bearer abc.def.ghi');
    expect(result).toBeNull();
    expect(auth.token()).toBe('abc.def.ghi');
    expect(auth.info()?.userId).toBe('alice');
    expect(sessionStorage.getItem('guide-studio-token')).toBe('abc.def.ghi');
  });

  it('rejects tokens the backend rejects, and identities without an authoring role', async () => {
    expect((await pasteLogin('bad', { status: 401 })).result).toMatch(/rejected/);
    expect((await pasteLogin('t', { tenantId, userId: 'bob', roles: [] })).result).toMatch(/guide_admin/);
    expect(auth.token()).toBeNull();
  });

  it('lands platform-only admins on global guides, and dual-role admins on tenant guides', async () => {
    await pasteLogin('t1', { tenantId, userId: 'pat', roles: ['platform_admin'] });
    expect(auth.homePath()).toBe('/global');
    await pasteLogin('t2', { tenantId, userId: 'x', roles: ['guide_admin', 'platform_admin'] });
    expect(auth.homePath()).toBe('/guides');
  });

  it('init() restores a stored token only if the backend still accepts it', async () => {
    sessionStorage.setItem('guide-studio-token', 'stale');
    const done = auth.init();
    http.expectOne('/api/auth/config').flush({ oidc: null, tokenPaste: true });
    await Promise.resolve();
    await Promise.resolve();
    http.expectOne('/api/auth/me').flush({}, { status: 401, statusText: 'Unauthorized' });
    await done;
    expect(auth.token()).toBeNull();
    expect(sessionStorage.getItem('guide-studio-token')).toBeNull();
  });

  it('logout clears the session', async () => {
    await pasteLogin('t', { tenantId, userId: 'a', roles: ['guide_admin'] });
    auth.logout();
    expect([auth.token(), auth.info()]).toEqual([null, null]);
    expect(sessionStorage.getItem('guide-studio-token')).toBeNull();
  });
});
