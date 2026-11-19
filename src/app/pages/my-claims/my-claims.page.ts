
import { CommonModule } from '@angular/common';

import {
  ChangeDetectorRef,
  Component,
  OnDestroy,
} from '@angular/core';

import { Router } from '@angular/router';

import {
  Subscription,
  switchMap,
  of,
} from 'rxjs';

import {
  IonBadge,
  IonButton,
  IonCard,
  IonCardContent,
  IonCardHeader,
  IonCardSubtitle,
  IonCardTitle,
  IonContent,
  IonHeader,
  IonIcon,
  IonSegment,
  IonSegmentButton,
  IonLabel,
  IonSpinner,
  IonToolbar,
} from '@ionic/angular';

import {
  ClaimRequest,
  ReportsService,
} from '../../services/reports';

import {
  ChatConversation,
  ChatService,
} from '../../services/chat';

import { addIcons } from 'ionicons';

import {
  arrowBackOutline,
  refreshOutline,
  chatbubbleOutline,
  documentTextOutline,
  chevronDownOutline,
  chevronUpOutline,
} from 'ionicons/icons';

/* ============================================================
   REGISTER ICONS
   ============================================================ */

addIcons({
  arrowBackOutline,
  refreshOutline,
  chatbubbleOutline,
  documentTextOutline,
  chevronDownOutline,
  chevronUpOutline,
});

/* ============================================================
   TYPES
   ============================================================ */

type ClaimFilter =
  | 'all'
  | 'pending'
  | 'approved'
  | 'rejected';

/* ============================================================
   COMPONENT
   ============================================================ */

@Component({
  selector: 'app-my-claims',
  standalone: true,
  templateUrl: './my-claims.page.html',
  styleUrls: ['./my-claims.page.scss'],

  imports: [
    CommonModule,
    IonBadge,
    IonButton,
    IonCard,
    IonCardContent,
    IonCardHeader,
    IonCardSubtitle,
    IonCardTitle,
    IonContent,
    IonHeader,
    IonIcon,
    IonSegment,
    IonSegmentButton,
    IonLabel,
    IonSpinner,
    IonToolbar,
  ],
})

export class MyClaimsPage implements OnDestroy {

  /* ============================================================
     CLAIM DATA
     ============================================================ */

  claims: ClaimRequest[] = [];

  selectedFilter: ClaimFilter = 'all';

  isLoading = false;

  errorMessage = '';

  /* ============================================================
     EXPAND / COLLAPSE STATE
     ============================================================ */

  /**
   * Stores the ID of the currently expanded claim.
   *
   * null = all cards collapsed.
   *
   * Only one claim can be expanded at a time.
   */
  expandedClaimId: number | null = null;

  /**
   * Expand a claim card or collapse it when selected again.
   */
  toggleClaimDetails(claimId: number): void {
    if (
      !Number.isSafeInteger(claimId) ||
      claimId <= 0
    ) {
      return;
    }

    this.expandedClaimId =
      this.expandedClaimId === claimId
        ? null
        : claimId;

    this.refreshUI();
  }

  /**
   * Determines whether a particular claim is expanded.
   */
  isClaimExpanded(claimId: number): boolean {
    return this.expandedClaimId === claimId;
  }

  /* ============================================================
     PRIVATE CHAT STATE
     ============================================================ */

  openingChatClaimId: number | null = null;

  chatNoticeClaimId: number | null = null;

  chatNoticeMessage = '';

  /* ============================================================
     SUBSCRIPTIONS
     ============================================================ */

  private claimsSubscription?: Subscription;

  private chatSubscription?: Subscription;

  private destroyed = false;

  /* ============================================================
     CONSTRUCTOR
     ============================================================ */

  constructor(
    private reportsService: ReportsService,
    private chatService: ChatService,
    private router: Router,
    private cdr: ChangeDetectorRef,
  ) {}

  /* ============================================================
     LIFECYCLE
     ============================================================ */

  ionViewWillEnter(): void {
    this.loadClaims();
  }

  ngOnDestroy(): void {
    this.destroyed = true;

    this.claimsSubscription?.unsubscribe();
    this.chatSubscription?.unsubscribe();
  }

  /**
   * Refresh the component's UI safely.
   */
  private refreshUI(): void {
    if (!this.destroyed) {
      this.cdr.detectChanges();
    }
  }

  /* ============================================================
     LOAD SUBMITTED CLAIMS
     ============================================================ */

