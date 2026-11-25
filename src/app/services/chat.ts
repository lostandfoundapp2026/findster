// Save as: src/app/services/chat.ts
// Private claim-based chat service for the Lost & Found app.
// REST handles chat writes, image uploads and history; WebSocket delivers live updates.
import { Injectable, OnDestroy } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { BehaviorSubject, Observable, Subject, TimeoutError, catchError, throwError, timeout } from 'rxjs';
import { environment } from '../../environments/environment';
import { AuthService } from './auth';
export interface ChatConversation {
  id: number;
  claim_id: number;
  report_id: number;
  item_name: string;
  report_type: 'lost' | 'found';
  claim_status: 'pending' | 'approved' | 'rejected';
  report_status: 'active' | 'claimed' | 'returned' | 'closed';
  report_owner_id: number;
  requester_id: number;
  can_send: boolean;
  created_at: string | null;
  updated_at: string | null;
  unread_count?: number;
  /** Name of the other authorized participant, supplied by chat API. */
  other_participant_name?: string | null;
  /** Latest message preview only on /api/chat/mine. */
  last_message_preview?: string | null;
  last_message_at?: string | null;
}
export interface ChatMessage {
  id: number;
  conversation_id: number;
  sender_id: number;
  body: string | null;
  message_type: 'text' | 'image';
  image_url: string | null;
  created_at: string | null;
  read_at: string | null;
}
export type ChatRealtimeEvent =
  | { type: 'authenticated'; user_id: number }
  | { type: 'conversation_started'; conversation: ChatConversation }
  | { type: 'new_message'; conversation_id: number; message: ChatMessage }
  | { type: 'messages_read'; conversation_id: number; read_by: number }
  | { type: 'pong' };
export type ChatConnectionState =
  'disconnected' | 'connecting' | 'connected' | 'reconnecting';
