// Save as: src/app/pages/profile/profile.page.ts
// FINDSTER — Profile page. Existing auth/profile methods preserved.

import { ChangeDetectorRef, Component, OnDestroy } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';

import {
  AlertController,
  IonButton,
  IonContent,
  IonHeader,
  IonIcon,
  IonInput,
  IonSelect,
  IonSelectOption,
  IonToolbar,
} from '@ionic/angular';

import { addIcons } from 'ionicons';
import {
  checkmarkOutline,
  closeOutline,
  createOutline,
  locationOutline,
  logOutOutline,
  personOutline,
  shieldCheckmarkOutline,
} from 'ionicons/icons';

import { Subscription, timeout } from 'rxjs';

import { AuthService, type AuthUser } from '../../services/auth';
import { NotificationsService } from '../../services/notifications';

@Component({
  selector: 'app-profile',
  templateUrl: './profile.page.html',
  styleUrls: ['./profile.page.scss'],
  standalone: true,
  imports: [
    FormsModule,
    IonButton,
    IonContent,
    IonHeader,
    IonIcon,
    IonInput,
    IonSelect,
    IonSelectOption,
    IonToolbar,
  ],
})
export class ProfilePage implements OnDestroy {
  user: AuthUser | null = null;

  isLoggingOut = false;
  isEditing = false;
  isSaving = false;

  firstName = '';
  middleName = '';
  lastName = '';
  contactNumber = '';
  barangay = '';

  readonly barangays = [
    'San Bartolome',
    'Burgos',
    'Rizal',
    'Bonifacio',
    'Mallorca',
    'Mambangnan',
    'Diversion',
    'Tambo-Adorable',
    'Nieves',
    'Tabuating',
    'Magpapalayoc',
    'San Anton',
    'Castellano',
    'Tagumpay',
    'San Roque',
  ];

  private profileRequest?: Subscription;
  private saveRequest?: Subscription;

  private profileLoadGeneration = 0;
  private saveGeneration = 0;
  private destroyed = false;
  private pageActive = false;

  constructor(
    private readonly authService: AuthService,
    private readonly notificationsService: NotificationsService,
    private readonly router: Router,
    private readonly alertController: AlertController,
    private readonly cdr: ChangeDetectorRef,
  ) {
    // Register all icons used in profile.page.html.
    addIcons({
      checkmarkOutline,
      closeOutline,
      createOutline,
      locationOutline,
      logOutOutline,
      personOutline,
      shieldCheckmarkOutline,
    });
  }

  // ==========================================
  // PAGE LIFECYCLE
  // ==========================================

  ionViewWillEnter(): void {
    this.pageActive = true;
    this.user = this.authService.getCurrentUser();
    this.refreshProfile();
  }

  ionViewDidLeave(): void {
    this.pageActive = false;
    this.stopProfileRequest();
    this.stopSaveRequest();

    this.isEditing = false;
    this.isSaving = false;
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.pageActive = false;
    this.stopProfileRequest();
    this.stopSaveRequest();
  }

  // ==========================================
  // LOAD PROFILE
  // ==========================================

  private refreshProfile(): void {
    this.stopProfileRequest();

    const generation = this.profileLoadGeneration;
    const sessionToken = this.authService.getToken();

    if (!sessionToken || this.destroyed || !this.pageActive) return;

    this.profileRequest = this.authService
      .validateSession()
      .pipe(timeout(12000))
      .subscribe({
        next: (profile) => {
          if (
            this.destroyed ||
            !this.pageActive ||
            generation !== this.profileLoadGeneration ||
            this.authService.getToken() !== sessionToken ||
            this.isSaving ||
            this.isEditing
          ) {
            return;
          }

          this.user =
            this.authService.getCurrentUser() ?? profile;

          // Do not overwrite unsaved form edits.
          this.cdr.detectChanges();
        },

        error: (error: unknown) => {
          if (this.destroyed || !this.pageActive || generation !== this.profileLoadGeneration) {
            return;
          }

          const status = (
            error as { status?: number } | null
          )?.status;

          console.warn(
            '[Profile] Unable to refresh account details.',
            status ?? 'network',
          );
        },
      });
  }

