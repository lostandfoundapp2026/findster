import { CommonModule } from '@angular/common';
import {
  ChangeDetectorRef,
  Component,
  OnDestroy,
  OnInit,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';

import {
  AlertController,
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonItem,
  IonLabel,
  IonList,
  IonRefresher,
  IonRefresherContent,
  IonSpinner,
  IonTitle,
  IonToolbar,
  RefresherCustomEvent,
} from '@ionic/angular';

import { addIcons } from 'ionicons';
import {
  notificationsOutline,
  chatbubblesOutline,
  checkmarkCircleOutline,
  closeCircleOutline,
  handLeftOutline,
  checkmarkDoneOutline,
  peopleOutline,
  arrowBackOutline,
  alertCircleOutline,
  chevronForwardOutline,
} from 'ionicons/icons';

import {
  Subscription,
  finalize,
  timeout,
} from 'rxjs';

import {
  AppNotification,
  NotificationsService,
} from '../../services/notifications';

import { HapticsService } from '../../services/haptics';
import { ChatService } from '../../services/chat';

@Component({
  selector: 'app-notifications',
  templateUrl: './notifications.page.html',
  styleUrls: ['./notifications.page.scss'],
  standalone: true,
  imports: [
    CommonModule,
    RouterLink,
    IonButton,
    IonButtons,
    IonContent,
    IonHeader,
    IonIcon,
    IonItem,
    IonLabel,
    IonList,
    IonRefresher,
    IonRefresherContent,
    IonSpinner,
    IonTitle,
    IonToolbar,
  ],
})
export class NotificationsPage implements OnInit, OnDestroy {

  // ==========================================
  // NOTIFICATION STATE
  // ==========================================

  notifications: AppNotification[] = [];

  isLoading = false;
  isRefreshing = false;
  isMarkingAllRead = false;

  errorMessage = '';

  // ==========================================
  // INTERNAL STATE
  // ==========================================

  private hasLoaded = false;
  private readonly markingReadIds = new Set<number>();
  private readonly locallyReadIds = new Set<number>();
  private readonly requestTimeoutMs = 15000;
  private destroyed = false;

  private openingChatClaimId: number | null = null;

  private notificationsRequest?: Subscription;
  private markAllReadRequest?: Subscription;
  private chatNavigationRequest?: Subscription;

  private readonly activeRequests =
    new Subscription();

  // ==========================================
  // CONSTRUCTOR
  // ==========================================

  constructor(
    private notificationsService: NotificationsService,
    private alertController: AlertController,
    private router: Router,
    private haptics: HapticsService,
    private cdr: ChangeDetectorRef,
    private chatService: ChatService,
  ) {
    // Register all icons used in this page.
    addIcons({
      notificationsOutline,
      chatbubblesOutline,
      checkmarkCircleOutline,
      closeCircleOutline,
      handLeftOutline,
      checkmarkDoneOutline,
      peopleOutline,
      arrowBackOutline,
      alertCircleOutline,
      chevronForwardOutline,
    });
  }

  // ==========================================
  // LIFECYCLE
  // ==========================================

  ngOnInit(): void {
    this.loadNotifications();
  }

  ionViewWillEnter(): void {
    if (this.hasLoaded) {
      this.loadNotifications();
    }
  }

  ngOnDestroy(): void {
    this.destroyed = true;

    this.notificationsRequest?.unsubscribe();
    this.markAllReadRequest?.unsubscribe();
    this.chatNavigationRequest?.unsubscribe();

    this.activeRequests.unsubscribe();
    this.markingReadIds.clear();
    this.locallyReadIds.clear();
  }

  // ==========================================
  // UI REFRESH
  // ==========================================

  private refreshUI(): void {
    if (!this.destroyed) {
      this.cdr.detectChanges();
    }
  }

  // ==========================================
  // LOAD NOTIFICATIONS
  // ==========================================

  loadNotifications(): void {
    this.fetchNotifications(false);
  }

  // Keep a single inbox request active at a time. A pull gesture while
  // loading completes immediately rather than cancelling the request.
  async refresh(event: RefresherCustomEvent): Promise<void> {
    void this.haptics.lightImpact();
    if (this.destroyed || this.isLoading || this.isRefreshing) {
      await event.target.complete();
      return;
    }
    this.fetchNotifications(true, event);
  }

  private fetchNotifications(
    fromPull: boolean,
    event?: RefresherCustomEvent,
  ): void {
    if (this.destroyed || this.isLoading || this.isRefreshing) {
      void event?.target.complete();
      return;
    }

    if (fromPull) this.isRefreshing = true;
    else this.isLoading = true;
    this.errorMessage = '';
    this.refreshUI();

    this.notificationsRequest = this.notificationsService
      .getNotifications()
      .pipe(
        timeout(this.requestTimeoutMs),
        finalize(() => {
          this.isLoading = false;
          this.isRefreshing = false;
          void event?.target.complete();
          this.refreshUI();
        }),
      )
      .subscribe({
        next: (response) => {
          if (this.destroyed) return;
          const items = Array.isArray(response?.notifications)
            ? response.notifications
            : [];
          // A slow fetch must not turn notifications back to unread after
          // a successful mark-read action in the current page session.
          this.notifications = items.map((item) =>
            this.locallyReadIds.has(item.id)
              ? { ...item, is_read: true }
              : item,
          );
          this.hasLoaded = true;
          this.errorMessage = '';
          this.syncUnreadCount();
          this.refreshUI();
        },
        error: (error: unknown) => {
          if (this.destroyed) return;
          this.errorMessage =
            (error as { name?: string })?.name === 'TimeoutError'
              ? 'Loading notifications took too long. Please try again.'
              : 'Unable to load notifications. Please try again.';
          void this.haptics.warning();
          // Keep the inline retry state instead of displaying two errors.
          this.refreshUI();
        },
      });
  }

  // ==========================================
  // MARK NOTIFICATION AS READ
  // ==========================================

  async markAsRead(notification: AppNotification): Promise<void> {
    if (
      this.destroyed ||
      this.openingChatClaimId !== null ||
      this.markingReadIds.has(notification.id)
    ) return;

    void this.haptics.lightImpact();
    if (notification.is_read) {
      this.openRelatedReport(notification);
      return;
    }

    const id = notification.id;
    this.markingReadIds.add(id);
    const request = this.notificationsService.markAsRead(id)
      .pipe(
        timeout(this.requestTimeoutMs),
        finalize(() => {
          this.markingReadIds.delete(id);
          this.refreshUI();
        }),
      )
      .subscribe({
        next: () => {
          if (this.destroyed) return;
          this.locallyReadIds.add(id);
          notification.is_read = true;
          this.notifications = this.notifications.map((item) =>
            item.id === id ? { ...item, is_read: true } : item,
          );
          this.syncUnreadCount();
          this.refreshUI();
          void this.haptics.success();
          this.openRelatedReport(notification);
        },
        error: () => {
          if (this.destroyed) return;
          void this.haptics.warning();
          void this.showAlert('Error', 'Could not mark this notification as read.');
        },
      });
    this.activeRequests.add(request);
  }

  // ==========================================
  // MARK ALL NOTIFICATIONS AS READ
  // ==========================================

  async markAllAsRead(): Promise<void> {
    if (
      this.destroyed || this.isMarkingAllRead || this.isLoading ||
      !this.notifications.some((item) => !item.is_read)
    ) return;

    this.isMarkingAllRead = true;
    this.refreshUI();
    void this.haptics.lightImpact();
    this.markAllReadRequest = this.notificationsService.markAllAsRead()
      .pipe(
        timeout(this.requestTimeoutMs),
        finalize(() => {
          this.isMarkingAllRead = false;
          this.refreshUI();
        }),
      )
      .subscribe({
        next: () => {
          if (this.destroyed) return;
          for (const item of this.notifications) {
            this.locallyReadIds.add(item.id);
          }
          this.notifications = this.notifications.map((item) => ({
            ...item,
            is_read: true,
          }));
          this.syncUnreadCount();
          this.refreshUI();
          void this.haptics.success();
        },
        error: () => {
          if (this.destroyed) return;
          void this.haptics.warning();
          void this.showAlert('Error', 'Could not mark all notifications as read.');
        },
      });
  }

  // ==========================================
  // UNREAD COUNT
  // ==========================================

  get unreadCount(): number {
    return this.notifications.filter(
      (notification) => !notification.is_read,
    ).length;
  }

  private syncUnreadCount(): void {
    this.notificationsService.setUnreadCount(
      this.unreadCount,
    );
  }

  // ==========================================
  // NOTIFICATION ICONS
  // ==========================================

  getNotificationIcon(
    type: string,
  ): string {
    switch (type) {
      case 'new_claim':
        return 'hand-left-outline';

      case 'new_chat_message':
        return 'chatbubbles-outline';

      case 'claim_approved':
        return 'checkmark-circle-outline';

      case 'claim_rejected':
        return 'close-circle-outline';

      case 'return_confirmation_needed':
        return 'people-outline';

      case 'item_returned':
        return 'checkmark-done-outline';

      default:
        return 'notifications-outline';
    }
  }

  // ==========================================
  // NOTIFICATION TYPE LABELS
  // ==========================================

  getNotificationLabel(
    type: string,
  ): string {
    switch (type) {
      case 'new_claim':
        return 'New Request';

      case 'new_chat_message':
        return 'New Chat Message';

      case 'claim_approved':
        return 'Claim Approved';

      case 'claim_rejected':
        return 'Claim Rejected';

      case 'return_confirmation_needed':
        return 'Handover Confirmation Needed';

      case 'item_returned':
        return 'Item Returned';

      default:
        return 'Notification';
    }
  }

  // ==========================================
  // DATE FORMAT
  // ==========================================

  formatDate(
    date: string | null,
  ): string {
    if (!date) {
      return '';
    }

    const parsedDate = new Date(date);

    if (
      Number.isNaN(
        parsedDate.getTime(),
      )
    ) {
      return '';
    }

    return parsedDate.toLocaleString();
  }

  // ==========================================
  // OPEN RELATED NOTIFICATION
  // ==========================================

  openRelatedReport(
    notification: AppNotification,
  ): void {
    const reportId =
      notification.related_report_id;

    const claimId =
      notification.related_claim_id;

    // Chat notifications contain a claim ID.
    // Resolve the conversation through the API.
    if (
      notification.notification_type ===
      'new_chat_message'
    ) {
      if (
        !claimId ||
        !Number.isSafeInteger(
          Number(claimId),
        ) ||
        Number(claimId) <= 0
      ) {
        void this.showAlert(
          'Chat Unavailable',
          'This notification has no valid conversation reference.',
        );

        return;
      }

      this.openChatForClaim(
        Number(claimId),
      );

      return;
    }

    // New ownership claims or finder responses
    // open the My Reports page and focus the claim.
    if (
      notification.notification_type ===
      'new_claim'
    ) {
      void this.router.navigate(
        ['/my-reports'],
        {
          queryParams: {
            ...(reportId
              ? { reportId }
              : {}),

            ...(claimId
              ? { claimId }
              : {}),
          },
        },
      );

      return;
    }

    // Other report-related notifications.
    if (reportId) {
      void this.router.navigate(
        ['/report-details', reportId],
      );
    }
  }

  // ==========================================
  // OPEN PRIVATE CHAT
  // ==========================================

  private openChatForClaim(
    claimId: number,
  ): void {
    if (
      this.destroyed ||
      this.openingChatClaimId !== null
    ) {
      return;
    }

    this.openingChatClaimId = claimId;
    this.refreshUI();

    this.chatNavigationRequest?.unsubscribe();

    this.chatNavigationRequest =
      this.chatService
        .getConversationForClaim(claimId)
        .pipe(
          timeout(15000),

          finalize(() => {
            if (!this.destroyed) {
              this.openingChatClaimId = null;
              this.refreshUI();
            }
          }),
        )
        .subscribe({
          next: ({ conversation }) => {
            if (this.destroyed) {
              return;
            }

            if (conversation) {
              void this.router.navigate(
                ['/chat', conversation.id],
              );
            } else {
              void this.showAlert(
                'Chat Unavailable',
                'The conversation could not be found.',
              );
            }
          },

          error: (error) => {
            if (this.destroyed) {
              return;
            }

            const message =
              error?.name === 'TimeoutError'
                ? 'The chat request timed out. Please try again.'
                : typeof error?.error?.detail ===
                    'string'
                  ? error.error.detail
                  : 'Unable to open this conversation. Please try again.';

            void this.showAlert(
              'Chat Unavailable',
              message,
            );
          },
        });
  }

  // ==========================================
  // SHOW ALERT
  // ==========================================

  private async showAlert(
    header: string,
    message: string,
  ): Promise<void> {
    if (this.destroyed) {
      return;
    }

    const alert =
      await this.alertController.create({
        header,
        message,
        buttons: ['OK'],
      });

    if (!this.destroyed) {
      await alert.present();
    }
  }
}