@Injectable({ providedIn: 'root' })
export class ChatService implements OnDestroy {
  private readonly apiRoot = environment.apiBaseUrl.replace(/\/+$/, '');
  private readonly baseUrl = `${this.apiRoot}/api/chat`;
  private readonly eventsSubject = new Subject<ChatRealtimeEvent>();
  private readonly stateSubject =
    new BehaviorSubject<ChatConnectionState>('disconnected');
  readonly events$ = this.eventsSubject.asObservable();
  readonly connectionState$ = this.stateSubject.asObservable();
  private socket: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private retryCount = 0;
  private shouldReconnect = false;
  private generation = 0;
  constructor(
    private readonly http: HttpClient,
    private readonly auth: AuthService,
  ) {}
  // The configured authInterceptor attaches the Bearer token to REST calls.
  startConversation(claimId: number): Observable<{ conversation: ChatConversation }> {
    return this.http.post<{ conversation: ChatConversation }>(
      `${this.baseUrl}/claims/${claimId}/start`,
      {},
    );
  }
  /**
   * Get the inbox through REST. WebSocket connection/reconnection must not block
   * this request. Fail within 12 seconds instead of leaving the inbox loading.
   */
  getMyConversations(): Observable<{ conversations: ChatConversation[] }> {
    return this.http.get<{ conversations: ChatConversation[] }>(
      `${this.baseUrl}/mine`,
    ).pipe(
      timeout({ first: 12000 }),
      catchError((error: unknown) => {
        if (error instanceof TimeoutError) {
          return throwError(() => ({
            status: 504,
            error: {
              detail: 'Loading conversations timed out. Check your connection and tap Try Again.',
            },
          }));
        }
        return throwError(() => error);
      }),
    );
  }
  getConversationForClaim(
    claimId: number,
  ): Observable<{ conversation: ChatConversation | null }> {
    return this.http.get<{ conversation: ChatConversation | null }>(
      `${this.baseUrl}/claims/${claimId}`,
    );
  }
  getMessages(
    conversationId: number,
    limit = 50,
    beforeId?: number,
  ): Observable<{ messages: ChatMessage[] }> {
    let params = new HttpParams().set('limit', limit);
    if (beforeId !== undefined) {
      params = params.set('before_id', beforeId);
    }
    return this.http.get<{ messages: ChatMessage[] }>(
      `${this.baseUrl}/${conversationId}/messages`,
      { params },
    );
  }
  sendMessage(
    conversationId: number,
    body: string,
  ): Observable<{ message: ChatMessage }> {
    const trimmed = body.trim();
    if (!trimmed || trimmed.length > 2000) {
      throw new Error('Message must contain 1 to 2000 characters.');
    }
    return this.http.post<{ message: ChatMessage }>(
      `${this.baseUrl}/${conversationId}/messages`,
      { body: trimmed },
    );
  }
  /**
   * Send an image-only message. Accepts a File or Blob from the camera/gallery.
   * Caller should supply a meaningful filename for a Blob, e.g. "photo.jpg".
   * Do not set Content-Type manually; the browser/Capacitor WebView must set
   * multipart/form-data with its generated boundary.
   */
  sendImage(
    conversationId: number,
    image: Blob,
    filename = 'chat-image.jpg',
  ): Observable<{ message: ChatMessage }> {
    if (!image.size) {
      throw new Error('Please select an image.');
    }
    if (image.size > 5 * 1024 * 1024) {
      throw new Error('Image must not exceed 5 MB.');
    }
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(image.type)) {
      throw new Error('Only JPG, PNG, and WEBP images are supported.');
    }
    const formData = new FormData();
    formData.append('file', image, image instanceof File ? image.name : filename);
    return this.http.post<{ message: ChatMessage }>(
      `${this.baseUrl}/${conversationId}/images`,
      formData,
    );
  }
  /**
   * Load a private chat image as a Blob through the authenticated interceptor.
   * Do not put image_url directly into <img src>, because the endpoint needs
   * an Authorization header. The component should make an object URL from
   * the returned Blob, and revoke it when it is no longer used.
   */
  getImage(message: Pick<ChatMessage, 'id' | 'conversation_id'>): Observable<Blob> {
    return this.http.get(
      `${this.baseUrl}/${message.conversation_id}/images/${message.id}`,
      { responseType: 'blob' },
    );
  }
  markAsRead(conversationId: number): Observable<{ marked_read: number }> {
    return this.http.post<{ marked_read: number }>(
      `${this.baseUrl}/${conversationId}/read`,
      {},
    );
  }
  getUnreadCount(): Observable<{ unread_count: number }> {
    return this.http.get<{ unread_count: number }>(
      `${this.baseUrl}/unread/count`,
    );
  }
  /** Start listening for events. Call once when entering an authenticated area. */
  connect(): void {
    if (!this.auth.getToken()) {
      this.disconnect();
      return;
    }
    this.shouldReconnect = true;
    if (this.socket || this.reconnectTimer) {
      return;
    }
    this.openSocket();
  }
  /** Stop and clean up the connection (especially on logout). */
  disconnect(): void {
    this.shouldReconnect = false;
    this.generation++;
    this.retryCount = 0;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const current = this.socket;
    this.socket = null;
    if (current) {
      current.onopen = null;
      current.onmessage = null;
      current.onerror = null;
      current.onclose = null;
      current.close();
    }
    this.stateSubject.next('disconnected');
  }
  ngOnDestroy(): void {
    this.disconnect();
    this.eventsSubject.complete();
    this.stateSubject.complete();
  }
  private openSocket(): void {
    const token = this.auth.getToken();
    if (!this.shouldReconnect || !token) {
      this.disconnect();
      return;
    }
    // Turns http(s):// into ws(s):// without exposing the JWT in the URL.
    const wsUrl = this.baseUrl.replace(/^http/i, 'ws') + '/ws';
    const generation = ++this.generation;
    this.stateSubject.next(this.retryCount ? 'reconnecting' : 'connecting');
    let socket: WebSocket;
    try {
      socket = new WebSocket(wsUrl);
    } catch {
      this.scheduleReconnect(generation);
      return;
    }
    this.socket = socket;
    let authenticated = false;
    socket.onopen = () => {
      if (generation !== this.generation) return;
      socket.send(JSON.stringify({ type: 'auth', token }));
    };
    socket.onmessage = (event: MessageEvent) => {
      if (generation !== this.generation) return;
      try {
        const payload: unknown = JSON.parse(String(event.data));
        if (!this.isChatEvent(payload)) return;
        if (payload.type === 'authenticated') {
          authenticated = true;
          this.retryCount = 0;
          this.stateSubject.next('connected');
        }
        if (authenticated) this.eventsSubject.next(payload);
      } catch {
        // Ignore malformed server frames instead of breaking the subscription.
      }
    };
    socket.onerror = () => {
      // onclose handles retries; do not duplicate reconnection attempts.
    };
    socket.onclose = (event: CloseEvent) => {
      if (generation !== this.generation) return;
      this.socket = null;
      // 1008 = policy violation, including invalid or expired JWT.
      // Do not retry indefinitely with the same invalid token.
      if (event.code === 1008) {
        this.shouldReconnect = false;
        this.stateSubject.next('disconnected');
        return;
      }
      this.scheduleReconnect(generation);
    };
  }
  private scheduleReconnect(generation: number): void {
    if (generation !== this.generation || !this.shouldReconnect) return;
    if (!this.auth.getToken()) {
      this.disconnect();
      return;
    }
    if (this.reconnectTimer) return;
    this.stateSubject.next('reconnecting');
    const delay = Math.min(1000 * 2 ** Math.min(this.retryCount, 5), 30000);
    this.retryCount++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (generation === this.generation && this.shouldReconnect) {
        this.openSocket();
      }
    }, delay);
  }
  private isChatEvent(value: unknown): value is ChatRealtimeEvent {
    if (!value || typeof value !== 'object' || !('type' in value)) {
      return false;
    }
    const type = (value as { type: unknown }).type;
    return (
      type === 'authenticated' ||
      type === 'conversation_started' ||
      type === 'new_message' ||
      type === 'messages_read' ||
      type === 'pong'
    );
  }
}