import { CommonModule } from '@angular/common';

import {
  ChangeDetectorRef,
  Component,
  OnDestroy,
} from '@angular/core';

import { FormsModule } from '@angular/forms';

import {
  HttpClient,
  HttpErrorResponse,
} from '@angular/common/http';

import { Router, RouterLink } from '@angular/router';

import {
  firstValueFrom,
  Subject,
  takeUntil,
  timeout,
} from 'rxjs';

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
} from 'ionicons/icons';

import { environment } from '../../../environments/environment';

type ResetStep =
  | 'email'
  | 'otp'
  | 'password'
  | 'complete';

interface VerifyResponse {
  message: string;
  reset_token: string;
  expires_in: number;
}

@Component({
  selector: 'app-forgot-password',
  templateUrl: './forgot-password.page.html',
  styleUrls: ['./forgot-password.page.scss'],
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    RouterLink,
    IonButton,
    IonContent,
    IonIcon,
    IonInput,
    IonSpinner,
  ],
})
export class ForgotPasswordPage implements OnDestroy {

  step: ResetStep = 'email';

  email = '';
  otp = '';

  newPassword = '';
  confirmPassword = '';

  showNewPassword = false;
  showConfirmPassword = false;

  loading = false;

  errorMessage = '';
  successMessage = '';

  // ==========================================
  // RESEND CODE COUNTDOWN
  // ==========================================

  resendCountdown = 0;

  private readonly resendCooldownSeconds = 60;

  private resendTimer:
    ReturnType<typeof setInterval> | null = null;

  private resendAvailableAt = 0;

  // ==========================================
  // PRIVATE STATE
  // ==========================================

  private resetToken = '';

  private destroyed = false;
  private pageGeneration = 0;

  private cancelRequests$ = new Subject<void>();

  private readonly baseUrl =
    `${environment.apiBaseUrl.replace(/\/$/, '')}/api/password-reset`;

  constructor(
    private readonly http: HttpClient,
    private readonly router: Router,
    private readonly cdr: ChangeDetectorRef,
    private readonly alertController: AlertController,
  ) {
    addIcons({
      eyeOutline,
      eyeOffOutline,
    });
  }

  // ==========================================
  // PAGE LIFECYCLE
  // ==========================================

  ionViewWillEnter(): void {
    this.invalidatePendingRequests();
    this.resetFormState();
    this.updateView();
  }

  ionViewDidLeave(): void {
    this.invalidatePendingRequests();
    this.stopResendTimer();
    this.resetFormState();
  }

  ngOnDestroy(): void {
    this.destroyed = true;

    this.invalidatePendingRequests();
    this.stopResendTimer();
    this.resetFormState();
  }

  private invalidatePendingRequests(): void {
    this.pageGeneration++;

    this.cancelRequests$.next();
    this.cancelRequests$.complete();

    this.cancelRequests$ = new Subject<void>();
  }

  private resetFormState(): void {
    this.stopResendTimer();

    this.step = 'email';

    this.email = '';
    this.otp = '';

    this.newPassword = '';
    this.confirmPassword = '';

    this.showNewPassword = false;
    this.showConfirmPassword = false;

    this.resetToken = '';

    this.resendCountdown = 0;
    this.resendAvailableAt = 0;

    this.loading = false;

    this.clearMessages();
  }

  private isCurrent(generation: number): boolean {
    return (
      !this.destroyed &&
      generation === this.pageGeneration
    );
  }

  private updateView(): void {
    if (!this.destroyed) {
      this.cdr.detectChanges();
    }
  }

  // ==========================================
  // COUNTDOWN MANAGEMENT
  // ==========================================

  private startResendCountdown(): void {

    this.stopResendTimer();

    this.resendCountdown = this.resendCooldownSeconds;

    this.resendAvailableAt =
      Date.now() + this.resendCooldownSeconds * 1000;

    this.resendTimer = setInterval(() => {

      if (this.destroyed || this.step !== 'otp') {
        this.stopResendTimer();
        return;
      }

      const remainingMilliseconds =
        this.resendAvailableAt - Date.now();

      this.resendCountdown = Math.max(
        0,
        Math.ceil(remainingMilliseconds / 1000),
      );

      if (this.resendCountdown === 0) {
        this.stopResendTimer();
      }

      this.updateView();

    }, 1000);

    this.updateView();
  }

  private stopResendTimer(): void {

    if (this.resendTimer !== null) {
      clearInterval(this.resendTimer);
      this.resendTimer = null;
    }
  }

