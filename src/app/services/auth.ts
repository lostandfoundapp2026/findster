// Save as: src/app/services/auth.ts

import { Injectable } from '@angular/core';

import {

  HttpClient,

  HttpErrorResponse,

  HttpHeaders,

} from '@angular/common/http';

import { Capacitor } from '@capacitor/core';

import { PushNotifications } from '@capacitor/push-notifications';

import {

  Observable,

  firstValueFrom,

  map,

  tap,

  timeout,

} from 'rxjs';

import { environment } from '../../environments/environment';

export interface AuthUser {

  id: number;

  full_name: string;

  first_name?: string | null;

  middle_name?: string | null;

  last_name?: string | null;

  email: string;

  contact_number: string;

  barangay: string;

}

export interface LoginResponse {

  message?: string;

  access_token: string;

  token_type: string;

  expires_in: number;

  user: AuthUser;

}

export interface RegisterData {

  first_name: string;

  middle_name?: string | null;

  last_name: string;

  // Preserve compatibility with existing registration callers.

  full_name?: string;

  email: string;

  contact_number: string;

  barangay: string;

  password: string;

}

export interface RegisterResponse {

  message: string;

  user: AuthUser;

}

// Email changes require a separate verified workflow.
export interface UpdateProfileData {
  first_name: string;
  middle_name?: string | null;
  last_name: string;
  contact_number: string;
  barangay: string;
}

@Injectable({ providedIn: 'root' })

export class AuthService {

  private readonly apiUrl =

    `${environment.apiBaseUrl.replace(/\/+$/, '')}/api`;

  private readonly fcmTokenStorageKey = 'device_fcm_token';

  private pushListenerReady: Promise<void> = Promise.resolve();

  private currentFcmToken: string | null = null;

  private lastRegisteredFor: string | null = null;

  // Ensures that push operations run in order.

  private pushOperationQueue: Promise<void> = Promise.resolve();

  // Incremented whenever authentication changes.

  private sessionGeneration = 0;

  constructor(private readonly http: HttpClient) {

    if (this.isNativeAndroid()) {

      this.pushListenerReady =

        this.attachPushRegistrationListener();

      void this.syncPushRegistration();

    }

  }

  login(

    email: string,

    password: string,

  ): Observable<LoginResponse> {

    return this.http

      .post<LoginResponse>(

        `${this.apiUrl}/login`,

        { email, password },

      )

      .pipe(

        tap((response) => {

          const oldToken = this.getToken();

          const oldUser = this.getCurrentUser();

          const deviceToken = this.getCachedFcmToken();

          this.sessionGeneration++;

          this.lastRegisteredFor = null;

          // If a different account was previously active,

          // queue its device unregistration first.

          if (

            this.isNativeAndroid() &&

            oldToken &&

            oldUser &&

            oldUser.id !== response.user.id &&

            deviceToken

          ) {

            this.queueUnregistration(

              oldToken,

              deviceToken,

            );

          }

          localStorage.setItem(

            'access_token',

            response.access_token,

          );

          localStorage.setItem(

            'auth_user',

            JSON.stringify(this.normalizeUser(response.user)),

          );

          console.info(

            '[Push] Login successful; synchronizing device.',

          );

          void this.syncPushRegistration();

        }),

      );

  }

  register(

    data: RegisterData,

  ): Observable<RegisterResponse> {

    return this.http.post<RegisterResponse>(

      `${this.apiUrl}/register`,

      data,

    );

  }

  // Update only the authenticated resident's editable profile details.
  // The interceptor supplies the current access token.
  updateProfile(data: UpdateProfileData): Observable<AuthUser> {
    return this.http.patch<AuthUser | { user: AuthUser }>(
      `${this.apiUrl}/me`,
      data,
    ).pipe(
      map((response) => {
        const updated = 'user' in response ? response.user : response;
        const previous = this.getCurrentUser();
        const normalized = this.normalizeUser(
          updated,
          previous?.id === updated.id ? previous : null,
        );
        localStorage.setItem('auth_user', JSON.stringify(normalized));
        return normalized;
      }),
    );
  }

  // Refresh the authenticated account from the server without losing

