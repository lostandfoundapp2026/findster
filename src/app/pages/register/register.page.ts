import { ChangeDetectorRef, Component } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { firstValueFrom, timeout } from 'rxjs';

import {
  AlertController,
  IonButton,
  IonContent,
  IonIcon,
  IonInput,
  IonSelect,
  IonSelectOption,
} from '@ionic/angular';

import { addIcons } from 'ionicons';
import {
  arrowBackOutline,
  eyeOutline,
  eyeOffOutline,
} from 'ionicons/icons';

import { AuthService } from '../../services/auth';

addIcons({
  arrowBackOutline,
  eyeOutline,
  eyeOffOutline,
});

@Component({
  selector: 'app-register',
  templateUrl: './register.page.html',
  styleUrls: ['./register.page.scss'],
  standalone: true,
  imports: [
    FormsModule,
    RouterLink,
    IonButton,
    IonContent,
    IonIcon,
    IonInput,
    IonSelect,
    IonSelectOption,
  ],
})
export class RegisterPage {
  registrationStep: 1 | 2 = 1;

  firstName = '';
  middleName = '';
  lastName = '';
  email = '';
  contactNumber = '';
  barangay = '';
  password = '';
  confirmPassword = '';

  isRegistering = false;
  showPassword = false;
  showConfirmPassword = false;

  constructor(
    private readonly alertController: AlertController,
    private readonly router: Router,
    private readonly authService: AuthService,
    private readonly cdr: ChangeDetectorRef,
  ) {}

  handleRegistrationBack(): void {
    if (this.isRegistering) return;

    if (this.registrationStep === 2) {
      this.registrationStep = 1;
      this.cdr.detectChanges();
      return;
    }

    void this.router.navigateByUrl('/login');
  }

  // Keep compatibility with any existing calls to goBack().
  goBack(): void {
    this.handleRegistrationBack();
  }

  async nextRegistrationStep(): Promise<void> {
    if (this.isRegistering || this.registrationStep !== 1) return;
    const valid = await this.validatePersonalInformation();
    if (!valid) return;

    this.registrationStep = 2;
    this.cdr.detectChanges();
  }

  private async validatePersonalInformation(): Promise<boolean> {
    const firstName = this.normalizeName(this.firstName);
    const middleName = this.normalizeName(this.middleName);
    const lastName = this.normalizeName(this.lastName);
    const email = this.email.trim().toLowerCase();
    const contactNumber = this.contactNumber.trim();
    const barangay = this.barangay.trim();

    if (!firstName || !lastName || !email || !contactNumber || !barangay) {
      await this.showAlert('Incomplete Information',
        'Please complete all required personal information. Middle name is optional.');
      return false;
    }

    if ([firstName, middleName, lastName].some(name => name.length > 100)) {
      await this.showAlert('Name Too Long',
        'Each name field must be 100 characters or fewer.');
      return false;
    }

    const fullName = [firstName, middleName, lastName].filter(Boolean).join(' ');
    if (fullName.length > 100) {
      await this.showAlert('Full Name Too Long',
        'Your combined full name must be 100 characters or fewer.');
      return false;
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      await this.showAlert('Invalid Email', 'Please enter a valid email address.');
      return false;
    }

    if (!/^09\d{9}$/.test(contactNumber)) {
      await this.showAlert('Invalid Contact Number',
        'Please enter an 11-digit Philippine mobile number starting with 09.');
      return false;
    }

    return true;
  }

  togglePasswordVisibility(): void {
    this.showPassword = !this.showPassword;
  }

  toggleConfirmPasswordVisibility(): void {
    this.showConfirmPassword = !this.showConfirmPassword;
  }