  get resendCountdownLabel(): string {

    if (this.resendCountdown <= 0) {
      return 'Resend Code';
    }

    const minutes = Math.floor(
      this.resendCountdown / 60,
    );

    const seconds = this.resendCountdown % 60;

    const formattedMinutes =
      String(minutes).padStart(2, '0');

    const formattedSeconds =
      String(seconds).padStart(2, '0');

    return (
      'Resend Code in ' +
      formattedMinutes +
      ':' +
      formattedSeconds
    );
  }

  // ==========================================
  // PASSWORD VISIBILITY
  // ==========================================

  toggleNewPasswordVisibility(): void {
    this.showNewPassword = !this.showNewPassword;
  }

  toggleConfirmPasswordVisibility(): void {
    this.showConfirmPassword = !this.showConfirmPassword;
  }

  // ==========================================
  // REQUEST OTP
  // ==========================================

  async requestOtp(): Promise<void> {

    if (this.loading) return;

    this.clearMessages();

    const email = this.email.trim().toLowerCase();

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {

      this.errorMessage =
        'Enter a valid email address.';

      this.updateView();
      return;
    }

    const generation = this.pageGeneration;
    const cancel$ = this.cancelRequests$;

    this.loading = true;
    this.updateView();

    try {

      await firstValueFrom(
        this.http.post(
          `${this.baseUrl}/request`,
          { email },
        ).pipe(
          timeout(30000),
          takeUntil(cancel$),
        ),
      );

      if (!this.isCurrent(generation)) return;

      this.email = email;
      this.otp = '';
      this.resetToken = '';

      this.step = 'otp';

      // Start countdown after successful response.
      this.startResendCountdown();

      this.successMessage =
        'If this email is registered, a verification code ' +
        'will be sent. Check your inbox or spam folder.';

    } catch (error) {

      if (!this.isCurrent(generation)) return;

      this.errorMessage = this.getErrorMessage(error);

    } finally {

      if (this.isCurrent(generation)) {
        this.loading = false;
        this.updateView();
      }
    }
  }

  // ==========================================
  // VERIFY OTP
  // ==========================================

  async verifyOtp(): Promise<void> {

    if (this.loading) return;

    this.clearMessages();

    const code = this.otp.trim();

    if (!/^\d{6}$/.test(code)) {

      this.errorMessage =
        'Enter the six-digit verification code.';

      this.updateView();
      return;
    }

    const generation = this.pageGeneration;
    const cancel$ = this.cancelRequests$;

    this.loading = true;
    this.updateView();

    try {

      const response = await firstValueFrom(
        this.http.post<VerifyResponse>(
          `${this.baseUrl}/verify`,
          {
            email: this.email,
            otp: code,
          },
        ).pipe(
          timeout(30000),
          takeUntil(cancel$),
        ),
      );

      if (!this.isCurrent(generation)) return;

      if (!response.reset_token) {
        throw new Error('Missing reset authorization.');
      }

      this.resetToken = response.reset_token;
      this.otp = '';

      this.showNewPassword = false;
      this.showConfirmPassword = false;

      // Countdown no longer needed.
      this.stopResendTimer();

      this.resendCountdown = 0;
      this.resendAvailableAt = 0;

      this.step = 'password';

      this.successMessage =
        'Email verified. You can now set a new password.';

    } catch (error) {

      if (!this.isCurrent(generation)) return;

      this.errorMessage = this.getErrorMessage(error);

    } finally {

      if (this.isCurrent(generation)) {
        this.loading = false;
        this.updateView();
      }
    }
  }

  // ==========================================
  // RESET PASSWORD
  // ==========================================

  async confirmReset(): Promise<void> {

    if (this.loading) return;

    this.clearMessages();

    if (
      this.newPassword.length < 8 ||
      this.newPassword.length > 128 ||
      !this.newPassword.trim()
    ) {

      this.errorMessage =
        'Your password must contain 8 to 128 characters.';

      this.updateView();
      return;
    }

    if (this.newPassword !== this.confirmPassword) {

      this.errorMessage =
        'Passwords do not match.';

      this.updateView();
      return;
    }

    if (!this.resetToken) {

      this.restart();

      this.errorMessage =
        'Your verification session has expired. ' +
        'Please request another code.';

      this.updateView();
      return;
    }

    const generation = this.pageGeneration;
    const cancel$ = this.cancelRequests$;

    this.loading = true;
    this.updateView();

    try {

      await firstValueFrom(
        this.http.post(
          `${this.baseUrl}/confirm`,
          {
            reset_token: this.resetToken,
            new_password: this.newPassword,
          },
        ).pipe(
          timeout(30000),
          takeUntil(cancel$),
        ),
      );

      if (!this.isCurrent(generation)) return;

      this.resetToken = '';
      this.otp = '';

      this.newPassword = '';
      this.confirmPassword = '';

      this.showNewPassword = false;
      this.showConfirmPassword = false;

      this.stopResendTimer();

      this.resendCountdown = 0;

      this.step = 'complete';

      this.successMessage =
        'Password updated successfully. ' +
        'You can now log in.';

    } catch (error) {

      if (!this.isCurrent(generation)) return;

      this.errorMessage = this.getErrorMessage(error);

    } finally {

      if (this.isCurrent(generation)) {
        this.loading = false;
        this.updateView();
      }
    }
  }

