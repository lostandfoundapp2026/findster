
import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import {
  BehaviorSubject,
  Observable,
  tap,
  map,
  switchMap,
} from 'rxjs';
import { environment } from '../../environments/environment';

export interface AppNotification {
  id: number;
  title: string;
  message: string;
  notification_type: string;
  related_report_id: number | null;
  related_claim_id: number | null;
  is_read: boolean;
  created_at: string | null;
}

export interface NotificationsResponse {
  notifications: AppNotification[];
}

export interface UnreadCountResponse {
  unread_count: number;
}

export interface NotificationActionResponse {
  message: string;
  updated_count?: number;
}

@Injectable({
  providedIn: 'root',
})
export class NotificationsService {
  private readonly apiUrl =
    `${environment.apiBaseUrl}/api/notifications`;

  private readonly unreadCountSubject =
    new BehaviorSubject<number>(0);

  readonly unreadCount$ =
    this.unreadCountSubject.asObservable();

  constructor(private http: HttpClient) {}

  getNotifications(): Observable<NotificationsResponse> {
    return this.http.get<NotificationsResponse>(this.apiUrl).pipe(
      switchMap((response) =>
        this.getUnreadCount().pipe(
          map(() => response),
        ),
      ),
    );
  }

  getUnreadCount(): Observable<UnreadCountResponse> {
    return this.http
      .get<UnreadCountResponse>(`${this.apiUrl}/unread-count`)
      .pipe(
        tap((response) => {
          this.setUnreadCount(response.unread_count ?? 0);
        }),
      );
  }

  markAsRead(
    notificationId: number,
  ): Observable<NotificationActionResponse> {
    return this.http
      .patch<NotificationActionResponse>(
        `${this.apiUrl}/${notificationId}/read`,
        {},
      )
      .pipe(
        switchMap((response) =>
          this.getUnreadCount().pipe(
            map(() => response),
          ),
        ),
      );
  }

  markAllAsRead(): Observable<NotificationActionResponse> {
    return this.http
      .patch<NotificationActionResponse>(
        `${this.apiUrl}/read-all`,
        {},
      )
      .pipe(
        tap((response) => {
          this.setUnreadCount(0);
        }),
      );
  }

  setUnreadCount(count: number): void {
    const safeCount = Number.isFinite(count)
      ? Math.max(0, Math.floor(count))
      : 0;

    this.unreadCountSubject.next(safeCount);
  }
}
