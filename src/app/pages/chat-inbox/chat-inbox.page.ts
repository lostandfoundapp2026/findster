// Save as: src/app/pages/chat-inbox/chat-inbox.page.ts
// FINDSTER — CHAT INBOX
// Compact inbox with reliable HTTP loading and live-update handling.

import { CommonModule } from '@angular/common';
import {
  ChangeDetectorRef,
  Component,
  OnDestroy,
  OnInit,
} from '@angular/core';
import { Router } from '@angular/router';
import {
  IonBadge,
  IonButton,
  IonContent,
  IonHeader,
  IonItem,
  IonLabel,
  IonList,
  IonRefresher,
  IonRefresherContent,
  IonSpinner,
  IonToolbar,
} from '@ionic/angular';
import { Subscription, finalize, timeout } from 'rxjs';
import {
  ChatConnectionState,
  ChatConversation,
  ChatService,
} from '../../services/chat';

@Component({
  selector: 'app-chat-inbox',
  standalone: true,
  imports: [
    CommonModule,
    IonBadge,
    IonButton,
    IonContent,
    IonHeader,
    IonItem,
    IonLabel,
    IonList,
    IonRefresher,
    IonRefresherContent,
    IonSpinner,
    IonToolbar,
  ],
  templateUrl: './chat-inbox.page.html',
  styleUrls: ['./chat-inbox.page.scss'],
})
export class ChatInboxPage implements OnInit, OnDestroy {
  conversations: ChatConversation[] = [];
  loading = true;
  refreshing = false;
  errorMessage = '';
  connectionState: ChatConnectionState = 'disconnected';

  private readonly subscriptions = new Subscription();
  private loadSubscription?: Subscription;
  private readonly requestTimeoutMs = 15000;

  private requestInProgress = false;
  private reloadAfterCurrentRequest = false;
  private destroyed = false;
  private initialized = false;
  private hasLoadedOnce = false;
  private requestVersion = 0;

  constructor(
    private readonly chat: ChatService,
    private readonly router: Router,
    private readonly cdr: ChangeDetectorRef,
  ) {}

  ngOnInit(): void {
    this.subscriptions.add(
      this.chat.events$.subscribe((event) => {
        if (
          event.type === 'conversation_started' ||
          event.type === 'new_message' ||
          event.type === 'messages_read'
        ) {
          this.requestConversationsUpdate();
        }
      }),
    );

    this.subscriptions.add(
      this.chat.connectionState$.subscribe((state) => {
        const previouslyConnected = this.connectionState === 'connected';
        this.connectionState = state;

        // Only request a catch-up refresh on a transition to connected.
        // Repeated identical socket states must not trigger HTTP requests.
        if (state === 'connected' && !previouslyConnected) {
          this.requestConversationsUpdate();
        }

        this.safeDetectChanges();
      }),
    );

    this.initialized = true;
    this.chat.connect();
    this.loadConversations(true);
  }

  ionViewWillEnter(): void {
    // Ionic can call this immediately after ngOnInit. Do not fetch twice.
    if (this.initialized && this.hasLoadedOnce) {
      this.loadConversations(false);
    }
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.requestVersion += 1;
    this.reloadAfterCurrentRequest = false;
    this.loadSubscription?.unsubscribe();
    this.subscriptions.unsubscribe();
    // Keep the shared socket available for Chat Conversation.
  }

  loadConversations(showSpinner = true): void {
    if (this.destroyed) return;

    // Queue one catch-up load rather than cancelling an in-flight request.
    if (this.requestInProgress) {
      this.reloadAfterCurrentRequest = true;
      return;
    }

    this.startLoad(showSpinner);
  }

  doRefresh(event: CustomEvent): void {
    const refresher = event.target as HTMLIonRefresherElement | null;
    if (this.destroyed) {
      void refresher?.complete();
      return;
    }

    // Invalidate the earlier request *before* unsubscribing. Its finalize
    // callback must not reset the state of this new manual refresh.
    this.requestVersion += 1;
    this.loadSubscription?.unsubscribe();
    this.requestInProgress = false;
    this.reloadAfterCurrentRequest = false;
    this.refreshing = true;

    this.startLoad(false, refresher);
  }

  openConversation(conversation: ChatConversation): void {
    if (!Number.isSafeInteger(conversation.id) || conversation.id <= 0) {
      return;
    }
    void this.router.navigate(['/chat', conversation.id]);
  }

  // Preserve the existing tab route used by the inbox's Browse Reports action.
  goBack(): void {
    void this.router.navigateByUrl('/tabs/home');
  }

  labelFor(conversation: ChatConversation): string {
    return conversation.report_type === 'lost' ? 'Lost Item' : 'Found Item';
  }

  statusFor(conversation: ChatConversation): string {
    if (!conversation.can_send) return 'Read-only';
    if (conversation.claim_status === 'pending') return 'Verification';
    return 'Approved';
  }

  trackById(_index: number, conversation: ChatConversation): number {
    return conversation.id;
  }

  private startLoad(
    showSpinner: boolean,
    refresher?: HTMLIonRefresherElement | null,
  ): void {
    if (this.destroyed) {
      void refresher?.complete();
      return;
    }

    const version = ++this.requestVersion;
    this.requestInProgress = true;
    if (showSpinner) this.loading = true;
    this.errorMessage = '';
    this.safeDetectChanges();

    this.loadSubscription = this.chat
      .getMyConversations()
      .pipe(
        timeout({ first: this.requestTimeoutMs }),
        finalize(() => {
          // A cancelled older request cannot clear the current request state.
          if (this.destroyed || version !== this.requestVersion) return;

          this.requestInProgress = false;
          this.loading = false;
          this.refreshing = false;
          this.hasLoadedOnce = true;
          void refresher?.complete();
          this.safeDetectChanges();

          if (this.reloadAfterCurrentRequest) {
            this.reloadAfterCurrentRequest = false;
            this.startLoad(false);
          }
        }),
      )
      .subscribe({
        next: (response) => {
          if (this.destroyed || version !== this.requestVersion) return;
          const items = Array.isArray(response?.conversations)
            ? response.conversations
            : [];
          this.conversations = this.sortConversations(items);
          this.safeDetectChanges();
        },
        error: (error) => {
          if (this.destroyed || version !== this.requestVersion) return;
          this.errorMessage = this.readError(error);
          this.safeDetectChanges();
        },
      });
  }

  private requestConversationsUpdate(): void {
    if (this.destroyed || !this.initialized) return;

    if (this.requestInProgress) {
      this.reloadAfterCurrentRequest = true;
      return;
    }

    this.loadConversations(false);
  }

  private sortConversations(
    items: ChatConversation[],
  ): ChatConversation[] {
    return [...items].sort((a, b) => {
      const aTime = Date.parse(a.updated_at ?? a.created_at ?? '') || 0;
      const bTime = Date.parse(b.updated_at ?? b.created_at ?? '') || 0;
      return bTime - aTime;
    });
  }

  private readError(error: any): string {
    if (error?.name === 'TimeoutError') {
      return 'Loading conversations took too long. Pull down to try again.';
    }
    if (error?.status === 401) {
      return 'Session expired. Please log in again.';
    }
    if (error?.status === 0) {
      return 'Cannot reach the server. Check your connection.';
    }
    return typeof error?.error?.detail === 'string'
      ? error.error.detail
      : 'Unable to load conversations. Please try again.';
  }

  private safeDetectChanges(): void {
    if (!this.destroyed) this.cdr.detectChanges();
  }
}