  async register(): Promise<void> {
    if (this.isRegistering || this.registrationStep !== 2) return;

    // Revalidate personal information before the final API request.
    // Users may have returned to Step 1 and edited their details.
    if (!(await this.validatePersonalInformation())) {
      this.registrationStep = 1;
      this.cdr.detectChanges();
      return;
    }

    const firstName = this.normalizeName(this.firstName);
    const middleName = this.normalizeName(this.middleName);
    const lastName = this.normalizeName(this.lastName);
    const email = this.email.trim().toLowerCase();
    const contactNumber = this.contactNumber.trim();
    const barangay = this.barangay.trim();

    const fullName = [firstName, middleName, lastName]
      .filter(Boolean)
      .join(' ');

    if (!this.password || !this.confirmPassword) {
      await this.showAlert('Incomplete Information',
        'Please enter and confirm your password.');
      return;
    }

    if (this.password.length > 128) {
      await this.showAlert('Password Too Long',
        'Your password must contain no more than 128 characters.');
      return;
    }

    if (this.password.length < 8) {
      await this.showAlert(
        'Password Too Short',
        'Your password must contain at least 8 characters.',
      );
      return;
    }

    if (this.password !== this.confirmPassword) {
      await this.showAlert(
        'Password Mismatch',
        'Your passwords do not match.',
      );
      return;
    }

    const registrationData = {
      first_name: firstName,
      middle_name: middleName || null,
      last_name: lastName,
      full_name: fullName,
      email,
      contact_number: contactNumber,
      barangay,
      password: this.password,
    };

    // Use one loading indicator: the existing Create Account button.
    // Avoid a second Ionic overlay that can obscure error alerts.
    this.isRegistering = true;
    this.cdr.detectChanges();

    let registered = false;
    let successMessage = '';
    let failureMessage = '';

    try {
      const response = await firstValueFrom(
        this.authService.register(registrationData).pipe(timeout(30000)),
      );

      registered = true;
      successMessage = response?.message ||
        'Your Findster account has been created successfully. You can now sign in.';
    } catch (error: unknown) {
      console.error('Registration failed:', error);
      failureMessage = this.getRegistrationErrorMessage(error);
    } finally {
      // Always restore the button even for server and network failures.
      this.isRegistering = false;
      // Ionic/Capacitor async callbacks may finish outside the view refresh cycle.
      // Force the disabled button and its label to update before showing an alert.
      this.cdr.detectChanges();
    }

    if (registered) {
      const alert = await this.alertController.create({
        header: 'Registration Successful!',
        message: successMessage,
        backdropDismiss: false,
        buttons: [{
          text: 'Go to Login',
          handler: () => {
            void this.router.navigateByUrl('/login', { replaceUrl: true });
          },
        }],
      });
      await alert.present();
    } else {
      await this.showAlert('Registration Failed', failureMessage);
    }
  }

  private normalizeName(value: string): string {
    return value.trim().replace(/\s+/g, ' ');
  }

  private getRegistrationErrorMessage(error: unknown): string {
    if (error instanceof HttpErrorResponse) {
      if (error.status === 409) {
        return 'This email is already registered. Please use another email or sign in.';
      }
      if (error.status === 400 || error.status === 422) {
        const detail: unknown = error.error?.detail;
        if (typeof detail === 'string') return detail;
        if (Array.isArray(detail)) {
          const items = detail
            .map((item: unknown) => {
              if (typeof item !== 'object' || item === null || !('msg' in item)) return '';
              const msg = item.msg;
              return typeof msg === 'string' ? msg : '';
            })
            .filter(Boolean);
          if (items.length) return items.join('\n');
        }
        return 'Some information is invalid. Please check your entries.';
      }
      if (error.status === 0) {
        return 'Cannot connect to the server. Please check your connection and try again.';
      }
      if (error.status === 429) {
        return 'Too many registration attempts. Please try again later.';
      }
      if (error.status >= 500) {
        return 'A server error occurred. Please try again later.';
      }
    }

    if (error instanceof Error && error.name === 'TimeoutError') {
      return 'The request took too long. Please check whether your account was created before trying again.';
    }

    return 'Unable to create your account. Please try again.';
  }

  private async showAlert(header: string, message: string): Promise<void> {
    const alert = await this.alertController.create({
      header,
      message,
      buttons: ['OK'],
    });
    await alert.present();
  }
}