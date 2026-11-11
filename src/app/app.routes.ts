// Save as: src/app/app.routes.ts
// FINDSTER - FOUR-TAB NAVIGATION ROUTES

import { Routes } from '@angular/router';
import { authGuard } from './guards/auth.guard';

export const routes: Routes = [
  // PUBLIC PAGES
  {
    path: 'login',
    loadComponent: () =>
      import('./pages/login/login.page').then((m) => m.LoginPage),
  },
  {
    path: 'register',
    loadComponent: () =>
      import('./pages/register/register.page').then((m) => m.RegisterPage),
  },
  {
    path: 'forgot-password',
    loadComponent: () =>
      import('./pages/forgot-password/forgot-password.page').then(
        (m) => m.ForgotPasswordPage,
      ),
  },

  // MAIN TABS: HOME, MY REPORTS, MESSAGES, PROFILE
  {
    path: 'tabs',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./tabs/tabs.page').then((m) => m.TabsPage),
    children: [
      {
        path: 'home',
        loadComponent: () =>
          import('./home/home.page').then((m) => m.HomePage),
      },
      {
        path: 'my-reports',
        loadComponent: () =>
          import('./pages/my-reports/my-reports.page').then(
            (m) => m.MyReportsPage,
          ),
      },
      {
        path: 'chat',
        loadComponent: () =>
          import('./pages/chat-inbox/chat-inbox.page').then(
            (m) => m.ChatInboxPage,
          ),
      },
      {
        path: 'profile',
        loadComponent: () =>
          import('./pages/profile/profile.page').then(
            (m) => m.ProfilePage,
          ),
      },
      {
        path: '',
        redirectTo: 'home',
        pathMatch: 'full',
      },
    ],
  },

  // COMPATIBILITY: KEEP EXISTING NAVIGATION AND PUSH LINKS WORKING
  {
    path: 'home',
    redirectTo: 'tabs/home',
    pathMatch: 'full',
  },
  {
    path: 'my-reports',
    redirectTo: 'tabs/my-reports',
    pathMatch: 'full',
  },
  {
    path: 'chat',
    redirectTo: 'tabs/chat',
    pathMatch: 'full',
  },
  {
    path: 'profile',
    redirectTo: 'tabs/profile',
    pathMatch: 'full',
  },

  // FULL-SCREEN FORMS AND DETAIL PAGES
  {
    path: 'create-report',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./pages/create-report/create-report.page').then(
        (m) => m.CreateReportPage,
      ),
  },
  {
    path: 'edit-report/:id',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./pages/edit-report/edit-report.page').then(
        (m) => m.EditReportPage,
      ),
  },
  {
    path: 'report-details/:id',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./pages/report-details/report-details.page').then(
        (m) => m.ReportDetailsPage,
      ),
  },
  {
    path: 'my-claims',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./pages/my-claims/my-claims.page').then(
        (m) => m.MyClaimsPage,
      ),
  },
  {
    path: 'chat/:id',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./pages/chat-conversation/chat-conversation.page').then(
        (m) => m.ChatConversationPage,
      ),
  },
  {
    path: 'notifications',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./pages/notifications/notifications.page').then(
        (m) => m.NotificationsPage,
      ),
  },

  // DEFAULT / UNKNOWN ROUTES
  {
    path: '',
    redirectTo: 'login',
    pathMatch: 'full',
  },
  {
    path: '**',
    redirectTo: 'login',
  },
];