  loadClaims(): void {
    if (this.destroyed) {
      return;
    }

    this.claimsSubscription?.unsubscribe();

    this.isLoading = true;
    this.errorMessage = '';

    this.chatNoticeClaimId = null;
    this.chatNoticeMessage = '';

    this.refreshUI();

    this.claimsSubscription = this.reportsService
      .getMyClaimRequests()
      .subscribe({

        next: (response) => {
          if (this.destroyed) {
            return;
          }

          this.claims = response.claims ?? [];

          /*
           * If an expanded claim no longer exists
           * after refreshing, collapse the details.
           */
          if (
            this.expandedClaimId !== null &&
            !this.claims.some(
              (claim) =>
                claim.id === this.expandedClaimId
            )
          ) {
            this.expandedClaimId = null;
          }

          this.isLoading = false;

          this.refreshUI();
        },

        error: (error) => {
          if (this.destroyed) {
            return;
          }

          console.error(
            'Load my claims error:',
            error,
          );

          this.isLoading = false;

          this.errorMessage =
            typeof error?.error?.detail === 'string'
              ? error.error.detail
              : 'Unable to load your claims. Please try again.';

          this.refreshUI();
        },

      });
  }

  /* ============================================================
     STATUS FILTERS
     ============================================================ */

  setFilter(
    value: string | number | undefined | null,
  ): void {

    if (
      value === 'all' ||
      value === 'pending' ||
      value === 'approved' ||
      value === 'rejected'
    ) {

      /*
       * Collapse the previous card when switching
       * to another status filter.
       */
      if (this.selectedFilter !== value) {
        this.expandedClaimId = null;
      }

      this.selectedFilter = value;

      this.refreshUI();
    }
  }

  /**
   * Returns claims matching the selected filter.
   */
  get filteredClaims(): ClaimRequest[] {

    return this.selectedFilter === 'all'
      ? this.claims
      : this.claims.filter(
          (claim) =>
            claim.status === this.selectedFilter,
        );
  }

  /**
   * Count claims by status.
   */
  countByStatus(status: ClaimFilter): number {

    return status === 'all'
      ? this.claims.length
      : this.claims.filter(
          (claim) => claim.status === status,
        ).length;
  }

  /* ============================================================
     CLAIM TYPE LABEL
     ============================================================ */

  getClaimTypeLabel(
    claim: ClaimRequest,
  ): string {

    return (
      claim.report_type === 'lost' ||
      claim.request_kind === 'found_item_response'
    )
      ? 'Found-Item Response'
      : 'Ownership Claim';
  }

  /* ============================================================
     CLAIM STATUS LABELS
     ============================================================ */

