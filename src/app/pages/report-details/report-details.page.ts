import { CommonModule } from '@angular/common';
import {
  Component,
  ChangeDetectorRef,
  OnDestroy,
} from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';

import {
  AlertController,
  ToastController,
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonSpinner,
  IonTitle,
  IonToolbar,
  IonCard,
  IonCardContent,
  IonBadge,
  IonText,
  IonIcon,
} from '@ionic/angular';

import {
  DomSanitizer,
  SafeResourceUrl,
} from '@angular/platform-browser';

import {
  Subscription,
  of,
  switchMap,
  timeout,
} from 'rxjs';

import { AuthService } from '../../services/auth';

import {
  ClaimRequest,
  LostFoundReport,
  ReportsService,
} from '../../services/reports';

import { HapticsService } from '../../services/haptics';
import { ChatService } from '../../services/chat';

// Icons used by the redesigned Report Details page.
import { addIcons } from 'ionicons';
import {
  arrowBackOutline,
  locationOutline,
  mapOutline,
  chatbubbleOutline,
} from 'ionicons/icons';

addIcons({
  arrowBackOutline,
  locationOutline,
  mapOutline,
  chatbubbleOutline,
});

@Component({
  selector: 'app-report-details',
  standalone: true,
  templateUrl: './report-details.page.html',
  styleUrls: ['./report-details.page.scss'],
  imports: [
    CommonModule,
    IonButton,
    IonButtons,
    IonContent,
    IonHeader,
    IonSpinner,
    IonTitle,
    IonToolbar,
    IonCard,
    IonCardContent,
    IonBadge,
    IonText,
    IonIcon,
  ],
})
export class ReportDetailsPage implements OnDestroy {

  // ==========================================
  // REPORT AND CLAIM STATE
  // ==========================================

  report: LostFoundReport | null = null;
  myClaim: ClaimRequest | null = null;

  currentUserId: number | null = null;
  imageUrl: string | null = null;
  private cachedMapUrl: SafeResourceUrl | null = null;

  isLoading = true;
  isLoadingMyClaim = false;
  // Do not enable new claims when the server could not verify existing requests.
  claimStatusUnavailable = false;
  isSubmittingClaim = false;
  isProcessingHandover = false;

  openingChat = false;
  chatErrorMessage = '';
  errorMessage = '';

  // ==========================================
  // RETRY CLAIM CONFIGURATION
  // ==========================================

  private readonly rejectedClaimCooldownMs =
    24 * 60 * 60 * 1000;

  // ==========================================
  // SUBSCRIPTIONS
  // ==========================================

  private reportRequest?: Subscription;
  private claimRequest?: Subscription;
  private submitClaimRequest?: Subscription;
  private handoverRequest?: Subscription;
  private chatRequest?: Subscription;
  private routeSubscription?: Subscription;

  private destroyed = false;
  private currentReportId: number | null = null;

  constructor(
    private route: ActivatedRoute,
    private router: Router,
    private reportsService: ReportsService,
    private authService: AuthService,
    private cdr: ChangeDetectorRef,
    private alertController: AlertController,
    private toastController: ToastController,
    private sanitizer: DomSanitizer,
    private haptics: HapticsService,
    private chatService: ChatService,
  ) {}

  // ==========================================
  // INITIALIZATION
  // ==========================================

  ngOnInit(): void {
    this.currentUserId =
      this.authService.getCurrentUser()?.id ?? null;

    this.routeSubscription =
      this.route.paramMap.subscribe((params) => {
        const reportId = Number(params.get('id'));

        if (
          !Number.isInteger(reportId) ||
          reportId <= 0
        ) {
          this.reportRequest?.unsubscribe();
          this.claimRequest?.unsubscribe();
          this.chatRequest?.unsubscribe();

          this.currentReportId = null;
          this.report = null;
          this.myClaim = null;
          this.imageUrl = null;
          this.cachedMapUrl = null;
          this.claimStatusUnavailable = false;

          this.isLoading = false;
          this.isLoadingMyClaim = false;
          this.errorMessage = 'Invalid report ID.';

          this.refreshUI();
          return;
        }

        this.loadReport(reportId);
      });
  }

  // ==========================================
  // REFRESH WHEN RETURNING TO PAGE
  // ==========================================

