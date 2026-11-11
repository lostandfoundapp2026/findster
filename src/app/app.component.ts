// Save as: src/app/app.component.ts
import { Component, OnDestroy, OnInit } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { NavigationEnd, Router } from '@angular/router';
import { Capacitor, type PluginListenerHandle } from '@capacitor/core';
import { PushNotifications, type ActionPerformed } from '@capacitor/push-notifications';
import { IonApp, IonRouterOutlet } from '@ionic/angular';
import { filter, firstValueFrom, take, timeout } from 'rxjs';
import { environment } from '../environments/environment';

interface ChatLookupResponse {
  conversation: { id: number } | null;
}

interface PushDestination {
  type: string;
  reportId: number | null;
  claimId: number | null;
}

@Component({
  selector: 'app-root',
  templateUrl: 'app.component.html',
  standalone: true,
  imports: [IonApp, IonRouterOutlet],
})
export class AppComponent implements OnInit, OnDestroy {
  private pushListeners: PluginListenerHandle[] = [];
  private destroyed = false;
  private navigating = false;
  private queuedTap: PushDestination | null = null;

  constructor(
    private readonly router: Router,
    private readonly http: HttpClient,
  ) {}

  ngOnInit(): void {
    if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android') {
      void this.initializeAndroidPush();
    }
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    for (const listener of this.pushListeners) void listener.remove();
    this.pushListeners = [];
  }

  private async initializeAndroidPush(): Promise<void> {
    try {
      // Set up the tap handler first so it is ready during app startup.
      const action = await PushNotifications.addListener('pushNotificationActionPerformed', (event) => {
        if (this.destroyed) return;
        void this.onPushTapped(event);
      });
      this.pushListeners.push(action);

      const registration = await PushNotifications.addListener('registration', () => {
        if (!this.destroyed) console.info('[Push] Android device registered successfully.');
        // AuthService also listens for this event and uploads the FCM token.
      });
      this.pushListeners.push(registration);

      const registrationError = await PushNotifications.addListener('registrationError', () => {
        if (!this.destroyed) console.error('[Push] Device registration failed.');
      });
      this.pushListeners.push(registrationError);

      const received = await PushNotifications.addListener('pushNotificationReceived', () => {
        if (!this.destroyed) console.info('[Push] Foreground notification received.');
      });
      this.pushListeners.push(received);

      if (this.destroyed) return;
      let permission = await PushNotifications.checkPermissions();
      if (permission.receive === 'prompt' || permission.receive === 'prompt-with-rationale') {
        permission = await PushNotifications.requestPermissions();
      }
      if (permission.receive !== 'granted') {
        console.info('[Push] Notifications permission not granted.');
        return;
      }
      if (!this.destroyed) await PushNotifications.register();
    } catch {
      console.error('[Push] Could not initialize native push notifications.');
    }
  }

  private positiveId(value: unknown): number | null {
    if (typeof value !== 'string' && typeof value !== 'number') return null;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
  }

  private async onPushTapped(event: ActionPerformed): Promise<void> {
    const data = event.notification.data ?? {};
    const destination: PushDestination = {
      type: typeof data['notification_type'] === 'string' ? data['notification_type'] : '',
      reportId: this.positiveId(data['related_report_id']),
      claimId: this.positiveId(data['related_claim_id']),
    };

    // Log only non-sensitive routing metadata; never log tokens or message text.
    console.info('[Push] Tap received:', JSON.stringify(destination));
    this.queuedTap = destination;
    if (!this.navigating) await this.processQueuedTap();
  }

  private async waitForInitialRoute(): Promise<void> {
    if (this.router.navigated) return;
    try {
      await firstValueFrom(
        this.router.events.pipe(filter((event) => event instanceof NavigationEnd), take(1), timeout(4000)),
      );
    } catch {
      // Continue with normal navigation if initial routing takes too long.
    }
  }

  private async processQueuedTap(): Promise<void> {
    if (this.destroyed || this.navigating) return;
    this.navigating = true;
    try {
      await this.waitForInitialRoute();
      while (!this.destroyed && this.queuedTap) {
        const destination = this.queuedTap;
        this.queuedTap = null;
        await this.navigateToPush(destination);
      }
    } finally {
      this.navigating = false;
    }
  }

  private async navigateToPush(destination: PushDestination): Promise<void> {
    const jwt = localStorage.getItem('access_token');
    if (!jwt) {
      console.warn('[Push] No active session; navigating to Login.');
      await this.router.navigate(['/login']);
      return;
    }

    if (destination.type === 'new_chat_message' && destination.claimId) {
      try {
        const response = await firstValueFrom(
          this.http.get<ChatLookupResponse>(
            `${environment.apiBaseUrl}/api/chat/claims/${destination.claimId}`,
            { headers: new HttpHeaders({ Authorization: `Bearer ${jwt}` }), timeout: 10000 },
          ),
        );
        const conversationId = this.positiveId(response.conversation?.id);
        if (conversationId) {
          const opened = await this.router.navigate(['/chat', conversationId]);
          console.info('[Push] Chat navigation result:', opened, 'route:', this.router.url);
          return;
        }
        console.warn('[Push] Chat claim has no conversation.');
      } catch (error: unknown) {
        const status = typeof error === 'object' && error !== null && 'status' in error
          ? (error as { status?: number }).status
          : undefined;
        console.warn('[Push] Chat lookup failed; HTTP status:', status ?? 'unknown');
      }
      await this.router.navigate(['/notifications']);
      return;
    }

    if (destination.type === 'new_claim') {
      await this.router.navigate(['/my-reports'], {
        queryParams: {
          ...(destination.reportId ? { reportId: destination.reportId } : {}),
          ...(destination.claimId ? { claimId: destination.claimId } : {}),
        },
      });
      return;
    }

    if (destination.reportId) {
      await this.router.navigate(['/report-details', destination.reportId]);
      return;
    }

    console.warn('[Push] Missing or unrecognized navigation data; opening notifications.');
    await this.router.navigate(['/notifications']);
  }
}