import { inject } from '@angular/core';
import { ActivatedRouteSnapshot, CanActivateFn, Router } from '@angular/router';
import { AuthService } from './auth.service';
import { AppRole, appRoleAtLeast } from './models';

/**
 * Route guards are UX only — the backend enforces access on every request.
 * Unauthenticated users go to login with a returnUrl so SSO can bring them back.
 */
export const signedIn: CanActivateFn = (_route, state) => {
  const auth = inject(AuthService);
  return auth.token() ? true : inject(Router).createUrlTree(['/login'], { queryParams: { returnUrl: state.url } });
};

/** Requires membership of the :orgId in the URL. */
export const orgMember: CanActivateFn = (route: ActivatedRouteSnapshot, state) => {
  const auth = inject(AuthService);
  if (!auth.token()) return inject(Router).createUrlTree(['/login'], { queryParams: { returnUrl: state.url } });
  return auth.org(route.paramMap.get('orgId')) ? true : inject(Router).createUrlTree([auth.homePath()]);
};

/** Requires at least `min` on the :appId in the URL. */
export function appRole(min: AppRole): CanActivateFn {
  return (route, state) => {
    const auth = inject(AuthService);
    if (!auth.token()) return inject(Router).createUrlTree(['/login'], { queryParams: { returnUrl: state.url } });
    return appRoleAtLeast(auth.appRole(route.paramMap.get('appId')), min)
      ? true
      : inject(Router).createUrlTree([auth.homePath()]);
  };
}