  /**
   * Display user-friendly status labels while preserving
   * the database values:
   *
   * pending
   * approved
   * rejected
   */
  getClaimStatusLabel(
    claim: ClaimRequest,
  ): string {

    if (claim.status === 'pending') {
      return 'Pending Verification';
    }

    if (claim.status === 'approved') {

      if (claim.report_status === 'returned') {
        return 'Item Returned';
      }

      if (
        claim.owner_return_confirmed_at &&
        !claim.requester_return_confirmed_at
      ) {
        return 'Your Confirmation Needed';
      }

      if (claim.requester_return_confirmed_at) {
        return 'Awaiting Report Owner';
      }

      return claim.report_type === 'lost'
        ? 'Selected Finder'
        : 'Ownership Claim Approved';
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

  /* ============================================================
     CLAIM STATUS COLORS
     ============================================================ */

  getClaimStatusColor(
    claim: ClaimRequest,
  ): string {

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

  /* ============================================================
     CLAIM CLOSURE DESCRIPTION
     ============================================================ */

  /**
   * Explain why a submitted claim or finder response
   * was closed without implying that all rejected
   * claims were intentionally fraudulent.
   */
  getClaimClosureDescription(
    claim: ClaimRequest,
  ): string {

    if (claim.status !== 'rejected') {
      return '';
    }

    switch (claim.closure_reason) {

      case 'verification_failed':
        return (
          'The finder reviewed your ownership claim ' +
          'and could not verify that the item belongs to you.'
        );

      case 'not_a_match':
        return (
          'The Lost Report owner checked your response ' +
          'and determined that your item does not match ' +
          'their missing item. Thank you for helping.'
        );

      case 'owner_verified':
        return (
          'The found item has been matched with ' +
          'another verified owner. Your pending claim ' +
          'was automatically closed.'
        );

      case 'item_recovered':
        return (
          'The Lost Report owner confirmed receiving ' +
          'their item from another finder. Your response ' +
          'was automatically closed. Thank you for helping.'
        );

      default:
        return (
          'This request is closed. The specific ' +
          'closure reason is not available.'
        );
    }
  }

  /* ============================================================
     ITEM HANDOVER PROGRESS
     ============================================================ */

  getReturnProgress(
    claim: ClaimRequest,
  ): string {

    if (claim.status !== 'approved') {
      return '';
    }

    if (claim.report_status === 'returned') {
      return 'Item returned — both parties confirmed.';
    }

    if (claim.report_status !== 'claimed') {

      return (
        'This request has been selected. ' +
        'Open the report details for the latest status.'
      );
    }

    if (
      claim.owner_return_confirmed_at &&
      claim.requester_return_confirmed_at
    ) {

      return (
        'Both confirmations recorded. ' +
        'Awaiting status refresh.'
      );
    }

    if (claim.requester_return_confirmed_at) {

      return (
        'You confirmed the handover. ' +
        'Waiting for the report owner.'
      );
    }

    if (claim.owner_return_confirmed_at) {

      return claim.report_type === 'lost'
        ? (
            'The lost-item owner confirmed receiving ' +
            'the item. Please confirm that you handed ' +
            'over the item.'
          )
        : (
            'The finder confirmed handing over the item. ' +
            'Please confirm that you received it.'
          );
    }

    return (
      'Awaiting physical return and ' +
      'confirmation from both parties.'
    );
  }

  /* ============================================================
     PRIVATE CHAT PERMISSIONS
     ============================================================ */

  /**
   * A new chat can be started only while the claim
   * and report are active.
   *
   * Existing chat history may remain accessible
   * after rejection or item return.
   */
  canStartClaimChat(
    claim: ClaimRequest,
  ): boolean {

    return (
      (
        claim.status === 'pending' ||
        claim.status === 'approved'
      ) &&
      (
        claim.report_status === 'active' ||
        claim.report_status === 'claimed'
      )
    );
  }

  /**
   * Existing conversations can be opened for
   * historical claims.
   *
   * Backend validation still determines whether
   * the conversation can actually be accessed.
   */
  canOpenClaimChat(
    claim: ClaimRequest,
  ): boolean {

    return claim.id > 0;
  }

  /* ============================================================
     OPEN OR START PRIVATE CHAT
     ============================================================ */

  openClaimChat(
    claim: ClaimRequest,
  ): void {

    if (
      this.destroyed ||
      this.openingChatClaimId !== null ||
      !this.canOpenClaimChat(claim)
    ) {
      return;
    }

    this.chatSubscription?.unsubscribe();

    this.openingChatClaimId = claim.id;

    this.chatNoticeClaimId = null;
    this.chatNoticeMessage = '';

    this.refreshUI();

    this.chatSubscription = this.chatService
      .getConversationForClaim(claim.id)
      .pipe(

        switchMap(({ conversation }) => {

          /*
           * Open an existing conversation.
           */
          if (conversation) {
            return of(conversation);
          }

          /*
           * If the request is already closed,
           * do not create a new chat.
           */
          if (!this.canStartClaimChat(claim)) {
            return of(null);
          }

          /*
           * Start a conversation for an active claim.
           */
          return this.chatService
            .startConversation(claim.id)
            .pipe(
              switchMap((response) =>
                of(response.conversation),
              ),
            );
        }),

      )
      .subscribe({

        next: (
          conversation: ChatConversation | null,
        ) => {

          if (this.destroyed) {
            return;
          }

          this.openingChatClaimId = null;

          if (conversation) {

            void this.router.navigate([
              '/chat',
              conversation.id,
            ]);

          } else {

            this.chatNoticeClaimId = claim.id;

            this.chatNoticeMessage =
              'No earlier conversation was found. ' +
              'New chats cannot be started for a closed request.';
          }

          this.refreshUI();
        },

        error: (error) => {

          if (this.destroyed) {
            return;
          }

          console.error(
            'Open/start claim chat error:',
            error,
          );

          this.openingChatClaimId = null;
          this.chatNoticeClaimId = claim.id;

          this.chatNoticeMessage =
            typeof error?.error?.detail === 'string'
              ? error.error.detail
              : error?.status === 0
                ? 'Cannot reach the backend. Check your connection.'
                : 'Unable to open or start the chat. Please try again.';

          this.refreshUI();
        },

      });
  }

  /* ============================================================
     VIEW REPORT DETAILS
     ============================================================ */

  viewReport(reportId: number): void {

    if (
      !Number.isSafeInteger(reportId) ||
      reportId <= 0
    ) {
      return;
    }

    void this.router.navigate([
      '/report-details',
      reportId,
    ]);
  }

  /* ============================================================
     BACK TO HOME
     ============================================================ */

  goBack(): void {

    void this.router.navigate([
      '/home',
    ]);
  }

  /* ============================================================
     TRACK CLAIM ID
     ============================================================ */

  /**
   * Helps Angular track individual cards efficiently
   * when the list is filtered or refreshed.
   */
  trackByClaimId(
    _index: number,
    claim: ClaimRequest,
  ): number {

    return claim.id;
  }
}
