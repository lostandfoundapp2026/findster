import { CommonModule } from '@angular/common';
import {
  Component,
  ChangeDetectorRef,
  ElementRef,
  OnDestroy,
  OnInit,
} from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { Subscription, switchMap, of } from 'rxjs';
import { addIcons } from 'ionicons';
import {
  arrowBackOutline,
  chatbubbleOutline,
  checkmarkCircleOutline,
  closeCircleOutline,
  createOutline,
  documentTextOutline,
  eyeOutline,
  locationOutline,
  refreshOutline,
  timeOutline,
  trashOutline,
  chevronDownOutline,
  chevronUpOutline,
} from 'ionicons/icons';

import {
  AlertController,
  ToastController,
  IonHeader,
  IonToolbar,
  IonButtons,
  IonButton,
  IonIcon,
  IonTitle,
  IonContent,
  IonSpinner,
  IonList,
  IonListHeader,
  IonLabel,
  IonCard,
  IonCardHeader,
  IonCardTitle,
  IonCardSubtitle,
  IonCardContent,
  IonBadge,
  IonNote,
} from '@ionic/angular';

import {
  ClaimRequest,
  LostFoundReport,
  ReportsService,
} from '../../services/reports';
import { HapticsService } from '../../services/haptics';
import { ChatService } from '../../services/chat';

// Register icons for the My Reports page.
addIcons({
  arrowBackOutline,
  chatbubbleOutline,
  checkmarkCircleOutline,
  closeCircleOutline,
  createOutline,
  documentTextOutline,
  eyeOutline,
  locationOutline,
  refreshOutline,
  timeOutline,
  trashOutline,
  chevronDownOutline,
  chevronUpOutline,
});

@Component({
  selector: 'app-my-reports',
  standalone: true,
  templateUrl: './my-reports.page.html',
  styleUrls: ['./my-reports.page.scss'],
  imports: [
    CommonModule,
    RouterLink,
    IonHeader,
    IonToolbar,
    IonButtons,
    IonButton,
    IonIcon,
    IonTitle,
    IonContent,
    IonSpinner,
    IonList,
    IonListHeader,
    IonLabel,
    IonCard,
    IonCardHeader,
    IonCardTitle,
    IonCardSubtitle,
    IonCardContent,
    IonBadge,
    IonNote,
  ],
})
export class MyReportsPage implements OnInit, OnDestroy {
  reports: LostFoundReport[] = [];
  receivedClaims: ClaimRequest[] = [];

  // Compact My Reports view. All filtering/pagination happens in memory;
  // existing backend calls and claim actions remain unchanged.
  activeSection: 'reports' | 'requests' = 'reports';
  selectedReportFilter = 'all';
  readonly reportFilterOptions = [
    { value: 'all', label: 'All' },
    { value: 'active', label: 'Active' },
    { value: 'claimed', label: 'Claimed' },
    { value: 'returned', label: 'Returned' },
  ];
  readonly itemsPerPage = 5;
  reportDisplayLimit = this.itemsPerPage;
  claimDisplayLimit = this.itemsPerPage;
  expandedReportId: number | null = null;
  expandedClaimId: number | null = null;

  get filteredReports(): LostFoundReport[] {
    return this.selectedReportFilter === 'all'
      ? this.reports
      : this.reports.filter(report => report.status === this.selectedReportFilter);
  }

  get visibleReports(): LostFoundReport[] {
    return this.filteredReports.slice(0, this.reportDisplayLimit);
  }

  get visibleClaims(): ClaimRequest[] {
    return this.receivedClaims.slice(0, this.claimDisplayLimit);
  }

  setActiveSection(value: 'reports' | 'requests'): void {
    if (value !== 'reports' && value !== 'requests') return;
    this.activeSection = value;
    this.refreshUI();
  }

  setReportFilter(value: string): void {
    if (!this.reportFilterOptions.some(option => option.value === value)) return;
    this.selectedReportFilter = value;
    this.reportDisplayLimit = this.itemsPerPage;
    this.expandedReportId = null;
    this.refreshUI();
  }

  toggleReportDetails(reportId: number): void {
    this.expandedReportId = this.expandedReportId === reportId ? null : reportId;
    this.refreshUI();
  }

