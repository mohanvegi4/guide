import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { catchError, throwError } from 'rxjs';
import { AuthService, EXPLICIT_AUTH } from './auth.service';

/** Attaches the bearer token; a 401 (expired/invalid token) sends the author back to login. */
export const authInterceptor: HttpInterceptorFn = (req, next) => {
  // Sign-in probes (GET /auth/me with a candidate token) set their own header
  // and handle their own errors.
  if (req.context.get(EXPLICIT_AUTH)) return next(req);

  const auth = inject(AuthService);
  const router = inject(Router);
  const token = auth.token();
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
  // Support mode: a platform admin reading one customer's organization. The
  // header turns the ordinary org/app routes into read-only, logged reads of
  // that organization (backend: context.ts). /me and /platform stay as the
  // admin themselves.
  const support = auth.supportOrg();
  if (support && !/^\/api\/v1\/(me$|platform\/)/.test(req.url)) headers['X-Support-Org'] = support.id;
  const authed = Object.keys(headers).length ? req.clone({ setHeaders: headers }) : req;

  return next(authed).pipe(
    catchError((err: unknown) => {
      if (err instanceof HttpErrorResponse && err.status === 401) {
        auth.logout();
        void router.navigate(['/login'], { queryParams: { expired: 1 } });
      }
      return throwError(() => err);
    }),
  );
};