  ionViewWillEnter(): void {
    const reportId = Number(
      this.route.snapshot.paramMap.get('id'),
    );

    // paramMap already loads a newly opened report. Avoid a second
    // simultaneous HTTP request during the initial Ionic view enter.
    // Returning to an existing cached page still refreshes its data.
    if (
      Number.isSafeInteger(reportId) &&
      reportId > 0 &&
      !(this.currentReportId === reportId && this.isLoading)
    ) {
      this.currentUserId =
        this.authService.getCurrentUser()?.id ?? null;
      this.loadReport(reportId);
    }
  }

  // ==========================================
  // UI REFRESH HELPER
  // ==========================================

  private refreshUI(): void {
    if (!this.destroyed) {
      this.cdr.detectChanges();
    }
  }

  // ==========================================
  // LOAD REPORT
  // ==========================================

  private loadReport(reportId: number): void {
    this.currentReportId = reportId;

    this.chatRequest?.unsubscribe();
    this.reportRequest?.unsubscribe();
    this.claimRequest?.unsubscribe();

    this.openingChat = false;
    this.chatErrorMessage = '';

    this.report = null;
    this.myClaim = null;
    this.imageUrl = null;
    this.cachedMapUrl = null;
    this.claimStatusUnavailable = false;

    this.isLoading = true;
    this.isLoadingMyClaim = false;
    this.errorMessage = '';

    this.refreshUI();

    this.reportRequest = this.reportsService
      .getReportById(reportId)
      .subscribe({
        next: (report) => {
          if (
            this.destroyed ||
            this.currentReportId !== reportId
          ) {
            return;
          }

          this.report = report;

          this.imageUrl =
            this.reportsService.getImageUrl(
              report.image_url,
            );
          this.cachedMapUrl = this.buildMapUrl(report);

          this.isLoading = false;

          if (this.currentUserId === null) {
            // Without an authenticated user we cannot establish whether
            // this user already submitted a claim.
            this.claimStatusUnavailable = true;
            this.myClaim = null;
            this.isLoadingMyClaim = false;
          } else if (report.user_id !== this.currentUserId) {
            this.loadMyClaim(reportId);
          } else {
            this.myClaim = null;
            this.isLoadingMyClaim = false;
          }

          this.refreshUI();
        },

        error: (error) => {
          if (
            this.destroyed ||
            this.currentReportId !== reportId
          ) {
            return;
          }

          console.error(
            'Load report details error:',
            error,
          );

          this.isLoading = false;

          this.errorMessage =
            error?.error?.detail ||
            'Unable to load report details. Please try again.';

          this.refreshUI();
        },
      });
  }

  // ==========================================
  // OPENSTREETMAP EMBED URL
  // ==========================================

  getMapUrl(): SafeResourceUrl | null {
    return this.cachedMapUrl;
  }

  // Cache the trusted URL once per report, rather than recreating it
  // on every Angular change-detection pass (which can reload iframes).
  private buildMapUrl(report: LostFoundReport): SafeResourceUrl | null {
    const latitude = report.latitude;
    const longitude = report.longitude;

    if (
      latitude === null ||
      latitude === undefined ||
      longitude === null ||
      longitude === undefined ||
      !Number.isFinite(Number(latitude)) ||
      !Number.isFinite(Number(longitude)) ||
      Number(latitude) < -90 ||
      Number(latitude) > 90 ||
      Number(longitude) < -180 ||
      Number(longitude) > 180
    ) {
      return null;
    }

    const lat = Number(latitude);
    const lon = Number(longitude);
    const delta = 0.005;

    const params = new URLSearchParams({
      bbox: [
        lon - delta,
        lat - delta,
        lon + delta,
        lat + delta,
      ].join(','),
      layer: 'mapnik',
      marker: `${lat},${lon}`,
    });

    const mapUrl =
      `https://www.openstreetmap.org/export/embed.html?${params.toString()}`;

    return this.sanitizer.bypassSecurityTrustResourceUrl(
      mapUrl,
    );
  }

  // ==========================================
  // OPEN MAP
  // ==========================================