  toggleClaimDetails(claimId: number): void {
    this.expandedClaimId = this.expandedClaimId === claimId ? null : claimId;
    this.refreshUI();
  }

  showMoreReports(): void {
    this.reportDisplayLimit = Math.min(
      this.reportDisplayLimit + this.itemsPerPage,
      this.filteredReports.length,
    );
    this.refreshUI();
  }

  showMoreClaims(): void {
    this.claimDisplayLimit = Math.min(
      this.claimDisplayLimit + this.itemsPerPage,
      this.receivedClaims.length,
    );
    this.refreshUI();
  }


  isLoading = true;
  isLoadingClaims = true;

  errorMessage = '';
  claimsErrorMessage = '';

  deletingReportId: number | null = null;
  processingClaimId: number | null = null;
  openingChatClaimId: number | null = null;

  // Hide a completed handover button immediately after the server confirms
  // the action, until the refreshed claim carries the saved confirmation.
  private readonly confirmedReturnRequestIds = new Set<number>();

  highlightedClaimId: number | null = null;

  private targetReportId: number | null = null;
  private targetClaimId: number | null = null;

  private focusTimer?: ReturnType<typeof setTimeout>;
  private clearHighlightTimer?: ReturnType<typeof setTimeout>;

  private queryParamsSubscription?: Subscription;
  private reportsRequestSubscription?: Subscription;
  private claimsRequestSubscription?: Subscription;
  private chatRequestSubscription?: Subscription;
  private isDeleteConfirmationOpen = false;

  private destroyed = false;

  constructor(
    private route: ActivatedRoute,
    private hostElement: ElementRef<HTMLElement>,
    private reportsService: ReportsService,
    private changeDetector: ChangeDetectorRef,
    private router: Router,
    private alertController: AlertController,
    private toastController: ToastController,
    private haptics: HapticsService,
    private chatService: ChatService,
  ) {}

  // ============================================================
  // LIFECYCLE
  // ============================================================

  ngOnInit(): void {
    this.queryParamsSubscription = this.route.queryParamMap.subscribe(
      (params) => {
        const rawClaimId = Number(params.get('claimId'));
        const rawReportId = Number(params.get('reportId'));

        this.targetClaimId =
          Number.isSafeInteger(rawClaimId) && rawClaimId > 0
            ? rawClaimId
            : null;

        this.targetReportId =
          Number.isSafeInteger(rawReportId) && rawReportId > 0
            ? rawReportId
            : null;

        if (this.targetClaimId !== null || this.targetReportId !== null) {
          this.cancelClaimFocusTimers();
          this.highlightedClaimId = null;
          this.activeSection = 'requests';
          this.scheduleClaimFocus();
        }
        // No query parameters: do not clear an already opened notification
        // card immediately. The page-leave hook resets its temporary state.
      },
    );
  }

  ionViewWillEnter(): void {
    // Opening My Reports normally should never replay an old notification.
    // A fresh notification still carries claimId/reportId in the route.
    const hasNotificationTarget =
      this.route.snapshot.queryParamMap.has('claimId') ||
      this.route.snapshot.queryParamMap.has('reportId');

    if (!hasNotificationTarget &&
        this.targetClaimId === null &&
        this.targetReportId === null &&
        this.highlightedClaimId === null) {
      this.activeSection = 'reports';
      this.expandedClaimId = null;
    }

    this.loadMyReports(true);
    this.loadReceivedClaims(true);
  }

  ionViewDidLeave(): void {
    // Ionic caches tab pages. Remove any one-time focus state when leaving,
    // so the next ordinary My Reports tab visit starts on My Items.
    this.cancelClaimFocusTimers();
    this.targetClaimId = null;
    this.targetReportId = null;
    this.highlightedClaimId = null;
    this.expandedClaimId = null;
    this.activeSection = 'reports';
  }

  private cancelClaimFocusTimers(): void {
    if (this.focusTimer) {
      clearTimeout(this.focusTimer);
      this.focusTimer = undefined;
    }
    if (this.clearHighlightTimer) {
      clearTimeout(this.clearHighlightTimer);
      this.clearHighlightTimer = undefined;
    }
  }

