import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from './auth.service';

/**
 * Requires a signed-in user with `role`. UX only — the backend enforces roles
 * on every request. Unauthenticated users go to login with a returnUrl so SSO
 * can bring them back where they were heading.
 */
export function roleGuard(role: string): CanActivateFn {
  return (_route, state) => {
    const auth = inject(AuthService);
    const router = inject(Router);
    if (!auth.token()) return router.createUrlTree(['/login'], { queryParams: { returnUrl: state.url } });
    return auth.hasRole(role) ? true : router.createUrlTree([auth.homePath()]);
  };
}
