
import { bootstrapApplication } from '@angular/platform-browser';
import {
  RouteReuseStrategy,
  provideRouter,
  withComponentInputBinding,
  withPreloading,
  PreloadAllModules,
} from '@angular/router';
import {
  provideHttpClient,
  withInterceptors,
} from '@angular/common/http';
import { IonicRouteStrategy, provideIonicAngular } from '@ionic/angular';
import { addIcons } from 'ionicons';
import {
  arrowBackOutline,
  documentTextOutline,
  locationOutline,
  calendarOutline,
  notificationsOutline,
  handLeftOutline,
  checkmarkCircleOutline,
  closeCircleOutline,
  checkmarkDoneCircleOutline,
  notificationsOffOutline,
} from 'ionicons/icons';

import { routes } from './app/app.routes';
import { AppComponent } from './app/app.component';
import { authInterceptor } from './app/services/auth.interceptor';


addIcons({
  'arrow-back-outline': arrowBackOutline,
  'document-text-outline': documentTextOutline,
  'location-outline': locationOutline,
  'calendar-outline': calendarOutline,
  'notifications-outline': notificationsOutline,
  'hand-left-outline': handLeftOutline,
  'checkmark-circle-outline': checkmarkCircleOutline,
  'close-circle-outline': closeCircleOutline,
  'checkmark-done-circle-outline': checkmarkDoneCircleOutline,
  'notifications-off-outline': notificationsOffOutline,
});

bootstrapApplication(AppComponent, {
  providers: [
    { provide: RouteReuseStrategy, useClass: IonicRouteStrategy },
    provideIonicAngular(),
    provideRouter(
      routes,
      withPreloading(PreloadAllModules),
      withComponentInputBinding(),
    ),
    provideHttpClient(
      withInterceptors([authInterceptor]),
    ),
  ],
});