  ngOnDestroy(): void {
    this.destroyed = true;

    this.reportsRequestSubscription?.unsubscribe();
    this.claimsRequestSubscription?.unsubscribe();
    this.chatRequestSubscription?.unsubscribe();
    this.queryParamsSubscription?.unsubscribe();

    this.cancelClaimFocusTimers();
  }

  private refreshUI(): void {
    if (!this.destroyed) {
      this.changeDetector.detectChanges();
    }
  }

  // ============================================================
  // LOAD MY REPORTS
  // ============================================================

  loadMyReports(force = false): void {
    if (this.isLoading && !force) {
      return;
    }

    this.reportsRequestSubscription?.unsubscribe();

    this.isLoading = true;
    this.errorMessage = '';
    this.refreshUI();

    this.reportsRequestSubscription = this.reportsService
      .getMyReports()
      .subscribe({
        next: (response) => {
          this.reports = response.reports ?? [];
          this.reportDisplayLimit = this.itemsPerPage;
          this.expandedReportId = null;
          this.isLoading = false;
          this.refreshUI();
        },
        error: (error) => {
          console.error('Load my reports error:', error);

          this.isLoading = false;
          this.errorMessage =
            error?.error?.detail ||
            'Unable to load your reports. Please try again.';

          this.refreshUI();
        },
      });
  }

  // ============================================================
  // LOAD RECEIVED CLAIMS
  // ============================================================

  loadReceivedClaims(force = false, silent = false): void {
    if (this.isLoadingClaims && !force) {
      return;
    }

    this.claimsRequestSubscription?.unsubscribe();

    // Silent updates leave expanded cards and action controls in place.
    // This prevents a completed action from looking like it needs another tap.
    if (!silent) {
      this.isLoadingClaims = true;
      this.claimsErrorMessage = '';
      this.refreshUI();
    }

    this.claimsRequestSubscription = this.reportsService
      .getReceivedClaimRequests()
      .subscribe({
        next: (response) => {
          this.receivedClaims = response.claims ?? [];
          if (!silent) {
            this.claimDisplayLimit = this.itemsPerPage;
          }
          this.isLoadingClaims = false;
          this.claimsErrorMessage = '';

          // Retain temporary confirmed-return guards only while the GET
          // response hasn't yet reflected the owner's confirmation.
          for (const claim of this.receivedClaims) {
            if (claim.owner_return_confirmed_at || claim.report_status === 'returned') {
              this.confirmedReturnRequestIds.delete(claim.id);
            }
          }

          this.refreshUI();
          this.scheduleClaimFocus();
        },
        error: (error) => {
          console.error('Load received claims error:', error);
          this.isLoadingClaims = false;
          if (!silent) {
            this.claimsErrorMessage =
              error?.error?.detail ||
              'Unable to load claim requests. Please try again.';
          }
          // A successful action has already been acknowledged by the server.
          // A failed background refresh must not replace the card with an error.
          this.refreshUI();
        },
      });
  }

  // ============================================================
  // FOCUS REQUEST FROM NOTIFICATION
  // ============================================================