  // ==========================================
  // RESEND OTP
  // ==========================================

  async resendOtp(): Promise<void> {

    // Prevent requests while another request is running,
    // during cooldown, or outside the OTP step.

    if (
      this.loading ||
      this.step !== 'otp' ||
      this.resendCountdown > 0
    ) {
      return;
    }

    this.clearMessages();

    const email = this.email.trim().toLowerCase();

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {

      this.errorMessage =
        'Invalid email address. Please start again.';

      this.updateView();
      return;
    }

    const generation = this.pageGeneration;
    const cancel$ = this.cancelRequests$;

    this.loading = true;
    this.updateView();

    try {

      await firstValueFrom(
        this.http.post(
          `${this.baseUrl}/request`,
          { email },
        ).pipe(
          timeout(30000),
          takeUntil(cancel$),
        ),
      );

      if (!this.isCurrent(generation)) return;

      // Remain on the OTP verification screen.
      this.step = 'otp';

      // Keep the previous code: a resend request may not create a new code
      // if the backend's cooldown is still in effect.

      // Start a new local 60-second countdown.
      this.startResendCountdown();

      this.successMessage =
        'Request received. If allowed, a code will be sent. ' +
        'You can still try your previous code. Check spam too.';

    } catch (error) {

      if (!this.isCurrent(generation)) return;

      this.errorMessage = this.getErrorMessage(error);

    } finally {

      if (this.isCurrent(generation)) {
        this.loading = false;
        this.updateView();
      }
    }
  }

  // ==========================================
  // CONTEXT-SENSITIVE BACK NAVIGATION
  // ==========================================

  async handleBack(): Promise<void> {
    if (this.loading) return;

    if (this.step === 'email' || this.step === 'complete') {
      this.goToLogin();
      return;
    }

    if (this.step === 'otp') {
      // Return to email entry, keeping the current email for easy correction.
      // A new request may still be subject to the server's resend cooldown.
      this.invalidatePendingRequests();
      this.stopResendTimer();
      this.step = 'email';
      this.otp = '';
      this.resetToken = '';
      this.resendCountdown = 0;
      this.resendAvailableAt = 0;
      this.clearMessages();
      this.updateView();
      return;
    }

    // Verification is single-use: returning to the OTP step would imply
    // that the previously verified code can be submitted again.
    // Ask before abandoning the reset authorization.
    const alert = await this.alertController.create({
      header: 'Leave password reset?',
      message: 'Your email is verified. Leaving now means you will need a new code to reset your password.',
      buttons: [
        { text: 'Keep resetting', role: 'cancel' },
        { text: 'Go to Login', role: 'confirm' },
      ],
    });

    await alert.present();
    const result = await alert.onDidDismiss();
    if (result.role === 'confirm' && !this.loading && this.step === 'password') {
      this.goToLogin();
    }
  }

  // ==========================================
  // RESTART
  // ==========================================

  restart(): void {

    if (this.loading) return;

    this.invalidatePendingRequests();
    this.resetFormState();
    this.updateView();
  }

  // ==========================================
  // NAVIGATION
  // ==========================================

  goToLogin(): void {
    void this.router.navigate(['/login']);
  }

  // ==========================================
  // STATUS MESSAGES
  // ==========================================

  private clearMessages(): void {
    this.errorMessage = '';
    this.successMessage = '';
  }

  private getErrorMessage(error: unknown): string {

    if (error instanceof HttpErrorResponse) {

      if (error.status === 0) {
        return (
          'Unable to connect to the server. ' +
          'Check your connection and backend CORS settings.'
        );
      }

      if (error.status === 429) {
        return (
          'Too many attempts. Please try again later.'
        );
      }

      if (
        error.status === 400 &&
        typeof error.error?.detail === 'string'
      ) {
        return error.error.detail;
      }

      if (error.status === 422) {
        return 'Please check the information you entered.';
      }
    }

    if (
      error instanceof Error &&
      error.name === 'TimeoutError'
    ) {
      return (
        'The request took too long. ' +
        'Check your email before requesting another code.'
      );
    }

    return 'Something went wrong. Please try again.';
  }
}