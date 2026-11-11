
import { inject } from '@angular/core';

import {
  CanActivateFn,
  Router,
} from '@angular/router';

import {
  HttpErrorResponse,
} from '@angular/common/http';

import {
  catchError,
  map,
  of,
} from 'rxjs';

import { AuthService } from '../services/auth';

/**
 * FINDSTER - AUTHENTICATION GUARD
 *
 * Protect authenticated routes without
 * logging users out for temporary
 * connection or server errors.
 */
export const authGuard: CanActivateFn = () => {
  const router = inject(Router);
  const authService = inject(AuthService);

  // --------------------------------------
  // 1. CHECK LOCAL AUTHENTICATION TOKEN
  // --------------------------------------

  const token = authService.getToken();

  if (!token) {
    return router.createUrlTree(['/login']);
  }

  // --------------------------------------
  // 2. VALIDATE SESSION WITH BACKEND
  // --------------------------------------

  return authService.validateSession().pipe(
    map(() => true),

    catchError((error: unknown) => {
      // ----------------------------------
      // 3. EXPIRED OR INVALID TOKEN
      // ----------------------------------

      if (
        error instanceof HttpErrorResponse &&
        error.status === 401
      ) {
        authService.logout();

        return of(
          router.createUrlTree(['/login'], {
            queryParams: {
              reason: 'session-expired',
            },
          }),
        );
      }

      // ----------------------------------
      // 4. TEMPORARY NETWORK ERROR
      // ----------------------------------

      if (
        error instanceof HttpErrorResponse &&
        error.status === 0
      ) {
        console.warn(
          '[AuthGuard] Network unavailable. Session preserved.',
        );

        return of(
          router.createUrlTree(['/login'], {
            queryParams: {
              reason: 'connection-error',
            },
          }),
        );
      }

      // ----------------------------------
      // 5. BACKEND SERVER ERROR
      // ----------------------------------

      if (
        error instanceof HttpErrorResponse &&
        error.status >= 500
      ) {
        console.warn(
          '[AuthGuard] Backend unavailable. Session preserved.',
        );

        return of(
          router.createUrlTree(['/login'], {
            queryParams: {
              reason: 'server-error',
            },
          }),
        );
      }

      // ----------------------------------
      // 6. FORBIDDEN / OTHER ERRORS
      // ----------------------------------

      console.warn(
        '[AuthGuard] Session validation failed without confirmed expiry.',
      );

      // Keep the token, but do not allow
      // access to the protected page.
      return of(
        router.createUrlTree(['/login'], {
          queryParams: {
            reason: 'validation-error',
          },
        }),
      );
    }),
  );
};