  private scheduleClaimFocus(): void {
    if (
      this.destroyed || this.isLoadingClaims || this.claimsErrorMessage ||
      (this.targetClaimId === null && this.targetReportId === null)
    ) return;

    const index = this.receivedClaims.findIndex(claim =>
      this.targetClaimId !== null
        ? claim.id === this.targetClaimId
        : claim.report_id === this.targetReportId,
    );
    if (index < 0) return;

    const claim = this.receivedClaims[index];
    // The target may otherwise be hidden behind the other tab or Load More.
    this.activeSection = 'requests';
    this.claimDisplayLimit = Math.max(this.claimDisplayLimit, index + 1);
    this.expandedClaimId = claim.id;
    this.highlightedClaimId = claim.id;
    this.refreshUI();

    this.cancelClaimFocusTimers();

    // Consume the notification deep-link after finding its request. Clearing
    // the query parameters with replaceUrl prevents Ionic from reopening the
    // same claim on future normal tab visits or back navigation.
    this.targetClaimId = null;
    this.targetReportId = null;
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { claimId: null, reportId: null },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });

    this.focusTimer = setTimeout(() => {
      if (this.destroyed) return;
      const cards = this.hostElement.nativeElement.querySelectorAll(
        'ion-card.claim-card',
      );
      const card = cards.item(index) as HTMLElement | null;
      if (!card) return;

      card.scrollIntoView({ behavior: 'smooth', block: 'start' });
      this.clearHighlightTimer = setTimeout(() => {
        if (this.destroyed) return;
        this.highlightedClaimId = null;
        this.refreshUI();
      }, 4000);
    }, 180);
  }

  // ============================================================
  // NAVIGATION
  // ============================================================

  goBack(): void {
    void this.router.navigate(['/home']);
  }

  editReport(reportId: number): void {
    void this.router.navigate(['/edit-report', reportId]);
  }

  // ============================================================
  // DELETE REPORT
  // ============================================================

  async confirmDeleteReport(
    reportId: number,
    itemName: string,
  ): Promise<void> {
    if (this.deletingReportId !== null || this.isDeleteConfirmationOpen) {
      return;
    }

    // UI disabled state is not a substitute for validating the action.
    const report = this.reports.find((item) => item.id === reportId);
    if (!report || report.status !== 'active') {
      return;
    }

    this.isDeleteConfirmationOpen = true;
    try {
      const alert = await this.alertController.create({
        header: 'Delete Report?',
        message:
          `Are you sure you want to delete "${itemName}"? ` +
          'This action cannot be undone.',
        buttons: [
          {
            text: 'Cancel',
            role: 'cancel',
          },
          {
            text: 'Delete',
            role: 'destructive',
            handler: () => this.deleteReport(reportId),
          },
        ],
      });

      await alert.present();
      await alert.onDidDismiss();
    } finally {
      this.isDeleteConfirmationOpen = false;
    }
  }

  private deleteReport(reportId: number): void {
    if (this.deletingReportId !== null || this.destroyed) {
      return;
    }

    const report = this.reports.find((item) => item.id === reportId);
    if (!report || report.status !== 'active') {
      return;
    }

    this.deletingReportId = reportId;
    this.refreshUI();

    this.reportsService.deleteReport(reportId).subscribe({
      next: async () => {
        this.reports = this.reports.filter(
          (report) => report.id !== reportId,
        );

        this.deletingReportId = null;
        this.refreshUI();

        await this.haptics.success();

        const alert = await this.alertController.create({
          header: 'Report Deleted',
          message: 'The report was deleted successfully.',
          buttons: ['OK'],
        });

        await alert.present();
      },
      error: async (error) => {
        console.error('Delete report error:', error);

        this.deletingReportId = null;
        this.refreshUI();

        await this.haptics.warning();

        let message =
          'Unable to delete the report. Please try again.';

        if (error.status === 0) {
          message =
            'Cannot connect to the backend. Check your server.';
        } else if (error.status === 401) {
          message =
            'Please log in again before deleting a report.';
        } else if (error.status === 403) {
          message =
            'You are not allowed to delete this report.';
        } else if (error.status === 404) {
          message =
            'Report not found or already deleted.';
        } else if (error.status === 409) {
          message =
            error?.error?.detail ||
            'This report cannot be deleted because it is no ' +
              'longer active or already has claim requests.';
        } else if (error?.error?.detail) {
          message = error.error.detail;
        }

        const alert = await this.alertController.create({
          header: 'Delete Failed',
          message,
          buttons: ['OK'],
        });

        await alert.present();
      },
    });
  }

  // ============================================================
  // CLAIM TYPE HELPERS
  // ============================================================

  getClaimReportType(
    claim: ClaimRequest,
  ): 'lost' | 'found' {
    if (
      claim.report_type === 'lost' ||
      claim.report_type === 'found'
    ) {
      return claim.report_type;
    }

    const report = this.reports.find(
      (item) => item.id === claim.report_id,
    );

    return report?.report_type === 'lost'
      ? 'lost'
      : 'found';
  }

  getClaimRequestLabel(claim: ClaimRequest): string {
    return this.getClaimReportType(claim) === 'lost'
      ? 'Found-Item Response'
      : 'Ownership Claim';
  }

  getApproveActionLabel(_claim: ClaimRequest): string {
    return 'Verify & Approve Claim';
  }

  getRejectActionLabel(_claim: ClaimRequest): string {
    return 'Reject Claim';
  }

  getReportTypeLabel(
    type: 'lost' | 'found',
  ): string {
    return type === 'lost'
      ? 'Lost Item'
      : 'Found Item';
  }

  // ============================================================
  // CLAIM STATUS LABELS
  // ============================================================

  /**
   * Display understandable statuses without changing
   * the existing database status values.
   *
   * Rejected requests are differentiated by closure_reason.
   */
  getClaimStatusLabel(claim: ClaimRequest): string {
    if (claim.status === 'pending') {
      return 'Pending Verification';
    }

    if (claim.status === 'approved') {
      if (claim.report_status === 'returned') {
        return 'Item Returned';
      }

      if (claim.owner_return_confirmed_at) {
        return 'Awaiting Other Party';
      }

      return this.getClaimReportType(claim) === 'found'
        ? 'Approved - Awaiting Handover'
        : 'Item Received - Awaiting Finder';
    }

    switch (claim.closure_reason) {
      case 'verification_failed':
        return 'Rejected - Verification Failed';

      case 'not_a_match':
        return 'Not a Match';

      case 'owner_verified':
        return 'Closed - Owner Verified';

      case 'item_recovered':
        return 'Closed - Item Recovered';

      default:
        return 'Rejected';
    }
  }

  getClaimStatusColor(claim: ClaimRequest): string {
    if (claim.status === 'pending') {
      return 'warning';
    }

    if (claim.status === 'approved') {
      return claim.report_status === 'returned'
        ? 'primary'
        : 'success';
    }

    return 'medium';
  }

  getClaimClosureDescription(
    claim: ClaimRequest,
  ): string {
    if (claim.status !== 'rejected') {
      return '';
    }

    switch (claim.closure_reason) {
      case 'verification_failed':
        return (
          'This ownership claim was reviewed and could ' +
          'not be verified. The request is closed.'
        );

      case 'not_a_match':
        return (
          'After verification, the reported item did not ' +
          'match the missing item. This response is closed.'
        );

      case 'owner_verified':
        return (
          'Another claimant was verified as the item owner. ' +
          'This pending claim was automatically closed.'
        );

      case 'item_recovered':
        return (
          'The lost-item owner confirmed receiving the item ' +
          'from another finder. This response was closed.'
        );

      default:
        return (
          'This request is no longer active. ' +
          'The closure reason was not recorded.'
        );
    }
  }

  // ============================================================
  // PRIVATE CHAT
  // ============================================================

  /**
   * Active claims can open or start a chat.
   * Rejected/returned claims can still access an
   * existing conversation in read-only mode.
   */
  canOpenClaimChat(claim: ClaimRequest): boolean {
    return claim.id > 0;
  }

  openClaimChat(claim: ClaimRequest): void {
    if (
      this.openingChatClaimId !== null ||
      !this.canOpenClaimChat(claim)
    ) {
      return;
    }

    this.chatRequestSubscription?.unsubscribe();

    this.openingChatClaimId = claim.id;
    this.refreshUI();

    this.chatRequestSubscription = this.chatService
      .getConversationForClaim(claim.id)
      .pipe(
        switchMap((response) => {
          if (response.conversation) {
            return of(response);
          }

          // Closed requests may open existing conversations
          // but must never start new conversations.
          if (
            claim.status === 'rejected' ||
            (
              claim.report_status !== 'active' &&
              claim.report_status !== 'claimed'
            )
          ) {
            return of({ conversation: null });
          }

          return this.chatService.startConversation(claim.id);
        }),
      )
      .subscribe({
        next: async ({ conversation }) => {
          this.openingChatClaimId = null;
          this.refreshUI();

          if (conversation) {
            void this.router.navigate(
              ['/chat', conversation.id],
              { queryParams: { from: 'my-reports', claimId: claim.id } },
            );
            return;
          }

          const toast = await this.toastController.create({
            message:
              'No earlier conversation was found. ' +
              'New chats cannot be started for a closed request.',
            duration: 3500,
            color: 'medium',
          });

          await toast.present();
        },
        error: async (error) => {
          console.error('Open claim chat error:', error);

          this.openingChatClaimId = null;
          this.refreshUI();

          await this.haptics.warning();

          const toast = await this.toastController.create({
            message:
              error?.error?.detail ||
              error?.message ||
              'Unable to open the chat. Please try again.',
            duration: 3500,
            color: 'danger',
          });

          await toast.present();
        },
      });
  }

  // ============================================================
  // FOUND REPORT - APPROVE / REJECT
  // ============================================================

  showDecisionActions(claim: ClaimRequest): boolean {
    return (
      this.getClaimReportType(claim) === 'found' &&
      claim.status === 'pending' &&
      claim.report_status === 'active'
    );
  }

  async decideClaim(
    claim: ClaimRequest,
    action: 'approve' | 'reject',
  ): Promise<void> {
    if (
      this.processingClaimId !== null ||
      claim.status !== 'pending' ||
      claim.report_status !== 'active' ||
      this.getClaimReportType(claim) !== 'found'
    ) {
      return;
    }

    const isApprove = action === 'approve';

    const itemName =
      claim.item_name ||
      `Report #${claim.report_id}`;

    const header = isApprove
      ? 'Verify & Approve Claim?'
      : 'Reject Ownership Claim?';

    const explanation = isApprove
      ? (
          'After checking the private chat and ownership ' +
          `evidence, are you satisfied that this person owns "${itemName}"?`
        )
      : (
          'Have you verified that this person cannot provide ' +
          `sufficient proof of ownership for "${itemName}"?`
        );

    const consequence = isApprove
      ? (
          ' Approving this claim will select this person ' +
          'and automatically close other pending claims. ' +
          'You can then coordinate the physical handover.'
        )
      : (
          ' This claim will be marked as Rejected - ' +
          'Verification Failed. The claimant will be notified.'
        );

    const alert = await this.alertController.create({
      header,
      message: explanation + consequence,
      buttons: [
        {
          text: 'Cancel',
          role: 'cancel',
        },
        {
          text: isApprove
            ? 'Approve Claim'
            : 'Reject Claim',
          role: isApprove ? 'confirm' : 'destructive',
          handler: () => {
            this.processClaim(claim.id, action);
          },
        },
      ],
    });

    await alert.present();
  }

  private processClaim(
    claimId: number,
    action: 'approve' | 'reject',
  ): void {
    if (this.processingClaimId !== null) {
      return;
    }

    const claim = this.receivedClaims.find(
      (item) => item.id === claimId,
    );

    if (
      !claim ||
      claim.status !== 'pending' ||
      claim.report_status !== 'active' ||
      this.getClaimReportType(claim) !== 'found'
    ) {
      return;
    }

    this.processingClaimId = claimId;
    this.refreshUI();

    this.reportsService
      .decideClaimRequest(claimId, action)
      .subscribe({
        next: async () => {
          // Only change the UI after the server confirms success.
          // Keep all other claims server-authoritative; the background GET
          // will pick up competing claims closed by an approval.
          this.receivedClaims = this.receivedClaims.map((item) =>
            item.id === claimId
              ? {
                  ...item,
                  status: (action === 'approve' ? 'approved' : 'rejected') as ClaimRequest['status'],
                  report_status: (action === 'approve' ? 'claimed' : item.report_status) as ClaimRequest['report_status'],
                  ...(action === 'reject'
                    ? { closure_reason: 'verification_failed' as const }
                    : {}),
                }
              : item,
          );
          this.processingClaimId = null;
          this.refreshUI();

          this.loadMyReports(true);
          this.loadReceivedClaims(true, true);

          await this.haptics.success();

          const toast = await this.toastController.create({
            message:
              action === 'approve'
                ? (
                    'Ownership claim verified and approved. ' +
                    'Other pending claims have been closed.'
                  )
                : (
                    'Ownership claim rejected after verification.'
                  ),
            duration: 3000,
            color: 'success',
          });

          await toast.present();
        },
        error: async (error) => {
          console.error('Process claim error:', error);

          this.processingClaimId = null;
          this.refreshUI();

          await this.haptics.warning();

          const toast = await this.toastController.create({
            message:
              error?.error?.detail ||
              'Unable to process this claim. Refresh and try again.',
            duration: 3500,
            color: 'danger',
          });

          await toast.present();
        },
      });
  }

  // ============================================================
  // LOST REPORT - NOT A MATCH
  // ============================================================

  /**
   * Not a Match is available only on a pending finder
   * response belonging to an active Lost Report.
   *
   * The backend updates only the selected response.
   */
  showNotAMatchAction(claim: ClaimRequest): boolean {
    return (
      this.getClaimReportType(claim) === 'lost' &&
      claim.status === 'pending' &&
      claim.report_status === 'active'
    );
  }

  canMarkNotAMatch(claim: ClaimRequest): boolean {
    return (
      this.processingClaimId === null &&
      this.showNotAMatchAction(claim)
    );
  }

  async confirmNotAMatch(
    claim: ClaimRequest,
  ): Promise<void> {
    if (!this.canMarkNotAMatch(claim)) {
      return;
    }

    const itemName =
      claim.item_name ||
      `Report #${claim.report_id}`;

    const alert = await this.alertController.create({
      header: 'Mark as Not a Match?',
      message:
        `Have you verified that the item this person found ` +
        `is NOT your lost item "${itemName}"? ` +
        'This will close only this finder response. ' +
        'The person will be notified and the private chat ' +
        'will become read-only. ' +
        'Your Lost Report and other pending responses ' +
        'will remain active.',
      buttons: [
        {
          text: 'Cancel',
          role: 'cancel',
        },
        {
          text: 'Not a Match',
          role: 'destructive',
          handler: () => {
            this.processNotAMatch(claim.id);
          },
        },
      ],
    });

    await alert.present();
  }

  private processNotAMatch(claimId: number): void {
    if (this.processingClaimId !== null) {
      return;
    }

    const claim = this.receivedClaims.find(
      (item) => item.id === claimId,
    );

    if (!claim || !this.showNotAMatchAction(claim)) {
      return;
    }

    this.processingClaimId = claimId;
    this.refreshUI();

    this.reportsService
      .markFinderResponseNotAMatch(claimId)
      .subscribe({
        next: async () => {
          // Immediately close the confirmed response in the visible list.
          this.receivedClaims = this.receivedClaims.map((item) =>
            item.id === claimId
              ? { ...item, status: 'rejected' as const, closure_reason: 'not_a_match' as const }
              : item,
          );
          this.processingClaimId = null;
          this.refreshUI();

          this.loadReceivedClaims(true, true);
          this.loadMyReports(true);

          await this.haptics.success();

          const toast = await this.toastController.create({
            message:
              'Response marked as Not a Match. ' +
              'Your Lost Report remains active.',
            duration: 3500,
            color: 'success',
          });

          await toast.present();
        },
        error: async (error) => {
          console.error('Not a Match error:', error);

          this.processingClaimId = null;

          this.loadReceivedClaims(true);
          this.refreshUI();

          await this.haptics.warning();

          const toast = await this.toastController.create({
            message:
              error?.error?.detail ||
              'Unable to mark this response as Not a Match. ' +
              'Please try again.',
            duration: 3500,
            color: 'danger',
          });

          await toast.present();
        },
      });
  }

  // ============================================================
  // PHYSICAL HANDOVER
  // ============================================================

  /**
   * LOST:
   * The owner confirms physical receipt on a pending response.
   * The backend selects that finder and closes competing
   * pending responses.
   *
   * FOUND:
   * The owner of the Found Report confirms physical
   * handover only after approving the actual owner.
   */
  canConfirmReturn(claim: ClaimRequest): boolean {
    if (
      this.processingClaimId !== null ||
      claim.owner_return_confirmed_at ||
      this.confirmedReturnRequestIds.has(claim.id)
    ) {
      return false;
    }

    if (this.getClaimReportType(claim) === 'lost') {
      return (
        (
          claim.status === 'pending' &&
          claim.report_status === 'active'
        ) ||
        (
          claim.status === 'approved' &&
          claim.report_status === 'claimed'
        )
      );
    }

    return (
      claim.status === 'approved' &&
      claim.report_status === 'claimed'
    );
  }

  showHandoverSection(claim: ClaimRequest): boolean {
    if (this.getClaimReportType(claim) === 'lost') {
      return (
        (
          claim.status === 'pending' &&
          claim.report_status === 'active'
        ) ||
        (
          claim.status === 'approved' &&
          (
            claim.report_status === 'claimed' ||
            claim.report_status === 'returned'
          )
        )
      );
    }

    return (
      claim.status === 'approved' &&
      (
        claim.report_status === 'claimed' ||
        claim.report_status === 'returned'
      )
    );
  }

  getReturnProgress(claim: ClaimRequest): string {
    if (claim.report_status === 'returned') {
      return (
        'Both parties confirmed. Item marked as returned.'
      );
    }

    if (
      this.getClaimReportType(claim) === 'lost' &&
      claim.status === 'pending' &&
      claim.report_status === 'active'
    ) {
      return (
        'Use private chat to verify the item and coordinate ' +
        'the return. Confirm Item Received only after you ' +
        'have physically received your lost item.'
      );
    }

    if (claim.status !== 'approved') {
      return 'Return confirmation is not available yet.';
    }

    if (
      claim.owner_return_confirmed_at &&
      claim.requester_return_confirmed_at
    ) {
      return 'Both parties have confirmed the handover.';
    }

    if (claim.owner_return_confirmed_at) {
      return (
        this.getClaimReportType(claim) === 'lost'
          ? (
              'You confirmed receiving the item. ' +
              'Waiting for the finder to confirm handover.'
            )
          : (
              'You confirmed handing over the item. ' +
              'Waiting for the approved owner to confirm receipt.'
            )
      );
    }

    if (claim.requester_return_confirmed_at) {
      return (
        'The requester confirmed the handover. ' +
        'Your confirmation is still needed.'
      );
    }

    return (
      'Waiting for both parties to confirm ' +
      'the physical handover.'
    );
  }

  async confirmReturned(
    claim: ClaimRequest,
  ): Promise<void> {
    if (!this.canConfirmReturn(claim)) {
      return;
    }

    const isLost =
      this.getClaimReportType(claim) === 'lost';

    const alert = await this.alertController.create({
      header: isLost
        ? 'Confirm Item Received?'
        : 'Confirm Item Handed Over?',
      message: isLost
        ? (
            `Have you physically received "${claim.item_name}" ` +
            'from this finder? This will close other pending ' +
            'finder responses. The item will be marked as ' +
            'returned only after this finder also confirms.'
          )
        : (
            `Have you physically handed "${claim.item_name}" ` +
            'to the approved owner? The item will be marked ' +
            'as returned only after both parties confirm.'
          ),
      buttons: [
        {
          text: 'Cancel',
          role: 'cancel',
        },
        {
          text: 'Confirm',
          role: 'confirm',
          handler: () => {
            this.processReturn(claim.id);
          },
        },
      ],
    });

    await alert.present();
  }

  private processReturn(claimId: number): void {
    if (this.processingClaimId !== null) {
      return;
    }

    this.processingClaimId = claimId;
    this.refreshUI();

    this.reportsService
      .confirmItemReturned(claimId)
      .subscribe({
        next: async (response) => {
          // The confirmation was accepted by the server. Block another tap
          // until the refreshed claim contains the authoritative timestamp.
          this.confirmedReturnRequestIds.add(claimId);
          this.processingClaimId = null;
          this.refreshUI();

          this.loadMyReports(true);
          this.loadReceivedClaims(true, true);

          await this.haptics.success();

          const toast = await this.toastController.create({
            message:
              response.status === 'returned'
                ? (
                    'Both parties confirmed. ' +
                    'Item marked as returned.'
                  )
                : (
                    'Your confirmation was saved. ' +
                    'Waiting for the other party.'
                  ),
            duration: 3500,
            color: 'success',
          });

          await toast.present();
        },
        error: async (error) => {
          console.error('Confirm return error:', error);

          this.processingClaimId = null;

          this.loadReceivedClaims(true);
          this.refreshUI();

          await this.haptics.warning();

          const toast = await this.toastController.create({
            message:
              error?.error?.detail ||
              'Unable to confirm the handover. ' +
              'Refresh and try again.',
            duration: 3500,
            color: 'danger',
          });

          await toast.present();
        },
      });
  }

  // ============================================================
  // TRACK BY HELPERS
  // ============================================================

  trackByReportId(
    _index: number,
    report: LostFoundReport,
  ): number {
    return report.id;
  }

  trackByClaimId(
    _index: number,
    claim: ClaimRequest,
  ): number {
    return claim.id;
  }
}