  // ==========================================
  // START EDITING
  // ==========================================

  startEdit(): void {
    if (
      this.destroyed ||
      !this.pageActive ||
      !this.user ||
      this.isLoggingOut ||
      this.isSaving
    ) {
      return;
    }

    // Do not guess first/last names from old full_name.
    this.firstName =
      this.user.first_name?.trim() ?? '';

    this.middleName =
      this.user.middle_name?.trim() ?? '';

    this.lastName =
      this.user.last_name?.trim() ?? '';

    this.contactNumber =
      this.user.contact_number?.trim() ?? '';

    this.barangay =
      this.user.barangay?.trim() ?? '';

    this.isEditing = true;
    this.cdr.detectChanges();
  }

  // ==========================================
  // CANCEL EDITING
  // ==========================================

  cancelEdit(): void {
    if (this.isSaving) return;

    this.isEditing = false;
    this.cdr.detectChanges();
  }

  // ==========================================
  // SAVE PROFILE
  // ==========================================

  async saveProfile(): Promise<void> {
    if (
      this.destroyed ||
      !this.pageActive ||
      !this.isEditing ||
      this.isSaving ||
      this.isLoggingOut ||
      !this.user
    ) {
      return;
    }

    const first_name =
      this.normalizeName(this.firstName);

    const middle_name =
      this.normalizeName(this.middleName) || null;

    const last_name =
      this.normalizeName(this.lastName);

    const contact_number =
      this.contactNumber.trim();

    const barangay =
      this.barangay.trim();

    // Validate required name fields.
    if (
      first_name.length < 2 ||
      last_name.length < 2
    ) {
      await this.showAlert(
        'Invalid Name',
        'First Name and Last Name must have at least 2 characters each.',
      );
      return;
    }

    // Validate name lengths.
    if (
      first_name.length > 100 ||
      last_name.length > 100 ||
      (middle_name?.length ?? 0) > 100 ||
      [first_name, middle_name, last_name]
        .filter(Boolean)
        .join(' ').length > 100
    ) {
      await this.showAlert(
        'Name Too Long',
        'Your complete name must not exceed 100 characters.',
      );
      return;
    }

    // Validate Philippine mobile number.
    if (!/^09\d{9}$/.test(contact_number)) {
      await this.showAlert(
        'Invalid Contact Number',
        'Enter an 11-digit Philippine mobile number starting with 09.',
      );
      return;
    }

    // Validate barangay.
    if (!this.barangays.includes(barangay)) {
      await this.showAlert(
        'Invalid Barangay',
        'Please select a valid barangay in San Leonardo.',
      );
      return;
    }

    // Prevent an older profile request from
    // overwriting successfully saved information.
    this.stopProfileRequest();

    this.isSaving = true;

    const generation = ++this.saveGeneration;
    const token = this.authService.getToken();
    const userId = this.user.id;

    this.cdr.detectChanges();

    this.saveRequest = this.authService
      .updateProfile({
        first_name,
        middle_name,
        last_name,
        contact_number,
        barangay,
      })
      .pipe(timeout(15000))
      .subscribe({
        next: (updatedUser) => {
          if (
            this.destroyed ||
            !this.pageActive ||
            generation !== this.saveGeneration ||
            this.authService.getToken() !== token ||
            updatedUser.id !== userId
          ) {
            return;
          }

          this.user = updatedUser;
          this.isSaving = false;
          this.isEditing = false;

          this.cdr.detectChanges();

          void this.showAlert(
            'Profile Updated',
            'Your profile information has been saved successfully.',
          );
        },

        error: (error: unknown) => {
          if (this.destroyed || !this.pageActive || generation !== this.saveGeneration) {
            return;
          }

          this.isSaving = false;
          this.cdr.detectChanges();

          let message =
            'Unable to update your profile. Please try again.';

          if (error instanceof HttpErrorResponse) {
            if (error.status === 401) {
              message =
                'Your session has expired. Please sign in again.';
            } else if (error.status === 0) {
              message =
                'Cannot connect to the server. Check your internet connection.';
            } else if (
              error.status === 400 ||
              error.status === 422
            ) {
              const detail: unknown =
                error.error?.detail;

              message =
                typeof detail === 'string'
                  ? detail
                  : 'Some profile information is invalid. Please review the fields.';
            }
          }

          void this.showAlert(
            'Update Failed',
            message,
          );
        },
      });
  }

