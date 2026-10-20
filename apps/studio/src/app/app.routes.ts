import { Routes } from '@angular/router';
import { inject } from '@angular/core';
import { appRole, orgMember, platformAdmin, signedIn } from './core/auth.guard';
import { AuthService } from './core/auth.service';
import { LoginComponent } from './pages/login.component';
import { AuthCallbackComponent } from './pages/auth-callback.component';

// Route params (:orgId, :appId, :id, :token) are bound to component inputs
// (withComponentInputBinding in app.config.ts); that works the same for lazy routes.
//
// Only the sign-in pages are eager: everything a signed-in author lands on is
// `loadComponent`, so each page is its own chunk and the initial bundle stays
// within the budget in angular.json (the guide editor alone is the largest page).
export const routes: Routes = [
  { path: 'login', component: LoginComponent, title: 'Sign in · Guide Studio' },
  { path: 'auth/callback', component: AuthCallbackComponent, title: 'Signing in · Guide Studio' },
  {
    path: 'welcome',
    loadComponent: () => import('./pages/onboarding.component').then((m) => m.OnboardingComponent),
    canActivate: [signedIn],
    title: 'Welcome · Guide Studio',
  },
  {
    path: 'invite/:token',
    loadComponent: () => import('./pages/invite.component').then((m) => m.InviteComponent),
    canActivate: [signedIn],
    title: 'Invitation · Guide Studio',
  },
  {
    path: 'operator',
    loadComponent: () => import('./pages/operator.component').then((m) => m.OperatorComponent),
    canActivate: [platformAdmin],
    title: 'Administration · Guide Studio',
  },
  {
    path: 'o/:orgId',
    canActivate: [orgMember],
    children: [
      {
        path: 'apps',
        loadComponent: () => import('./pages/apps.component').then((m) => m.AppsComponent),
        title: 'Applications · Guide Studio',
      },
      {
        path: 'members',
        loadComponent: () => import('./pages/members.component').then((m) => m.MembersComponent),
        title: 'Members · Guide Studio',
      },
      {
        path: 'apps/:appId/guides',
        loadComponent: () => import('./pages/guide-list.component').then((m) => m.GuideListComponent),
        canActivate: [appRole('viewer')],
        title: 'Guides · Guide Studio',
      },
      {
        path: 'apps/:appId/guides/:id',
        loadComponent: () => import('./pages/guide-editor.component').then((m) => m.GuideEditorComponent),
        canActivate: [appRole('viewer')],
        title: 'Edit guide · Guide Studio',
      },
      {
        path: 'apps/:appId/pages',
        loadComponent: () => import('./pages/pages.component').then((m) => m.PagesComponent),
        canActivate: [appRole('viewer')],
        title: 'Pages · Guide Studio',
      },
      {
        path: 'apps/:appId/settings',
        loadComponent: () => import('./pages/app-settings.component').then((m) => m.AppSettingsComponent),
        // Every member may read the install instructions; the settings themselves render for app admins only.
        canActivate: [appRole('viewer')],
        title: 'App settings · Guide Studio',
      },
      { path: '', pathMatch: 'full', redirectTo: 'apps' },
    ],
  },
  { path: '', pathMatch: 'full', redirectTo: () => inject(AuthService).homePath() },
  { path: '**', redirectTo: () => inject(AuthService).homePath() },
];
