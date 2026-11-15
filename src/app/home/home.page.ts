import { CommonModule } from '@angular/common';
import {
  ChangeDetectorRef,
  Component,
  OnDestroy,
  OnInit,
} from '@angular/core';
import { Router } from '@angular/router';
import { Subscription } from 'rxjs';
import { Geolocation } from '@capacitor/geolocation';

import {
  AlertController,
  IonBadge,
  IonButton,
  IonButtons,
  IonCard,
  IonCardContent,
  IonCardHeader,
  IonCardSubtitle,
  IonCardTitle,
  IonContent,
  IonHeader,
  IonIcon,
  IonItem,
  IonLabel,
  IonList,
  IonSearchbar,
  IonSegment,
  IonSegmentButton,
  IonSelect,
  IonSelectOption,
  IonSpinner,
  IonText,
  IonTitle,
  IonToolbar,
} from '@ionic/angular';

import {
  ReportsService,
  type LostFoundReport,
} from '../services/reports';

import { NotificationsService } from '../services/notifications';
import { HapticsService } from '../services/haptics';
import { AuthService } from '../services/auth';

import { addIcons } from 'ionicons';
import {
  addCircleOutline,
  alertCircleOutline,
  arrowForwardOutline,
  calendarOutline,
  checkmarkCircleOutline,
  handLeftOutline,
  imageOutline,
  locationOutline,
  navigateOutline,
  notificationsOutline,
  pinOutline,
  pricetagOutline,
  refreshOutline,
  searchOutline,
} from 'ionicons/icons';

// Icons used by the current Home HTML.
addIcons({
  addCircleOutline,
  alertCircleOutline,
  arrowForwardOutline,
  calendarOutline,
  checkmarkCircleOutline,
  handLeftOutline,
  imageOutline,
  locationOutline,
  navigateOutline,
  notificationsOutline,
  pinOutline,
  pricetagOutline,
  refreshOutline,
  searchOutline,
});

type ReportSortOption = 'newest' | 'oldest' | 'name_asc' | 'name_desc' | 'nearest';

@Component({
  selector: 'app-home',
  standalone: true,
  templateUrl: 'home.page.html',
  styleUrls: ['home.page.scss'],
  imports: [
    CommonModule,
    IonIcon,
    IonButtons,
    IonHeader,
    IonToolbar,
    IonTitle,
    IonContent,
    IonSearchbar,
    IonSegment,
    IonSegmentButton,
    IonLabel,
    IonList,
    IonCard,
    IonCardHeader,
    IonCardTitle,
    IonCardSubtitle,
    IonCardContent,
    IonSpinner,
    IonText,
    IonBadge,
    IonButton,
    IonSelect,
    IonSelectOption,
    IonItem,
  ],
})
export class HomePage implements OnInit, OnDestroy {
  reports: LostFoundReport[] = [];

  // Notifications
  unreadNotificationCount = 0;
  private unreadCountSubscription?: Subscription;

  // Reports request
  private reportsRequestSubscription?: Subscription;
  private reportsLoadGeneration = 0;

  selectedType: 'all' | 'lost' | 'found' = 'all';
  selectedCategory = 'all';
  selectedBarangay = 'all';
  searchTerm = '';

  // Sorting
  sortBy: ReportSortOption = 'newest';
  private sortBeforeNearMe: ReportSortOption = 'newest';

  // Pagination
  private readonly pageSize = 50;
  // While Near Me is enabled, retrieve all matching API pages before
  // filtering by distance. This avoids overlooking nearby older reports.
  // Consider server-side geospatial pagination for large datasets.
  private currentOffset = 0;
  hasMoreReports = false;
  isLoadingMore = false;

  // Near Me
  isNearMeActive = false;
  isGettingLocation = false;
  userLatitude: number | null = null;
  userLongitude: number | null = null;
  locationError = '';
  nearbyRadiusKm = 10;