  openMap(): void {
    if (!this.report) {
      return;
    }

    const latitude = this.report.latitude;
    const longitude = this.report.longitude;

    if (
      latitude === null ||
      latitude === undefined ||
      longitude === null ||
      longitude === undefined
    ) {
      return;
    }

    const lat = Number(latitude);
    const lon = Number(longitude);

    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lon) ||
      lat < -90 ||
      lat > 90 ||
      lon < -180 ||
      lon > 180
    ) {
      return;
    }

    const mapUrl =
      `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=17/${lat}/${lon}`;

    window.open(
      mapUrl,
      '_blank',
      'noopener,noreferrer',
    );
  }

  // ==========================================
  // IMAGE ERROR
  // ==========================================

  onImageError(): void {
    this.imageUrl = null;
    this.refreshUI();
  }

  // ==========================================
  // LOAD CURRENT USER'S CLAIM
  // ==========================================

  private loadMyClaim(reportId: number): void {
    this.claimRequest?.unsubscribe();

    this.isLoadingMyClaim = true;
    this.claimStatusUnavailable = false;
    this.refreshUI();

    this.claimRequest = this.reportsService
      .getMyClaimForReport(reportId)
      .subscribe({
        next: (response) => {
          if (
            this.destroyed ||
            this.currentReportId !== reportId
          ) {
            return;
          }

          this.myClaim = response.claim;
          this.isLoadingMyClaim = false;
          this.claimStatusUnavailable = false;

          this.refreshUI();
        },

        error: (error) => {
          if (
            this.destroyed ||
            this.currentReportId !== reportId
          ) {
            return;
          }

          console.error(
            'Load claim status error:',
            error,
          );

          this.isLoadingMyClaim = false;
          this.claimStatusUnavailable = true;

          // Keep the user from submitting while the existing claim
          // status is unknown. Re-enter the page to retry the lookup.
          this.refreshUI();
        },
      });
  }

  // ==========================================
  // CLAIM ACTION LABELS
  // ==========================================

  get requestActionLabel(): string {
    return this.report?.report_type === 'lost'
      ? 'I Found This Item'
      : 'Claim This Item';
  }

  get requestDescription(): string {
    return this.report?.report_type === 'lost'
      ? 'Think you found this lost item? Send a response and discuss the details privately with the owner.'
      : 'Think this item belongs to you? Submit a claim and verify ownership with the finder through private chat.';
  }

  // ==========================================
  // COOLDOWN DATE PARSING
  // ==========================================

  private parseClaimUpdatedAt(
    value: string | null | undefined,
  ): number | null {
    if (!value || typeof value !== 'string') {
      return null;
    }

    const raw = value.trim();

    if (!raw) {
      return null;
    }

    // The backend uses UTC_TIMESTAMP() for its
    // 24-hour cooldown comparison.
    //
    // A timestamp with an explicit timezone is
    // parsed using that timezone.
    //
    // A timestamp without timezone information
    // is interpreted as UTC. This assumption
    // must match the backend database configuration.

    const normalized = raw.replace(' ', 'T');

    const hasTimezone =
      /(?:Z|[+-]\d{2}:\d{2})$/i.test(normalized);

    const timestamp = Date.parse(
      hasTimezone
        ? normalized
        : `${normalized}Z`,
    );

    if (!Number.isFinite(timestamp)) {
      return null;
    }

    return timestamp;
  }

  // ==========================================
  // RETRY TIMESTAMP VALIDATION
  // ==========================================

  get hasValidRetryTimestamp(): boolean {
    if (
      !this.myClaim ||
      this.myClaim.status !== 'rejected'
    ) {
      return false;
    }

    return this.parseClaimUpdatedAt(
      this.myClaim.updated_at,
    ) !== null;
  }

  get isRetryTimestampMissing(): boolean {
    return (
      this.myClaim?.status === 'rejected' &&
      !this.hasValidRetryTimestamp
    );
  }

  // ==========================================
  // RETRY COOLDOWN REMAINING TIME
  // ==========================================

  get retryCooldownRemainingMs(): number {
    if (
      !this.myClaim ||
      this.myClaim.status !== 'rejected'
    ) {
      return 0;
    }

    const rejectedAt = this.parseClaimUpdatedAt(
      this.myClaim.updated_at,
    );

    if (rejectedAt === null) {
      return 0;
    }

    const eligibleAt =
      rejectedAt + this.rejectedClaimCooldownMs;

    return Math.max(
      0,
      eligibleAt - Date.now(),
    );
  }

  // ==========================================
  // RETRY COOLDOWN STATUS
  // ==========================================

  get isRetryCooldownActive(): boolean {
    if (
      !this.myClaim ||
      this.myClaim.status !== 'rejected'
    ) {
      return false;
    }

    // Safety fix:
    // Unknown timestamp must not be treated
    // as an expired cooldown.
    if (!this.hasValidRetryTimestamp) {
      return true;
    }

    return this.retryCooldownRemainingMs > 0;
  }

  // ==========================================
  // RETRY AVAILABLE DATE
  // ==========================================

  get retryAvailableAt(): string {
    if (
      !this.myClaim ||
      this.myClaim.status !== 'rejected'
    ) {
      return '';
    }

    const rejectedAt = this.parseClaimUpdatedAt(
      this.myClaim.updated_at,
    );

    if (rejectedAt === null) {
      return '';
    }

    const eligibleAt = new Date(
      rejectedAt + this.rejectedClaimCooldownMs,
    );

    return eligibleAt.toLocaleString('en-PH', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZone: 'Asia/Manila',
    });
  }

  // ==========================================
  // COOLDOWN INFORMATION MESSAGE
  // ==========================================

  get retryCooldownMessage(): string {
    if (
      !this.myClaim ||
      this.myClaim.status !== 'rejected'
    ) {
      return '';
    }

    // Invalid or missing timestamp:
    // Show a safe message instead of falsely
    // declaring that retry is available.
    if (this.isRetryTimestampMissing) {
      return (
        'Your previous request was closed. ' +
        'The retry availability time could not be verified ' +
        'because the request timestamp is missing or invalid. ' +
        'Please try again later or contact support.'
      );
    }

    if (this.isRetryCooldownActive) {
      return this.retryAvailableAt
        ? (
            'Your previous request was closed. ' +
            'You can submit another request after ' +
            this.retryAvailableAt +
            ' (Philippine time), provided the report is still active.'
          )
        : (
            'Your previous request was closed. ' +
            'Please wait 24 hours before submitting another request.'
          );
    }

    return (
      'The 24-hour cooldown appears to have ended. ' +
      'You may submit another request ' +
      'if this report is still active. ' +
      'The server will verify your eligibility.'
    );
  }

  // ==========================================
  // CLAIM ELIGIBILITY
  // ==========================================

  get isOwner(): boolean {
    return (
      !!this.report &&
      this.currentUserId !== null &&
      this.report.user_id === this.currentUserId
    );
  }

  get canRequestClaim(): boolean {
    return (
      !!this.report &&
      !this.isOwner &&
      !this.isLoading &&
      !this.isLoadingMyClaim &&
      !this.claimStatusUnavailable &&
      this.currentUserId !== null &&
      !this.isSubmittingClaim &&
      this.report.status === 'active' &&
      !this.myClaim
    );
  }

  // ==========================================
  // RETRY ELIGIBILITY
  // ==========================================

  get canRetryClaim(): boolean {
    return (
      !!this.report &&
      !this.isOwner &&
      !this.isLoading &&
      !this.isLoadingMyClaim &&
      !this.claimStatusUnavailable &&
      this.currentUserId !== null &&
      !this.isSubmittingClaim &&
      this.report.status === 'active' &&
      this.myClaim?.status === 'rejected' &&
      this.hasValidRetryTimestamp &&
      !this.isRetryCooldownActive
    );
  }

  // ==========================================
  // REQUEST CLAIM / RETRY CLAIM
  // ==========================================

  async requestClaim(): Promise<void> {
    if (
      !this.report ||
      this.destroyed ||
      this.isSubmittingClaim ||
      this.isLoading ||
      this.isLoadingMyClaim ||
      this.claimStatusUnavailable ||
      this.currentUserId === null ||
      this.report.status !== 'active' ||
      this.isOwner
    ) {
      return;
    }

    const hasExistingClaim = !!this.myClaim;

    if (hasExistingClaim && !this.canRetryClaim) {
      if (
        this.myClaim?.status === 'rejected' &&
        this.isRetryCooldownActive
      ) {
        await this.showRetryCooldownNotice();
      }

      return;
    }

    if (
      !hasExistingClaim &&
      !this.canRequestClaim
    ) {
      return;
    }

    const reportId = this.report.id;

    const isLostReport =
      this.report.report_type === 'lost';

    const isRetry = hasExistingClaim;

    const alert = await this.alertController.create({
      header: isRetry
        ? (isLostReport ? 'Send Another Response' : 'Submit Another Claim')
        : (isLostReport ? 'I Found This Item' : 'Claim This Item'),

      message: isLostReport
        ? 'Found an item that matches this report? Let the owner know. You can discuss the details and verify the item through private chat.'
        : 'Think this item belongs to you? Send a claim to the finder. You can discuss the details and verify ownership through private chat.',

      inputs: [
        {
          name: 'message',
          type: 'textarea',
          placeholder: 'Additional description (optional)',
          attributes: {
            maxlength: 500,
            'aria-label': 'Additional description (optional)',
          },
        },
      ],

      buttons: [
        {
          text: 'Cancel',
          role: 'cancel',
        },
        {
          text: isLostReport ? 'Send Response' : 'Submit Claim',
          role: 'confirm',
          handler: (values) => {
            if (
              this.destroyed ||
              this.currentReportId !== reportId ||
              this.isSubmittingClaim
            ) {
              return false;
            }

            const message = String(values?.message ?? '').trim();

            if (message.length > 500) {
              void this.showDescriptionValidationError();
              return false;
            }

            if (isRetry && !this.canRetryClaim) {
              if (this.isRetryCooldownActive) {
                void this.showRetryCooldownNotice();
              }
              return false;
            }

            this.submitClaim(message);
            return true;
          },
        },
      ],
    });

    if (!this.destroyed) {
      await alert.present();
    }
  }

  // ==========================================
  // COOLDOWN NOTICE
  // ==========================================

  private async showRetryCooldownNotice(): Promise<void> {
    if (this.destroyed) {
      return;
    }

    const alert = await this.alertController.create({
      header: this.isRetryTimestampMissing
        ? 'Retry Time Unavailable'
        : 'Please Wait Before Retrying',
      message: this.retryCooldownMessage,
      buttons: ['OK'],
    });

    if (!this.destroyed) {
      await alert.present();
    }
  }

  // ==========================================
  // VERIFICATION VALIDATION ERROR
  // ==========================================

  private async showDescriptionValidationError():
    Promise<void> {

    if (this.destroyed) {
      return;
    }

    const toast = await this.toastController.create({
      message:
        'Additional description must not exceed 500 characters.',
      duration: 3500,
      color: 'warning',
    });

    if (!this.destroyed) {
      await toast.present();
    }
  }

  // ==========================================
  // SUBMIT CLAIM
  // ==========================================

  private submitClaim(message: string): void {
    if (
      !this.report ||
      this.destroyed ||
      this.isSubmittingClaim ||
      this.isLoadingMyClaim ||
      this.claimStatusUnavailable ||
      this.currentUserId === null ||
      this.report.status !== 'active' ||
      this.isOwner ||
      message.trim().length > 500
    ) {
      return;
    }

    if (
      this.myClaim &&
      !this.canRetryClaim
    ) {
      return;
    }

    const reportId = this.report.id;

    const isLostReport =
      this.report.report_type === 'lost';

    this.isSubmittingClaim = true;
    this.refreshUI();

    this.submitClaimRequest =
      this.reportsService
        .createClaimRequest(
          reportId,
          message,
          '',
        )
        .subscribe({
          next: async () => {
            if (
              this.destroyed ||
              this.currentReportId !== reportId
            ) {
              return;
            }

            this.isSubmittingClaim = false;
            this.refreshUI();

            await this.haptics.success();

            const toast =
              await this.toastController.create({
                message: isLostReport
                  ? 'Your response was submitted. You can now start a private chat with the owner.'
                  : 'Your ownership claim was submitted. Wait for the finder to review it.',
                duration: 3000,
                color: 'success',
              });

            if (!this.destroyed) {
              await toast.present();
            }

            if (
              !this.destroyed &&
              this.currentReportId === reportId
            ) {
              this.loadMyClaim(reportId);
            }
          },

          error: async (error) => {
            if (
              this.destroyed ||
              this.currentReportId !== reportId
            ) {
              return;
            }

            this.isSubmittingClaim = false;
            this.refreshUI();

            await this.haptics.warning();

            const fallbackMessage = isLostReport
              ? 'Unable to submit your found-item response. Please try again.'
              : 'Unable to submit your ownership claim. Please try again.';

            const serverMessage =
              error?.error?.detail;

            const errorMessage =
              typeof serverMessage === 'string'
                ? serverMessage
                : error?.status === 429
                  ? 'Please wait 24 hours after your previous rejection before submitting another request.'
                  : fallbackMessage;

            const toast =
              await this.toastController.create({
                message: errorMessage,
                duration: 4000,
                color: error?.status === 429
                  ? 'warning'
                  : 'danger',
              });

            if (!this.destroyed) {
              await toast.present();
            }

            if (
              error?.status === 409 ||
              error?.status === 429
            ) {
              this.loadReport(reportId);
            }
          },
        });
  }

  // ==========================================
  // OPEN CLAIM CHAT ELIGIBILITY
  // ==========================================

  get canOpenClaimChat(): boolean {
    return (
      !!this.report &&
      !this.isOwner &&
      !!this.myClaim &&
      !this.isLoading &&
      !this.isSubmittingClaim &&
      Number.isSafeInteger(this.myClaim.id) &&
      this.myClaim.id > 0
    );
  }

  // ==========================================
  // OPEN PRIVATE CLAIM CHAT
  // ==========================================

  openClaimChat(): void {
    if (
      !this.canOpenClaimChat ||
      this.openingChat ||
      !this.myClaim
    ) {
      return;
    }

    const claim = this.myClaim;
    const reportId = this.currentReportId;

    const canStart =
      (
        claim.status === 'pending' ||
        claim.status === 'approved'
      ) &&
      (
        this.report?.status === 'active' ||
        this.report?.status === 'claimed'
      );

    this.chatRequest?.unsubscribe();

    this.openingChat = true;
    this.chatErrorMessage = '';
    this.refreshUI();

    this.chatRequest = this.chatService
      .getConversationForClaim(claim.id)
      .pipe(
        timeout(15000),
        switchMap(({ conversation }) => {
          if (conversation) {
            return of(conversation);
          }

          if (!canStart) {
            return of(null);
          }

          return this.chatService
            .startConversation(claim.id)
            .pipe(
              timeout(15000),
              switchMap((response) =>
                of(response.conversation),
              ),
            );
        }),
      )
      .subscribe({
        next: (conversation) => {
          if (
            reportId !== this.currentReportId ||
            this.destroyed
          ) {
            return;
          }

          this.openingChat = false;

          if (conversation) {
            void this.router.navigate([
              '/chat',
              conversation.id,
            ]);
          } else {
            this.chatErrorMessage =
              'No existing chat history is available for this request.';
          }

          this.refreshUI();
        },

        error: (error) => {
          if (
            reportId !== this.currentReportId ||
            this.destroyed
          ) {
            return;
          }

          this.openingChat = false;

          this.chatErrorMessage =
            error?.name === 'TimeoutError'
              ? 'Chat connection timed out. Please try again.'
              : typeof error?.error?.detail === 'string'
                ? error.error.detail
                : 'Unable to open the private chat. Please try again.';

          this.refreshUI();
        },
      });
  }

  // ==========================================
  // REQUESTER HANDOVER ELIGIBILITY
  // ==========================================

  get canConfirmRequesterReturn(): boolean {
    const claim = this.myClaim;
    const report = this.report;

    if (
      !claim ||
      !report ||
      this.isOwner ||
      this.isProcessingHandover
    ) {
      return false;
    }

    if (
      claim.status !== 'approved' ||
      report.status !== 'claimed' ||
      !!claim.requester_return_confirmed_at
    ) {
      return false;
    }

    return (
      report.report_type !== 'lost' ||
      !!claim.owner_return_confirmed_at
    );
  }

  // ==========================================
  // HANDOVER PROGRESS MESSAGE
  // ==========================================

  get requesterReturnProgress(): string {
    const claim = this.myClaim;
    const report = this.report;

    if (!claim || !report) {
      return '';
    }

    if (report.status === 'returned') {
      return (
        'Both parties confirmed the physical handover. ' +
        'Item marked as returned.'
      );
    }

    if (claim.status === 'rejected') {
      return (
        'This request is closed. ' +
        'You cannot confirm a handover.'
      );
    }

    if (
      report.report_type === 'lost' &&
      claim.status === 'pending'
    ) {
      return (
        'Coordinate with the owner through private chat. ' +
        'The owner will confirm after physically receiving ' +
        'the item; then you can confirm handing it over.'
      );
    }

    if (claim.status !== 'approved') {
      return '';
    }

    if (
      claim.requester_return_confirmed_at &&
      claim.owner_return_confirmed_at
    ) {
      return (
        'Both confirmations were recorded. ' +
        'Refreshing the report status may be needed.'
      );
    }

    if (claim.requester_return_confirmed_at) {
      return (
        'You confirmed the handover. ' +
        'Waiting for the other participant.'
      );
    }

    if (claim.owner_return_confirmed_at) {
      return report.report_type === 'lost'
        ? 'The owner confirmed receiving the item. Please confirm only after you physically handed it over.'
        : 'The finder confirmed handing over the item. Your confirmation is still needed.';
    }

    return report.report_type === 'lost'
      ? 'Wait until the owner confirms physically receiving the item.'
      : 'Awaiting physical handover and confirmation from both parties.';
  }

  // ==========================================
  // CONFIRM REQUESTER HANDOVER
  // ==========================================

  async confirmRequesterReturn(): Promise<void> {
    if (
      !this.canConfirmRequesterReturn ||
      !this.myClaim
    ) {
      return;
    }

    const claimId = this.myClaim.id;

    const isLost =
      this.report?.report_type === 'lost';

    const alert = await this.alertController.create({
      header: isLost
        ? 'Confirm Item Handed Over?'
        : 'Confirm Item Received?',

      message: isLost
        ? 'The owner has confirmed receiving the item. Confirm only if you physically handed the found item back to them.'
        : 'Confirm only if you physically received your item from the finder.',

      buttons: [
        {
          text: 'Cancel',
          role: 'cancel',
        },
        {
          text: 'Confirm',
          role: 'confirm',
          handler: () => {
            this.submitRequesterReturn(claimId);
          },
        },
      ],
    });

    if (!this.destroyed) {
      await alert.present();
    }
  }

  // ==========================================
  // SUBMIT HANDOVER CONFIRMATION
  // ==========================================

  private submitRequesterReturn(
    claimId: number,
  ): void {
    if (
      this.isProcessingHandover ||
      !this.canConfirmRequesterReturn ||
      this.myClaim?.id !== claimId
    ) {
      return;
    }

    const reportId = this.currentReportId;

    this.isProcessingHandover = true;
    this.refreshUI();

    this.handoverRequest =
      this.reportsService
        .confirmItemReturned(claimId)
        .subscribe({
          next: async (response) => {
            if (
              this.destroyed ||
              this.currentReportId !== reportId
            ) {
              return;
            }

            this.isProcessingHandover = false;

            if (reportId !== null) {
              this.loadReport(reportId);
            }

            await this.haptics.success();

            const toast =
              await this.toastController.create({
                message:
                  response.status === 'returned'
                    ? 'Both parties confirmed. The item is marked as returned.'
                    : 'Your handover confirmation was saved. Waiting for the other participant.',
                duration: 3200,
                color: 'success',
              });

            if (!this.destroyed) {
              await toast.present();
            }
          },

          error: async (error) => {
            if (
              this.destroyed ||
              this.currentReportId !== reportId
            ) {
              return;
            }

            this.isProcessingHandover = false;
            this.refreshUI();

            await this.haptics.warning();

            const toast =
              await this.toastController.create({
                message:
                  typeof error?.error?.detail === 'string'
                    ? error.error.detail
                    : 'Could not confirm the handover. Please try again.',
                duration: 3500,
                color: 'danger',
              });

            if (!this.destroyed) {
              await toast.present();
            }
          },
        });
  }

  // ==========================================
  // NAVIGATION CONTEXT
  // ==========================================

  get isFromMyClaims(): boolean {
    return this.route.snapshot.queryParamMap.get('from') === 'my-claims';
  }

  // Return to the page that opened this report.
  goBack(): void {
    void this.router.navigateByUrl(
      this.isFromMyClaims ? '/my-claims' : '/home'
    );
  }

  // ==========================================
  // COMPONENT CLEANUP
  // ==========================================

  ngOnDestroy(): void {
    this.destroyed = true;

    this.routeSubscription?.unsubscribe();
    this.reportRequest?.unsubscribe();
    this.claimRequest?.unsubscribe();
    this.submitClaimRequest?.unsubscribe();
    this.handoverRequest?.unsubscribe();
    this.chatRequest?.unsubscribe();
  }
}