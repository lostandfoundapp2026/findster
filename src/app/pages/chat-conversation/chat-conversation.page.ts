import { CommonModule } from '@angular/common';

import {
  ChangeDetectorRef,
  Component,
  OnDestroy,
  OnInit,
  ViewChild,
} from '@angular/core';

import { FormsModule } from '@angular/forms';

import {
  Camera,
  CameraResultType,
  CameraSource,
} from '@capacitor/camera';

import {
  ActivatedRoute,
  Router,
} from '@angular/router';

import {
  IonBackButton,
  IonButton,
  IonButtons,
  IonContent,
  IonFooter,
  IonHeader,
  IonIcon,
  IonInfiniteScroll,
  IonInfiniteScrollContent,
  IonNote,
  IonSpinner,
  IonTextarea,
  IonTitle,
  IonToolbar,
} from '@ionic/angular';

import { addIcons } from 'ionicons';

import {
  arrowBackOutline,
  cameraOutline,
  refreshOutline,
  sendOutline,
  closeOutline,
  imageOutline,
  checkmarkDoneOutline,
} from 'ionicons/icons';

import {
  Subscription,
  finalize,
  firstValueFrom,
  timeout,
} from 'rxjs';

import { AuthService } from '../../services/auth';

import {
  ChatConnectionState,
  ChatConversation,
  ChatMessage,
  ChatService,
} from '../../services/chat';

