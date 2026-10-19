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
  const authed = token ? req.clone({ setHeaders: { Authorization: `Bearer ${token}` } }) : req;

  return next(authed).pipe(
    catchError((err: unknown) => {
      if (err instanceof HttpErrorResponse && err.status === 401) {
        auth.logout();
        void router.navigate(['/login'], { queryParams: { expired: 1 } });
      }
      return throwError(() => err);
    })
  );
};