  readonly barangays: string[] = [
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

  isLoading = false;
  errorMessage = '';

  constructor(
    private reportsService: ReportsService,
    public cdr: ChangeDetectorRef,
    private router: Router,
    private alertController: AlertController,
    private notificationsService: NotificationsService,
    private haptics: HapticsService,
    private authService: AuthService,
  ) {}

  ngOnInit(): void {
    this.unreadCountSubscription =
      this.notificationsService.unreadCount$.subscribe((count) => {
        this.unreadNotificationCount = count;
        this.cdr.detectChanges();
      });

    this.loadUnreadNotificationCount();
  }

  ngOnDestroy(): void {
    this.unreadCountSubscription?.unsubscribe();
    this.reportsRequestSubscription?.unsubscribe();
  }

  ionViewWillEnter(): void {
    // Reload whenever Home becomes active, including when returning
    // from another page while Ionic keeps this page cached.
    this.loadReports(true);
    this.loadUnreadNotificationCount();
  }

  // Notifications
  loadUnreadNotificationCount(): void {
    this.notificationsService.getUnreadCount().subscribe({
      error: (error) => {
        console.error('Unread notification count error:', error);
      },
    });
  }

  goToNotifications(): void {
    void this.router.navigateByUrl('/notifications');
  }

  get hasActiveFilters(): boolean {
    return (
      this.selectedType !== 'all' ||
      this.selectedCategory !== 'all' ||
      this.selectedBarangay !== 'all' ||
      this.searchTerm.trim().length > 0 ||
      this.isNearMeActive ||
      this.sortBy !== 'newest' 
    );
  }

  get displayedReports(): LostFoundReport[] {
    let result = [...this.reports];

    if (
      this.isNearMeActive &&
      this.userLatitude !== null &&
      this.userLongitude !== null
    ) {
      // Filter by straight-line distance using the loaded API results.
      // Near Me loads every matching API page before displaying results.
      result = result.filter((report) => {
        const distance = this.getDistanceKm(report);
        return distance !== null && distance <= this.nearbyRadiusKm;
      });
    }

    return result.sort((a, b) => {
      switch (this.sortBy) {
        case 'nearest': {
          // Only use distance order while we have a valid Near Me location.
          if (this.isNearMeActive) {
            return (
              (this.getDistanceKm(a) ?? Infinity) -
              (this.getDistanceKm(b) ?? Infinity)
            ) || (this.getReportTimestamp(b) - this.getReportTimestamp(a));
          }
          return this.getReportTimestamp(b) - this.getReportTimestamp(a);
        }

        case 'oldest':
          return this.getReportTimestamp(a) - this.getReportTimestamp(b);

        case 'name_asc':
          return a.item_name.localeCompare(b.item_name);

        case 'name_desc':
          return b.item_name.localeCompare(a.item_name);

        case 'newest':
        default:
          return this.getReportTimestamp(b) - this.getReportTimestamp(a);
      }
    });
  }

  private getReportTimestamp(report: LostFoundReport): number {
    const value = report.created_at;

    if (!value) {
      return 0;
    }

    const timestamp = new Date(value).getTime();
    return Number.isFinite(timestamp) ? timestamp : 0;
  }

  goToCreateReport(): void {
    void this.router.navigateByUrl('/create-report');
  }

  goToMyReports(): void {
    void this.router.navigateByUrl('/my-reports');
  }

  goToMyClaims(): void {
    void this.router.navigateByUrl('/my-claims');
  }

  viewDetails(reportId: number): void {
    void this.router.navigate(['/report-details', reportId]);
  }

  logout(): void {
    this.authService.logout();
    this.notificationsService.setUnreadCount(0);
    void this.router.navigateByUrl('/login');
  }

  getImageUrl(imagePath: string | null): string | null {
    return this.reportsService.getImageUrl(imagePath);
  }

  onReportImageError(report: LostFoundReport): void {
    report.image_url = null;
    this.cdr.detectChanges();
  }

  loadReports(force = false): void {
    // Prevent duplicate requests unless this is a forced refresh.
    if (this.isLoading && !force) {
      return;
    }

    // Cancel an older request so its response cannot overwrite
    // the results of the newer request.
    this.reportsLoadGeneration += 1;
    this.reportsRequestSubscription?.unsubscribe();
    this.reportsRequestSubscription = undefined;

    this.isLoading = true;
    this.isLoadingMore = false;
    this.errorMessage = '';
    this.currentOffset = 0;
    this.hasMoreReports = false;
    this.reports = [];
    this.cdr.detectChanges();

    this.fetchReports(0, false, this.reportsLoadGeneration);
  }

  loadMoreReports(): void {
    if (
      this.isLoading ||
      this.isLoadingMore ||
      !this.hasMoreReports
    ) {
      return;
    }

    this.isLoadingMore = true;
    this.errorMessage = '';
    this.cdr.detectChanges();

    this.fetchReports(this.currentOffset, true, this.reportsLoadGeneration);
  }

  private fetchReports(
    offset: number,
    append: boolean,
    generation: number,
  ): void {
    this.reportsRequestSubscription = this.reportsService
      .getReports({
        report_type:
          this.selectedType === 'all' ? undefined : this.selectedType,
        category:
          this.selectedCategory === 'all'
            ? undefined
            : this.selectedCategory,
        barangay:
          this.selectedBarangay === 'all'
            ? undefined
            : this.selectedBarangay,
        search: this.searchTerm.trim() || undefined,
        limit: this.pageSize,
        offset,
      })
      .subscribe({
        next: (response) => {
          if (generation !== this.reportsLoadGeneration) return;

          const incomingReports = response.reports ?? [];

          if (append) {
            const existingIds = new Set(
              this.reports.map((report) => report.id),
            );

            const uniqueReports = incomingReports.filter(
              (report) => !existingIds.has(report.id),
            );

            this.reports = [...this.reports, ...uniqueReports];
          } else {
            this.reports = incomingReports;
          }

          this.currentOffset = offset + incomingReports.length;
          this.hasMoreReports = incomingReports.length === this.pageSize;

          // The public API paginates by date, not by distance. Read every
          // matching page while Near Me is on so older nearby reports count.
          if (this.isNearMeActive && this.hasMoreReports) {
            this.fetchReports(this.currentOffset, true, generation);
            return;
          }

          this.isLoading = false;
          this.isLoadingMore = false;
          this.errorMessage = '';
          this.cdr.detectChanges();
        },
        error: (error) => {
          if (generation !== this.reportsLoadGeneration) return;
          console.error('REPORTS ERROR:', error);

          this.isLoading = false;
          this.isLoadingMore = false;

          const message = error.status === 0
            ? 'Cannot connect to the server. Please check your connection and try again.'
            : 'Unable to load reports. Please try again.';

          if (append) {
            // A failed Load More must not replace reports already on-screen
            // with the full-page error state.
            void this.showLoadMoreAlert(message);
          } else {
            this.errorMessage = message;
          }

          this.cdr.detectChanges();
        },
      });
  }

  private async showLoadMoreAlert(message: string): Promise<void> {
    const alert = await this.alertController.create({
      header: 'Unable to Load More',
      message,
      buttons: ['OK'],
    });
    await alert.present();
  }

  onSortChange(event: CustomEvent): void {
    const value = event.detail.value as ReportSortOption | undefined;

    if (
      value === 'nearest' ||
      value === 'newest' ||
      value === 'oldest' ||
      value === 'name_asc' ||
      value === 'name_desc'
    ) {
      this.sortBy = value;
    } else {
      this.sortBy = 'newest';
    }

    this.cdr.detectChanges();
  }

  async useNearMe(): Promise<void> {
    if (this.isGettingLocation) {
      return;
    }

    await this.haptics.lightImpact();

    this.isGettingLocation = true;
    this.locationError = '';
    this.cdr.detectChanges();

    try {
      let permission = await Geolocation.checkPermissions();

      if (
        permission.location !== 'granted' &&
        permission.coarseLocation !== 'granted'
      ) {
        permission = await Geolocation.requestPermissions();
      }

      if (
        permission.location !== 'granted' &&
        permission.coarseLocation !== 'granted'
      ) {
        throw new Error(
          'Location permission was denied. Please allow location access in your device settings.',
        );
      }

      const position = await Geolocation.getCurrentPosition({
        enableHighAccuracy: true,
        timeout: 20000,
        maximumAge: 60000,
      });

      this.userLatitude = position.coords.latitude;
      this.userLongitude = position.coords.longitude;
      if (!this.isNearMeActive) {
        this.sortBeforeNearMe = this.sortBy;
      }
      this.isNearMeActive = true;
      this.sortBy = 'nearest';
      this.locationError = '';
      this.loadReports(true);

      await this.haptics.success();
    } catch (error: unknown) {
      console.error('NEAR ME LOCATION ERROR:', error);

      const message =
        error instanceof Error ? error.message : String(error);

      if (
        message.toLowerCase().includes('permission') ||
        message.toLowerCase().includes('denied')
      ) {
        this.locationError =
          'Location permission was denied. Please check your device settings.';
      } else if (message.toLowerCase().includes('timeout')) {
        this.locationError =
          'Getting your location took too long. Please try again.';
      } else {
        this.locationError =
          'Unable to get your current location. Check that Location is enabled on your phone.';
      }

      await this.haptics.warning();
      await this.showLocationAlert(this.locationError);
    } finally {
      this.isGettingLocation = false;
      this.cdr.detectChanges();
    }
  }

  clearNearMe(): void {
    const wasActive = this.isNearMeActive;
    this.isNearMeActive = false;
    this.sortBy = this.sortBeforeNearMe === 'nearest'
      ? 'newest'
      : this.sortBeforeNearMe;
    this.userLatitude = null;
    this.userLongitude = null;
    this.locationError = '';
    if (wasActive) {
      // Stop any in-progress Near Me page scan; restore normal pagination.
      this.loadReports(true);
    } else {
      this.cdr.detectChanges();
    }
  }

  getDistanceKm(report: LostFoundReport): number | null {
    if (
      this.userLatitude === null ||
      this.userLongitude === null ||
      report.latitude === null ||
      report.latitude === undefined ||
      report.longitude === null ||
      report.longitude === undefined
    ) {
      return null;
    }

    const lat1 = Number(this.userLatitude);
    const lon1 = Number(this.userLongitude);
    const lat2 = Number(report.latitude);
    const lon2 = Number(report.longitude);

    if (
      !Number.isFinite(lat1) ||
      !Number.isFinite(lon1) ||
      !Number.isFinite(lat2) ||
      !Number.isFinite(lon2) ||
      lat1 < -90 ||
      lat1 > 90 ||
      lon1 < -180 ||
      lon1 > 180 ||
      lat2 < -90 ||
      lat2 > 90 ||
      lon2 < -180 ||
      lon2 > 180
    ) {
      return null;
    }

    const toRadians = (degrees: number): number =>
      (degrees * Math.PI) / 180;

    const earthRadiusKm = 6371;
    const deltaLatitude = toRadians(lat2 - lat1);
    const deltaLongitude = toRadians(lon2 - lon1);

    const a =
      Math.sin(deltaLatitude / 2) ** 2 +
      Math.cos(toRadians(lat1)) *
        Math.cos(toRadians(lat2)) *
        Math.sin(deltaLongitude / 2) ** 2;

    const safeA = Math.min(1, Math.max(0, a));

    return (
      earthRadiusKm *
      2 *
      Math.atan2(Math.sqrt(safeA), Math.sqrt(1 - safeA))
    );
  }

  formatDistance(report: LostFoundReport): string {
    const distance = this.getDistanceKm(report);

    if (distance === null) {
      return 'Distance unavailable';
    }

    if (distance < 1) {
      return `${Math.round(distance * 1000)} m away`;
    }

    return `${distance.toFixed(1)} km away`;
  }

  private async showLocationAlert(message: string): Promise<void> {
    const alert = await this.alertController.create({
      header: 'Location Unavailable',
      message,
      buttons: ['OK'],
    });

    await alert.present();
  }

  onSearchChange(event: CustomEvent): void {
    this.searchTerm = event.detail.value ?? '';
    this.loadReports(true);
  }

  onTypeChange(event: CustomEvent): void {
    this.selectedType = event.detail.value ?? 'all';
    this.loadReports(true);
  }

  onCategoryChange(event: CustomEvent): void {
    this.selectedCategory = event.detail.value ?? 'all';
    this.loadReports(true);
  }

  onBarangayChange(event: CustomEvent): void {
    this.selectedBarangay = event.detail.value ?? 'all';
    this.loadReports(true);
  }

  resetFilters(): void {
    this.selectedType = 'all';
    this.selectedCategory = 'all';
    this.selectedBarangay = 'all';
    this.searchTerm = '';
    this.sortBeforeNearMe = 'newest';
    this.isNearMeActive = false;
    this.userLatitude = null;
    this.userLongitude = null;
    this.locationError = '';
    this.sortBy = 'newest';
    this.loadReports(true);
  }

  trackByReportId(_index: number, report: LostFoundReport): number {
    return report.id;
  }
}