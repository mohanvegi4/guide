import { Routes } from '@angular/router';
import { inject } from '@angular/core';
import { roleGuard } from './core/auth.guard';
import { AuthService } from './core/auth.service';
import { GUIDE_ADMIN, PLATFORM_ADMIN } from './core/models';
import { LoginComponent } from './pages/login.component';
import { AuthCallbackComponent } from './pages/auth-callback.component';
import { GuideListComponent } from './pages/guide-list.component';
import { GuideEditorComponent } from './pages/guide-editor.component';

// The same list/editor components serve both scopes; `scope` in route data
// picks the API (/guides vs /platform/guides).
export const routes: Routes = [
  { path: 'login', component: LoginComponent, title: 'Sign in · Guide Studio' },
  { path: 'auth/callback', component: AuthCallbackComponent, title: 'Signing in · Guide Studio' },
  {
    path: 'guides',
    component: GuideListComponent,
    canActivate: [roleGuard(GUIDE_ADMIN)],
    data: { scope: 'tenant' },
    title: 'Guides · Guide Studio',
  },
  {
    path: 'guides/:id',
    component: GuideEditorComponent,
    canActivate: [roleGuard(GUIDE_ADMIN)],
    data: { scope: 'tenant' },
    title: 'Edit guide · Guide Studio',
  },
  {
    path: 'global',
    component: GuideListComponent,
    canActivate: [roleGuard(PLATFORM_ADMIN)],
    data: { scope: 'global' },
    title: 'Global guides · Guide Studio',
  },
  {
    path: 'global/:id',
    component: GuideEditorComponent,
    canActivate: [roleGuard(PLATFORM_ADMIN)],
    data: { scope: 'global' },
    title: 'Edit global guide · Guide Studio',
  },
  { path: '', pathMatch: 'full', redirectTo: () => inject(AuthService).homePath() },
  { path: '**', redirectTo: () => inject(AuthService).homePath() },
];