@Component({
  selector: 'app-chat-conversation',
  standalone: true,

  imports: [
    CommonModule,
    FormsModule,
    IonBackButton,
    IonButton,
    IonButtons,
    IonContent,
    IonFooter,
    IonHeader,
    IonIcon,
    IonInfiniteScroll,
    IonInfiniteScrollContent,
    IonNote,
    IonSpinner,
    IonTextarea,
    IonTitle,
    IonToolbar,
  ],

  templateUrl: './chat-conversation.page.html',
  styleUrls: ['./chat-conversation.page.scss'],
})
export class ChatConversationPage
  implements OnInit, OnDestroy {

  @ViewChild(IonContent)
  private chatContent?: IonContent;

  // ==========================================
  // CONVERSATION DATA
  // ==========================================

  conversationId = 0;

  conversation: ChatConversation | null = null;

  messages: ChatMessage[] = [];

  currentUserId = 0;

  draft = '';

  // ==========================================
  // LOADING AND ERROR STATE
  // ==========================================

  loading = true;
  sending = false;
  loadingOlder = false;
  hasOlder = false;

  errorMessage = '';
  sendError = '';

  connectionState: ChatConnectionState =
    'disconnected';

  // ==========================================
  // IMAGE COMPOSITION
  // ==========================================

  selectedImage: Blob | null = null;

  selectedImageName = '';

  selectedImagePreview: string | null = null;

  pickingImage = false;
  sendingImage = false;

  // ==========================================
  // PRIVATE IMAGE URL MANAGEMENT
  // ==========================================

  private readonly imageUrls =
    new Map<number, string>();

  private readonly imagesLoading =
    new Set<number>();

  private readonly imageErrors =
    new Set<number>();

  private imageSubscriptions =
    new Subscription();

  // ==========================================
  // SUBSCRIPTIONS AND REQUEST STATE
  // ==========================================

  private readonly subscriptions =
    new Subscription();

  private readonly pageSize = 50;

  private requestId = 0;

  private readInFlight = false;

  private destroyed = false;

  private initialLoadInProgress = false;

  private backgroundRefreshInProgress = false;

  // ==========================================
  // SCROLL MANAGEMENT
  // ==========================================

  private scrollTimer?: ReturnType<typeof setTimeout>;

  private readonly bottomThreshold = 130;

  private scrollGeneration = 0;

  constructor(
    private readonly route: ActivatedRoute,
    private readonly router: Router,
    private readonly chat: ChatService,
    private readonly auth: AuthService,
    private readonly cdr: ChangeDetectorRef,
  ) {
    // Register icons for the redesigned conversation controls.
    addIcons({
      arrowBackOutline,
      cameraOutline,
      refreshOutline,
      sendOutline,
      closeOutline,
      imageOutline,
      checkmarkDoneOutline,
    });
  }

  // ==========================================
  // INITIALIZATION
  // ==========================================

  ngOnInit(): void {
    this.currentUserId =
      this.auth.getCurrentUser()?.id ?? 0;

    this.subscriptions.add(
      this.route.paramMap.subscribe((params) => {
        const id = Number(params.get('id'));

        if (
          !Number.isSafeInteger(id) ||
          id <= 0
        ) {
          this.requestId++;
          this.cancelScheduledScroll();

          this.conversationId = 0;
          this.conversation = null;
          this.messages = [];

          this.resetImages();
          this.clearSelectedImage();

          this.loading = false;

          this.errorMessage =
            'Invalid conversation.';

          this.refreshUI();
          return;
        }

        if (
          id === this.conversationId &&
          this.conversation
        ) {
          return;
        }

        this.cancelScheduledScroll();

        this.conversationId = id;

        this.resetImages();
        this.clearSelectedImage();

        this.conversation = null;
        this.messages = [];

        this.hasOlder = false;
        this.loading = true;
        this.errorMessage = '';

        void this.loadConversation(true);
      }),
    );

    // ==========================================
    // LIVE MESSAGE EVENTS
    // ==========================================

    this.subscriptions.add(
      this.chat.events$.subscribe((event) => {
        if (
          event.type === 'new_message' &&
          event.conversation_id ===
            this.conversationId
        ) {
          void this.handleLiveMessage(
            event.message,
          );
        } else if (
          event.type === 'messages_read' &&
          event.conversation_id ===
            this.conversationId &&
          event.read_by !== this.currentUserId
        ) {
          this.messages = this.messages.map(
            (message) =>
              message.sender_id ===
                this.currentUserId &&
              !message.read_at
                ? {
                    ...message,
                    read_at:
                      new Date().toISOString(),
                  }
                : message,
          );

          this.refreshUI();
        }
      }),
    );

    // ==========================================
    // CONNECTION UPDATES
    // ==========================================

    this.subscriptions.add(
      this.chat.connectionState$.subscribe(
        (state) => {
          const wasConnected =
            this.connectionState === 'connected';

          this.connectionState = state;

          if (
            state === 'connected' &&
            !wasConnected &&
            !!this.conversation &&
            !this.loading &&
            !this.initialLoadInProgress &&
            !this.backgroundRefreshInProgress
          ) {
            void this.loadConversation(false);
          }

          this.refreshUI();
        },
      ),
    );

    this.chat.connect();
  }

  // ==========================================
  // CLEANUP
  // ==========================================

  ngOnDestroy(): void {
    this.destroyed = true;

    this.requestId++;

    this.cancelScheduledScroll();

    this.subscriptions.unsubscribe();

    this.resetImages();

    this.clearSelectedImage();

    // Shared socket remains connected for inbox.
  }

  // ==========================================
  // UI REFRESH
  // ==========================================

  private refreshUI(): void {
    if (!this.destroyed) {
      this.cdr.markForCheck();
    }
  }

  // ==========================================
  // SCROLL HELPERS
  // ==========================================

  private cancelScheduledScroll(): void {
    this.scrollGeneration++;

    if (this.scrollTimer) {
      clearTimeout(this.scrollTimer);
      this.scrollTimer = undefined;
    }
  }

  /**
   * Scroll after Angular has rendered the latest
   * messages into the DOM.
   */
  private scheduleScrollToBottom(
    smooth = false,
  ): void {
    this.cancelScheduledScroll();

    const generation = this.scrollGeneration;
    const conversationId = this.conversationId;

    this.scrollTimer = setTimeout(() => {
      if (
        this.destroyed ||
        generation !== this.scrollGeneration ||
        conversationId !== this.conversationId
      ) {
        return;
      }

      this.refreshUI();

      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (
            this.destroyed ||
            generation !== this.scrollGeneration ||
            conversationId !== this.conversationId
          ) {
            return;
          }

          void this.chatContent?.scrollToBottom(
            smooth ? 250 : 0,
          );
        });
      });
    }, 40);
  }

  /**
   * Detect whether the user is close enough
   * to the latest message.
   */
  private async isNearBottom(): Promise<boolean> {
    if (!this.chatContent) {
      return false;
    }

    try {
      const element =
        await this.chatContent.getScrollElement();

      const remainingDistance =
        element.scrollHeight -
        element.scrollTop -
        element.clientHeight;

      return (
        remainingDistance <=
        this.bottomThreshold
      );
    } catch {
      return false;
    }
  }

  /**
   * Handle real-time messages without forcing
   * someone reading old messages to jump down.
   */
  private async handleLiveMessage(
    message: ChatMessage,
  ): Promise<void> {
    const conversationId = this.conversationId;

    const isOwnMessage =
      message.sender_id === this.currentUserId;

    const shouldScroll =
      isOwnMessage ||
      await this.isNearBottom();

    if (
      this.destroyed ||
      conversationId !== this.conversationId
    ) {
      return;
    }

    const wasAdded = this.addMessage(message);

    this.refreshUI();

    if (wasAdded && shouldScroll) {
      this.scheduleScrollToBottom(true);
    }

    if (!isOwnMessage) {
      this.markRead();
    }
  }

  // ==========================================
  // LOAD CONVERSATION
  // ==========================================

  async loadConversation(
    showSpinner = true,
  ): Promise<void> {
    if (
      this.destroyed ||
      !this.conversationId
    ) {
      return;
    }

    if (
      !showSpinner &&
      (
        this.initialLoadInProgress ||
        this.backgroundRefreshInProgress
      )
    ) {
      return;
    }

    const id = this.conversationId;

    const request = ++this.requestId;

    let shouldScrollAfterLoading = showSpinner;

    if (!showSpinner) {
      shouldScrollAfterLoading =
        await this.isNearBottom();

      if (
        !this.isCurrentRequest(request, id)
      ) {
        return;
      }
    }

    if (showSpinner) {
      this.initialLoadInProgress = true;
      this.loading = true;
    } else {
      this.backgroundRefreshInProgress = true;
    }

    this.errorMessage = '';

    this.refreshUI();

    try {
      const inbox = await firstValueFrom(
        this.chat
          .getMyConversations()
          .pipe(timeout(15000)),
      );

      if (
        !this.isCurrentRequest(request, id)
      ) {
        return;
      }

      const conversation =
        (inbox.conversations ?? []).find(
          (item) => Number(item.id) === id,
        );

      if (!conversation) {
        this.conversation = null;
        this.messages = [];
        this.hasOlder = false;

        this.errorMessage =
          'Conversation not found or access denied.';

        return;
      }

      this.conversation = conversation;

      this.refreshUI();

      const result = await firstValueFrom(
        this.chat
          .getMessages(id, this.pageSize)
          .pipe(timeout(15000)),
      );

      if (
        !this.isCurrentRequest(request, id)
      ) {
        return;
      }

      const fetched = result.messages ?? [];

      // Preserve messages received while the
      // REST history request was in progress.
      const byId =
        new Map<number, ChatMessage>();

      for (const message of fetched) {
        byId.set(message.id, message);
      }

      for (const message of this.messages) {
        if (!byId.has(message.id)) {
          byId.set(message.id, message);
        }
      }

      this.messages = Array.from(
        byId.values(),
      ).sort((a, b) => a.id - b.id);

      this.loadImages(this.messages);

      this.hasOlder =
        fetched.length === this.pageSize;

      this.markRead();

      if (shouldScrollAfterLoading) {
        this.scheduleScrollToBottom(false);
      }
    } catch (error) {
      if (
        this.isCurrentRequest(request, id)
      ) {
        this.errorMessage =
          this.readError(error);

        console.error(
          'Load chat conversation failed:',
          error,
        );
      }
    } finally {
      if (
        this.isCurrentRequest(request, id)
      ) {
        this.loading = false;

        this.initialLoadInProgress = false;
        this.backgroundRefreshInProgress = false;

        this.refreshUI();

        if (
          shouldScrollAfterLoading &&
          this.conversation &&
          !this.errorMessage
        ) {
          this.scheduleScrollToBottom(false);
        }
      }
    }
  }

  // ==========================================
  // LOAD OLDER MESSAGES
  // ==========================================

  async loadOlder(
    event?: Event,
  ): Promise<void> {
    if (
      this.loadingOlder ||
      !this.hasOlder ||
      !this.messages.length
    ) {
      await this.completeInfinite(event);
      return;
    }

    const id = this.conversationId;

    this.cancelScheduledScroll();

    this.loadingOlder = true;
    this.refreshUI();

    let scrollElement: HTMLElement | null = null;

    let previousHeight = 0;
    let previousTop = 0;

    try {
      // Remember current position before
      // adding messages above the viewport.
      if (this.chatContent) {
        scrollElement =
          await this.chatContent.getScrollElement();

        previousHeight =
          scrollElement.scrollHeight;

        previousTop =
          scrollElement.scrollTop;
      }

      const oldestId =
        this.messages[0].id;

      const result = await firstValueFrom(
        this.chat
          .getMessages(
            id,
            this.pageSize,
            oldestId,
          )
          .pipe(timeout(15000)),
      );

      if (
        this.destroyed ||
        id !== this.conversationId
      ) {
        return;
      }

      const fetched =
        result.messages ?? [];

      if (
        fetched.length < this.pageSize
      ) {
        this.hasOlder = false;
      }

      const seen = new Set(
        this.messages.map(
          (message) => message.id,
        ),
      );

      const older =
        fetched.filter(
          (message) =>
            !seen.has(message.id),
        );

      this.messages = [
        ...older,
        ...this.messages,
      ].sort((a, b) => a.id - b.id);

      this.loadImages(older);

      this.refreshUI();

      // Wait for older messages to be rendered
      // before restoring the scroll position.
      if (
        scrollElement &&
        older.length > 0
      ) {
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              resolve();
            });
          });
        });

        if (
          !this.destroyed &&
          id === this.conversationId
        ) {
          const newHeight =
            scrollElement.scrollHeight;

          scrollElement.scrollTop =
            previousTop +
            (newHeight - previousHeight);
        }
      }
    } catch (error) {
      if (
        !this.destroyed &&
        id === this.conversationId
      ) {
        this.errorMessage =
          this.readError(error);
      }
    } finally {
      this.loadingOlder = false;

      await this.completeInfinite(event);

      this.refreshUI();
    }
  }

  // ==========================================
  // SEND TEXT MESSAGE
  // ==========================================

  send(): void {
    const body =
      this.draft.trim();

    if (
      this.sending ||
      this.sendingImage ||
      !this.conversation?.can_send
    ) {
      return;
    }

    if (
      !body ||
      body.length > 2000
    ) {
      this.sendError =
        'Enter a message of 1 to 2000 characters.';

      this.refreshUI();
      return;
    }

    const conversationId =
      this.conversationId;

    this.sending = true;
    this.sendError = '';

    this.refreshUI();

    const request = this.chat
      .sendMessage(conversationId, body)
      .pipe(
        timeout(15000),
        finalize(() => {
          this.sending = false;
          this.refreshUI();
        }),
      )
      .subscribe({
        next: ({ message }) => {
          if (
            this.destroyed ||
            conversationId !== this.conversationId
          ) {
            return;
          }

          this.addMessage(message);

          if (
            this.draft.trim() === body
          ) {
            this.draft = '';
          }

          this.refreshUI();

          this.scheduleScrollToBottom(true);
        },

        error: (error) => {
          if (
            this.destroyed ||
            conversationId !== this.conversationId
          ) {
            return;
          }

          this.sendError =
            this.readError(error);

          if (error?.status === 409) {
            void this.loadConversation(false);
          }

          this.refreshUI();
        },
      });

    this.subscriptions.add(request);
  }

  // ==========================================
  // CAMERA / GALLERY IMAGE SELECTION
  // ==========================================

  async pickImage(): Promise<void> {
    if (
      this.pickingImage ||
      this.sending ||
      this.sendingImage ||
      !this.conversation?.can_send
    ) {
      return;
    }

    const conversationId =
      this.conversationId;

    this.pickingImage = true;
    this.sendError = '';

    this.refreshUI();

    try {
      const photo =
        await Camera.getPhoto({
          source: CameraSource.Prompt,
          resultType: CameraResultType.Uri,
          quality: 80,
          correctOrientation: true,
          saveToGallery: false,

          promptLabelHeader:
            'Attach a photo',

          promptLabelPhoto:
            'Choose from gallery',

          promptLabelPicture:
            'Take a photo',
        });

      if (!photo.webPath) {
        throw new Error(
          'Could not read the selected photo.',
        );
      }

      const result =
        await fetch(photo.webPath);

      if (!result.ok) {
        throw new Error(
          'Could not read the selected photo.',
        );
      }

      const blob =
        await result.blob();

      if (
        ![
          'image/jpeg',
          'image/png',
          'image/webp',
        ].includes(blob.type)
      ) {
        throw new Error(
          'Please select a JPG, PNG, or WEBP image.',
        );
      }

      if (
        !blob.size ||
        blob.size > 5 * 1024 * 1024
      ) {
        throw new Error(
          'The photo must not exceed 5 MB.',
        );
      }

      if (
        this.destroyed ||
        conversationId !== this.conversationId ||
        !this.conversation?.can_send
      ) {
        return;
      }

      this.clearSelectedImage();

      this.selectedImage = blob;

      const suffix =
        blob.type === 'image/png'
          ? 'png'
          : blob.type === 'image/webp'
            ? 'webp'
            : 'jpg';

      this.selectedImageName =
        `chat-photo.${suffix}`;

      this.selectedImagePreview =
        URL.createObjectURL(blob);
    } catch (error: any) {
      const description = String(
        error?.message ?? error ?? '',
      );

      if (
        !/cancel|dismiss|no image selected/i.test(
          description,
        )
      ) {
        this.sendError =
          description ||
          'Unable to select image.';
      }
    } finally {
      this.pickingImage = false;
      this.refreshUI();
    }
  }

  // ==========================================
  // CLEAR SELECTED IMAGE
  // ==========================================

  clearSelectedImage(): void {
    if (this.selectedImagePreview) {
      URL.revokeObjectURL(
        this.selectedImagePreview,
      );
    }

    this.selectedImagePreview = null;
    this.selectedImage = null;
    this.selectedImageName = '';

    this.refreshUI();
  }

  // ==========================================
  // SEND IMAGE
  // ==========================================

  sendSelectedImage(): void {
    const image =
      this.selectedImage;

    const conversationId =
      this.conversationId;

    if (
      !image ||
      this.sending ||
      this.sendingImage ||
      !this.conversation?.can_send
    ) {
      return;
    }

    this.sendingImage = true;
    this.sendError = '';

    this.refreshUI();

    const request = this.chat
      .sendImage(
        conversationId,
        image,
        this.selectedImageName,
      )
      .pipe(
        timeout(45000),

        finalize(() => {
          this.sendingImage = false;
          this.refreshUI();
        }),
      )
      .subscribe({
        next: ({ message }) => {
          if (
            this.destroyed ||
            conversationId !== this.conversationId
          ) {
            return;
          }

          this.addMessage(message);

          this.clearSelectedImage();

          this.refreshUI();

          this.scheduleScrollToBottom(true);
        },

        error: (error) => {
          if (
            this.destroyed ||
            conversationId !== this.conversationId
          ) {
            return;
          }

          this.sendError =
            this.readError(error);

          if (error?.status === 409) {
            void this.loadConversation(false);
          }

          this.refreshUI();
        },
      });

    this.subscriptions.add(request);
  }

  // ==========================================
  // MESSAGE IMAGE HELPERS
  // ==========================================

  isImage(
    message: ChatMessage,
  ): boolean {
    return (
      message.message_type === 'image'
    );
  }

  getMessageImageUrl(
    message: ChatMessage,
  ): string | null {
    return (
      this.imageUrls.get(message.id) ??
      null
    );
  }

  hasImageError(
    message: ChatMessage,
  ): boolean {
    return this.imageErrors.has(
      message.id,
    );
  }

  // ==========================================
  // LOAD AUTHENTICATED IMAGES
  // ==========================================

  private loadImages(
    messages: ChatMessage[],
  ): void {
    for (const message of messages) {
      if (
        message.message_type !== 'image' ||
        !message.image_url ||
        this.imageUrls.has(message.id) ||
        this.imagesLoading.has(message.id) ||
        this.imageErrors.has(message.id)
      ) {
        continue;
      }

      const id = message.id;

      const conversationId =
        this.conversationId;

      this.imagesLoading.add(id);

      const sub = this.chat
        .getImage(message)
        .pipe(timeout(30000))
        .subscribe({
          next: (blob) => {
            this.imagesLoading.delete(id);

            if (
              this.destroyed ||
              conversationId !==
                this.conversationId
            ) {
              return;
            }

            if (
              !blob.type.startsWith('image/')
            ) {
              this.imageErrors.add(id);
              this.refreshUI();
              return;
            }

            this.imageUrls.set(
              id,
              URL.createObjectURL(blob),
            );

            this.refreshUI();
          },

          error: () => {
            this.imagesLoading.delete(id);

            if (
              !this.destroyed &&
              conversationId ===
                this.conversationId
            ) {
              this.imageErrors.add(id);
              this.refreshUI();
            }
          },
        });

      this.imageSubscriptions.add(sub);
    }
  }

  // ==========================================
  // RESET IMAGE CACHE
  // ==========================================

  private resetImages(): void {
    this.imageSubscriptions.unsubscribe();

    this.imageSubscriptions =
      new Subscription();

    for (
      const url of this.imageUrls.values()
    ) {
      URL.revokeObjectURL(url);
    }

    this.imageUrls.clear();
    this.imagesLoading.clear();
    this.imageErrors.clear();
  }

  // ==========================================
  // MESSAGE HELPERS
  // ==========================================

  isMine(
    message: ChatMessage,
  ): boolean {
    return (
      message.sender_id ===
      this.currentUserId
    );
  }

  trackByMessage(
    _index: number,
    message: ChatMessage,
  ): number {
    return message.id;
  }

  get chatTitle(): string {
    return (
      this.conversation?.item_name ||
      'Private Chat'
    );
  }

  get statusLabel(): string {
    if (!this.conversation) {
      return '';
    }

    if (!this.conversation.can_send) {
      return 'Read-only';
    }

    return (
      this.conversation.claim_status ===
      'pending'
        ? 'Verification'
        : 'Approved'
    );
  }

  // ==========================================
  // ADD MESSAGE WITHOUT DUPLICATES
  // ==========================================

  private addMessage(
    message: ChatMessage,
  ): boolean {
    if (
      this.messages.some(
        (existing) =>
          existing.id === message.id,
      )
    ) {
      return false;
    }

    this.messages = [
      ...this.messages,
      message,
    ].sort((a, b) => a.id - b.id);

    this.loadImages([message]);

    return true;
  }

  // ==========================================
  // MARK MESSAGES AS READ
  // ==========================================

  private markRead(): void {
    if (
      this.readInFlight ||
      !this.conversationId
    ) {
      return;
    }

    const conversationId =
      this.conversationId;

    this.readInFlight = true;

    const request = this.chat
      .markAsRead(conversationId)
      .pipe(
        timeout(15000),

        finalize(() => {
          this.readInFlight = false;
          this.refreshUI();
        }),
      )
      .subscribe({
        next: () => {
          if (
            this.destroyed ||
            conversationId !== this.conversationId
          ) {
            return;
          }

          this.messages = this.messages.map(
            (message) =>
              message.sender_id !==
                this.currentUserId &&
              !message.read_at
                ? {
                    ...message,
                    read_at:
                      new Date().toISOString(),
                  }
                : message,
          );

          this.refreshUI();
        },

        error: () => {
          // Read receipt failure should not
          // prevent viewing the conversation.
        },
      });

    this.subscriptions.add(request);
  }

  // ==========================================
  // NAVIGATION
  // ==========================================

  goBack(): void {
    void this.router.navigateByUrl(
      '/chat',
    );
  }

  // ==========================================
  // REQUEST VALIDATION
  // ==========================================

  private isCurrentRequest(
    request: number,
    id: number,
  ): boolean {
    return (
      !this.destroyed &&
      request === this.requestId &&
      id === this.conversationId
    );
  }

  // ==========================================
  // COMPLETE INFINITE SCROLL
  // ==========================================

  private async completeInfinite(
    event?: Event,
  ): Promise<void> {
    const target =
      event?.target as
        | HTMLIonInfiniteScrollElement
        | undefined;

    if (target) {
      await target.complete();
    }
  }

  // ==========================================
  // ERROR MESSAGES
  // ==========================================

  private readError(
    error: any,
  ): string {
    if (
      error?.name === 'TimeoutError'
    ) {
      return (
        'The server took too long to respond. Please try again.'
      );
    }

    if (error?.status === 401) {
      return (
        'Session expired. Please log in again.'
      );
    }

    if (
      error?.status === 403 ||
      error?.status === 404
    ) {
      return (
        'Conversation not found or access denied.'
      );
    }

    if (error?.status === 0) {
      return (
        'Cannot reach the server. Check your connection.'
      );
    }

    return (
      typeof error?.error?.detail === 'string'
        ? error.error.detail
        : 'Something went wrong. Please try again.'
    );
  }
}