  // fields when an API response contains only a partial user object.

  validateSession(): Observable<AuthUser> {

    return this.http.get<AuthUser>(`${this.apiUrl}/me`).pipe(

      tap((user) => {

        const current = this.getCurrentUser();

        const sameAccount = current?.id === user?.id;

        const completeUser = this.normalizeUser(user, sameAccount ? current : null);

        localStorage.setItem('auth_user', JSON.stringify(completeUser));

        void this.syncPushRegistration();

      }),

    );

  }

  logout(): void {

    const oldJwt = this.getToken();

    const deviceToken = this.getCachedFcmToken();

    // Invalidate pending client-side registration work.

    this.sessionGeneration++;

    this.lastRegisteredFor = null;

    if (

      this.isNativeAndroid() &&

      oldJwt &&

      deviceToken

    ) {

      this.queueUnregistration(

        oldJwt,

        deviceToken,

      );

    }

    // Remove authentication immediately.

    localStorage.removeItem('access_token');

    localStorage.removeItem('auth_user');

    // Retain the FCM token so it can be registered

    // to the next authenticated account.

    console.info(

      '[Auth] Local session cleared; push cleanup queued.',

    );

  }

  getToken(): string | null {

    return localStorage.getItem('access_token');

  }

  getCurrentUser(): AuthUser | null {

    const storedUser = localStorage.getItem('auth_user');

    if (!storedUser) return null;

    try {

      const value: unknown = JSON.parse(storedUser);

      if (!value || typeof value !== 'object') return null;

      const user = value as Partial<AuthUser>;

      if (!Number.isSafeInteger(user.id) || (user.id ?? 0) <= 0) return null;

      // Optional profile fields must not invalidate an otherwise valid session.

      return this.normalizeUser(user);

    } catch {

      return null;

    }

  }

  private normalizeUser(user: Partial<AuthUser>, previous: AuthUser | null = null): AuthUser {

    const field = (value: unknown, fallback: string): string =>

      typeof value === 'string' && value.trim() ? value.trim() : fallback;

    return {

      id: user.id as number,

      full_name: field(user.full_name, previous?.full_name ?? ''),

      first_name: field(user.first_name, previous?.first_name ?? ''),

      middle_name: typeof user.middle_name === 'string'

        ? user.middle_name.trim()

        : (previous?.middle_name ?? null),

      last_name: field(user.last_name, previous?.last_name ?? ''),

      email: field(user.email, previous?.email ?? ''),

      contact_number: field(user.contact_number, previous?.contact_number ?? ''),

      barangay: field(user.barangay, previous?.barangay ?? ''),

    };

  }

  private isNativeAndroid(): boolean {

    return (

      Capacitor.isNativePlatform() &&

      Capacitor.getPlatform() === 'android'

    );

  }

  private authHeaders(token: string): HttpHeaders {

    return new HttpHeaders({

      Authorization: `Bearer ${token}`,

    });

  }

  private getCachedFcmToken(): string | null {

    return (

      this.currentFcmToken ||

      localStorage.getItem(this.fcmTokenStorageKey)

    );

  }

  private async attachPushRegistrationListener():

    Promise<void> {

    try {

      await PushNotifications.addListener(

        'registration',

        ({ value }) => {

          if (!value) return;

          const previousToken = this.getCachedFcmToken();

          this.currentFcmToken = value;

          localStorage.setItem(

            this.fcmTokenStorageKey,

            value,

          );

          console.info(

            '[Push] Device registration event received.',

          );

          // Remove the previous FCM token if it rotated.

          if (

            previousToken &&

            previousToken !== value

          ) {

            const jwt = this.getToken();

            if (jwt) {

              this.queueUnregistration(

                jwt,

                previousToken,

              );

            }

            this.lastRegisteredFor = null;

          }

          this.sendTokenForCurrentSession(value);

        },

      );

      await PushNotifications.addListener(

        'registrationError',

        () => {

          console.error(

            '[Push] Native FCM registration failed.',

          );

        },

      );

    } catch {

      console.warn(

        '[Push] Could not attach FCM listeners.',

      );

    }

  }

