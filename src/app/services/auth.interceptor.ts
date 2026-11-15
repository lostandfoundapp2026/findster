
import { inject } from '@angular/core';

import {
  HttpInterceptorFn,
  HttpErrorResponse,
  HttpContextToken,
} from '@angular/common/http';

import { Router } from '@angular/router';

import {
  catchError,
  throwError,
} from 'rxjs';

import { environment } from '../../environments/environment';
import { AuthService } from './auth';

// Requests with this context will not trigger
// automatic session-expiry handling.
export const SKIP_AUTH_REDIRECT =
  new HttpContextToken<boolean>(() => false);

export const authInterceptor: HttpInterceptorFn = (
  req,
  next,
) => {
  const router = inject(Router);
  const authService = inject(AuthService);

  const apiBaseUrl =
    environment.apiBaseUrl.replace(/\/+$/, '');

  const isApiRequest =
    req.url.startsWith(`${apiBaseUrl}/api/`);

  const isPublicAuthRequest =
    req.url === `${apiBaseUrl}/api/login` ||
    req.url === `${apiBaseUrl}/api/register`;

  const token = authService.getToken();

  const authReq =
    token && isApiRequest && !isPublicAuthRequest
      ? req.clone({
          setHeaders: {
            Authorization: `Bearer ${token}`,
          },
        })
      : req;

  return next(authReq).pipe(
    catchError((error: unknown) => {
      if (!(error instanceof HttpErrorResponse)) {
        return throwError(() => error);
      }

      const shouldHandleExpiredSession =
        error.status === 401 &&
        isApiRequest &&
        !isPublicAuthRequest &&
        !req.context.get(SKIP_AUTH_REDIRECT) &&
        !!token &&
        authService.getToken() === token;

      if (shouldHandleExpiredSession) {
        // Run existing session and FCM cleanup.
        authService.logout();

        void router.navigate(['/login'], {
          queryParams: {
            reason: 'session-expired',
          },
          replaceUrl: true,
        });
      }

      // Always propagate errors to their callers.
      return throwError(() => error);
    }),
  );
};
