
import { Injectable } from '@angular/core';
import {
  Haptics,
  ImpactStyle,
  NotificationType,
} from '@capacitor/haptics';
import { Capacitor } from '@capacitor/core';

@Injectable({
  providedIn: 'root',
})
export class HapticsService {
  async lightImpact(): Promise<void> {
    if (!Capacitor.isNativePlatform()) {
      this.vibrateFallback(20);
      return;
    }

    try {
      await Haptics.impact({ style: ImpactStyle.Light });
    } catch (error) {
      console.warn('Light haptic feedback unavailable:', error);
    }
  }

  async success(): Promise<void> {
    if (!Capacitor.isNativePlatform()) {
      this.vibrateFallback([30, 40, 30]);
      return;
    }

    try {
      await Haptics.notification({
        type: NotificationType.Success,
      });
    } catch (error) {
      console.warn('Success haptic feedback unavailable:', error);
    }
  }

  async warning(): Promise<void> {
    if (!Capacitor.isNativePlatform()) {
      this.vibrateFallback([50, 50, 50]);
      return;
    }

    try {
      await Haptics.notification({
        type: NotificationType.Warning,
      });
    } catch (error) {
      console.warn('Warning haptic feedback unavailable:', error);
    }
  }

  private vibrateFallback(
    pattern: number | number[],
  ): void {
    if (
      typeof navigator !== 'undefined' &&
      typeof navigator.vibrate === 'function'
    ) {
      navigator.vibrate(pattern);
    }
  }
}
