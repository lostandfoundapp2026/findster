
import {
  ChangeDetectorRef,
  Component,
} from '@angular/core';

import { FormsModule } from '@angular/forms';

import {
  HttpErrorResponse,
} from '@angular/common/http';

import {
  ActivatedRoute,
  Router,
  RouterLink,
} from '@angular/router';

import {
  AlertController,
  IonButton,
  IonContent,
  IonIcon,
  IonInput,
  IonSpinner,
} from '@ionic/angular';

import { addIcons } from 'ionicons';

import {
  eyeOutline,
  eyeOffOutline,
  locationOutline,
  mailOutline,
  lockClosedOutline,
  arrowForwardOutline,
  heartOutline,
} from 'ionicons/icons';

import {
  defer,
  finalize,
  take,
  timeout,
  TimeoutError,
} from 'rxjs';

import { AuthService } from '../../services/auth';

// ==========================================
// REGISTER LOGIN ICONS
// ==========================================

addIcons({
  eyeOutline,
  eyeOffOutline,
  locationOutline,
  mailOutline,
  lockClosedOutline,
  arrowForwardOutline,
  heartOutline,
});

type LoginRedirectReason =
  | 'session-expired'
  | 'connection-error'
  | 'server-error'
  | 'validation-error';

@Component({
  selector: 'app-login',
  templateUrl: './login.page.html',
  styleUrls: ['./login.page.scss'],
  standalone: true,
  imports: [
    FormsModule,
    RouterLink,
    IonButton,
    IonContent,
    IonIcon,
    IonInput,
    IonSpinner,
  ],
})
export class LoginPage {
  email = '';
  password = '';

  isLoading = false;
  showPassword = false;

  private readonly loginTimeoutMs = 25000;

  constructor(
    private readonly authService: AuthService,
    private readonly router: Router,
    private readonly route: ActivatedRoute,
    private readonly alertController: AlertController,
    private readonly cdr: ChangeDetectorRef,
  ) {}

  // ==========================================
  // PAGE LIFECYCLE
  // ==========================================

  ionViewWillEnter(): void {
    this.isLoading = false;
    this.refreshView();

    void this.handleRedirectReason();
  }

  // ==========================================
  // CHANGE DETECTION
  // ==========================================

  private refreshView(): void {
    this.cdr.detectChanges();
  }

  private setLoading(value: boolean): void {
    this.isLoading = value;
    this.refreshView();
  }

  // ==========================================
  // REDIRECT MESSAGES
  // ==========================================

  private async handleRedirectReason(): Promise<void> {
    const reason = this.route.snapshot.queryParamMap.get(
      'reason',
    );

    if (!reason) {
      return;
    }

    let header = 'Session Notice';
    let message = '';

    switch (reason as LoginRedirectReason) {
      case 'session-expired':
        header = 'Session Expired';
        message =
          'Your login session has expired or is no longer valid. ' +
          'Please sign in again to continue.';
        break;

      case 'connection-error':
        header = 'Connection Unavailable';
        message =
          'Unable to verify your session because the server ' +
          'could not be reached. Your saved session was preserved. ' +
          'Check your internet connection and try again.';
        break;

      case 'server-error':
        header = 'Server Unavailable';
        message =
          'The server is temporarily unavailable. ' +
          'Your saved session was preserved. ' +
          'Please try again when the service is available.';
        break;

      case 'validation-error':
        header = 'Session Verification Failed';
        message =
          'Your session could not be verified. ' +
          'Please try again or sign in to continue.';
        break;

      default:
        return;
    }

    await this.router.navigate([], {
      relativeTo: this.route,
      queryParams: {
        reason: null,
      },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });

    await this.showAlert(header, message);
  }

  // ==========================================
  // PASSWORD VISIBILITY
  // ==========================================

  togglePasswordVisibility(): void {
    if (this.isLoading) {
      return;
    }

    this.showPassword = !this.showPassword;
    this.refreshView();
  }

  // ==========================================
  // LOGIN
  // ==========================================

  login(): void {
    if (this.isLoading) {
      return;
    }

    const email = this.email.trim();
    const password = this.password;

    // Required fields validation.
    if (!email || !password) {
      void this.showAlert(
        'Missing Information',
        'Please enter your email and password.',
      );
      return;
    }

    // Email format validation.
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      void this.showAlert(
        'Invalid Email',
        'Please enter a valid email address.',
      );
      return;
    }

    // Activate loading state.
    this.setLoading(true);

    defer(() =>
      this.authService.login(email, password),
    )
      .pipe(
        timeout({
          first: this.loginTimeoutMs,
        }),
        take(1),
        finalize(() => {
          // Backup cleanup for completion,
          // HTTP errors, and request timeouts.
          this.setLoading(false);

          console.info(
            '[Login] Request finalized. Loading:',
            this.isLoading,
          );
        }),
      )
      .subscribe({
        next: () => {
          // Explicitly release the form.
          this.setLoading(false);

          console.info(
            '[Login] Authentication successful.',
          );

          // Clear the password after login.
          this.password = '';
          this.showPassword = false;
          this.refreshView();

          void this.router.navigateByUrl('/home', {
            replaceUrl: true,
          }).then((navigated) => {
            if (!navigated) {
              void this.showAlert(
                'Navigation Error',
                'Login succeeded, but the Home page could not be opened. Please try again.',
              );
            }
          }).catch((error) => {
            console.error(
              '[Login] Navigation failed.',
              error,
            );

            void this.showAlert(
              'Navigation Error',
              'Unable to open the Home page. Please try again.',
            );
          });
        },

        error: (error: unknown) => {
          // Immediately unlock the input fields
          // before displaying the error alert.
          this.setLoading(false);

          const message =
            this.getLoginErrorMessage(error);

          console.info(
            '[Login] Error received:',
            error instanceof HttpErrorResponse
              ? error.status
              : error instanceof TimeoutError
                ? 'timeout'
                : 'unknown',
          );

          console.info(
            '[Login] Form unlocked:',
            !this.isLoading,
          );

          void this.showAlert(
            'Login Failed',
            message,
          ).catch((alertError) => {
            console.error(
              '[Login] Unable to display alert.',
              alertError,
            );
          });
        },
      });
  }

  // ==========================================
  // ERROR HANDLING
  // ==========================================

  private getLoginErrorMessage(
    error: unknown,
  ): string {
    if (error instanceof TimeoutError) {
      return (
        'The login request took too long. ' +
        'Check your internet connection and try again.'
      );
    }

    if (error instanceof HttpErrorResponse) {
      switch (error.status) {
        case 0:
          return (
            'Cannot connect to the server. ' +
            'Check your internet connection and make sure the backend is running.'
          );

        case 400:
        case 401:
          return 'Incorrect email or password.';

        case 422:
          return (
            'Please check your email and password format.'
          );

        case 429:
          return (
            'Too many login attempts. ' +
            'Please try again later.'
          );
      }

      if (error.status >= 500) {
        return (
          'The server is temporarily unavailable. ' +
          'Please try again later.'
        );
      }

      if (
        typeof error.error?.detail === 'string'
      ) {
        return error.error.detail;
      }
    }

    return 'Unable to sign in. Please try again.';
  }

  // ==========================================
  // ALERT HELPER
  // ==========================================

  private async showAlert(
    header: string,
    message: string,
  ): Promise<void> {
    const alert = await this.alertController.create({
      header,
      message,
      buttons: ['OK'],
    });

    await alert.present();
  }
}