  private async syncPushRegistration(): Promise<void> {

    if (

      !this.isNativeAndroid() ||

      !this.getToken()

    ) {

      return;

    }

    const generation = this.sessionGeneration;

    await this.pushListenerReady;

    if (

      generation !== this.sessionGeneration ||

      !this.getToken()

    ) {

      return;

    }

    const cachedToken = this.getCachedFcmToken();

    if (cachedToken) {

      this.sendTokenForCurrentSession(cachedToken);

    }

    try {

      let permission =

        await PushNotifications.checkPermissions();

      if (

        permission.receive === 'prompt' ||

        permission.receive === 'prompt-with-rationale'

      ) {

        permission =

          await PushNotifications.requestPermissions();

      }

      if (permission.receive !== 'granted') {

        console.warn(

          '[Push] Notification permission not granted.',

        );

        return;

      }

      if (

        generation === this.sessionGeneration &&

        this.getToken()

      ) {

        await PushNotifications.register();

      }

    } catch {

      console.warn(

        '[Push] Could not refresh FCM registration.',

      );

    }

  }

  private enqueuePushOperation(

    operation: () => Promise<void>,

  ): void {

    // Continue processing even if a previous operation failed.

    this.pushOperationQueue =

      this.pushOperationQueue

        .catch(() => undefined)

        .then(operation)

        .catch(() => {

          console.warn(

            '[Push] A queued push operation failed.',

          );

        });

  }

  private queueUnregistration(

    jwt: string,

    fcmToken: string,

  ): void {

    this.enqueuePushOperation(async () => {

      try {

        await firstValueFrom(

          this.http.post(

            `${this.apiUrl}/push/unregister`,

            {

              fcm_token: fcmToken,

              platform: 'android',

            },

            {

              headers: this.authHeaders(jwt),

            },

          ).pipe(

            timeout(12000),

          ),

        );

        console.info(

          '[Push] Previous device association removed.',

        );

      } catch (error) {

        const status =

          error instanceof HttpErrorResponse

            ? error.status

            : null;

        console.warn(

          '[Push] Device unregistration failed.',

          status,

        );

        // A client cannot guarantee removal if offline

        // or if its previous JWT has been revoked.

        // Backend reconciliation is still required.

      }

    });

  }

  private sendTokenForCurrentSession(

    fcmToken: string,

  ): void {

    if (

      !this.isNativeAndroid() ||

      !fcmToken

    ) {

      return;

    }

    const jwt = this.getToken();

    const user = this.getCurrentUser();

    if (!jwt || !user) return;

    const generation = this.sessionGeneration;

    const identity = `${user.id}:${fcmToken}`;

    if (this.lastRegisteredFor === identity) {

      return;

    }

    // Prevent duplicated registration operations.

    this.lastRegisteredFor = identity;

    this.enqueuePushOperation(async () => {

      // Ignore registrations for an account that

      // has logged out or switched sessions.

      if (

        generation !== this.sessionGeneration ||

        this.getToken() !== jwt ||

        this.getCurrentUser()?.id !== user.id

      ) {

        if (this.lastRegisteredFor === identity) {

          this.lastRegisteredFor = null;

        }

        return;

      }

      try {

        await firstValueFrom(

          this.http.post(

            `${this.apiUrl}/push/register`,

            {

              fcm_token: fcmToken,

              platform: 'android',

            },

            {

              headers: this.authHeaders(jwt),

            },

          ).pipe(

            timeout(12000),

          ),

        );

        if (

          generation === this.sessionGeneration &&

          this.getToken() === jwt &&

          this.getCurrentUser()?.id === user.id

        ) {

          console.info(

            '[Push] Device registered to current account.',

          );

        } else {

          // The account changed while the request

          // was in progress. Logout cleanup will run

          // after this operation in the queue.

          if (this.lastRegisteredFor === identity) {

            this.lastRegisteredFor = null;

          }

        }

      } catch (error) {

        if (this.lastRegisteredFor === identity) {

          this.lastRegisteredFor = null;

        }

        const status =

          error instanceof HttpErrorResponse

            ? error.status

            : null;

        console.warn(

          '[Push] Device registration failed.',

          status,

        );

      }

    });

  }

}