  // ==========================================
  // NAME NORMALIZATION
  // ==========================================

  private normalizeName(value: string): string {
    return value.trim().replace(/\s+/g, ' ');
  }

  // ==========================================
  // ALERT HELPER
  // ==========================================

  private async showAlert(
    header: string,
    message: string,
  ): Promise<void> {
    const alert =
      await this.alertController.create({
        header,
        message,
        buttons: ['OK'],
      });

    if (!this.destroyed && this.pageActive) {
      await alert.present();
    }
  }

  // ==========================================
  // STOP PROFILE REQUEST
  // ==========================================

  private stopProfileRequest(): void {
    this.profileLoadGeneration++;

    this.profileRequest?.unsubscribe();
    this.profileRequest = undefined;
  }

  // ==========================================
  // STOP SAVE REQUEST
  // ==========================================

  private stopSaveRequest(): void {
    this.saveGeneration++;

    this.saveRequest?.unsubscribe();
    this.saveRequest = undefined;
  }

  // ==========================================
  // PROFILE DISPLAY HELPERS
  // ==========================================

  get displayName(): string {
    return (
      this.user?.full_name?.trim() ||
      'Findster User'
    );
  }

  get displayFirstName(): string {
    return (
      this.user?.first_name?.trim() ||
      'Not set'
    );
  }

  get displayMiddleName(): string {
    return (
      this.user?.middle_name?.trim() ||
      'Not provided'
    );
  }

  get displayLastName(): string {
    return (
      this.user?.last_name?.trim() ||
      'Not set'
    );
  }

  get displayEmail(): string {
    return (
      this.user?.email?.trim() ||
      'Not available'
    );
  }

  get displayContactNumber(): string {
    return (
      this.user?.contact_number?.trim() ||
      'Not available'
    );
  }

  get displayBarangay(): string {
    return (
      this.user?.barangay?.trim() ||
      'Not available'
    );
  }

  get initials(): string {
    const names = (
      this.user?.full_name?.trim() || ''
    )
      .split(/\s+/)
      .filter(Boolean);

    return names.length > 0
      ? names
          .slice(0, 2)
          .map((name) => name[0].toUpperCase())
          .join('')
      : 'F';
  }

  // ==========================================
  // LOGOUT CONFIRMATION
  // ==========================================

  async confirmLogout(): Promise<void> {
    if (
      this.destroyed ||
      !this.pageActive ||
      this.isLoggingOut ||
      this.isSaving
    ) {
      return;
    }

    const alert =
      await this.alertController.create({
        header: 'Log Out?',
        message:
          'Are you sure you want to sign out of your Findster account?',
        buttons: [
          {
            text: 'Cancel',
            role: 'cancel',
          },
          {
            text: 'Log Out',
            role: 'destructive',
            handler: () => {
              void this.logout();
            },
          },
        ],
      });

    await alert.present();
  }

  // ==========================================
  // LOGOUT
  // ==========================================

  private async logout(): Promise<void> {
    if (
      this.destroyed ||
      !this.pageActive ||
      this.isLoggingOut ||
      this.isSaving
    ) {
      return;
    }

    this.isLoggingOut = true;

    this.stopProfileRequest();
    this.stopSaveRequest();

    try {
      this.authService.logout();

      this.notificationsService.setUnreadCount(0);

      this.user = null;
      this.isEditing = false;

      this.cdr.detectChanges();

      await this.router.navigateByUrl(
        '/login',
        { replaceUrl: true },
      );
    } finally {
      this.isLoggingOut = false;
      if (!this.destroyed) {
        this.cdr.detectChanges();
      }
    }
  }
}