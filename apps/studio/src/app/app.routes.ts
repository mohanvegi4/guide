import { Routes } from '@angular/router';
import { inject } from '@angular/core';
import { appRole, orgMember, platformAdmin, signedIn } from './core/auth.guard';
import { AuthService } from './core/auth.service';
import { LoginComponent } from './pages/login.component';
import { AuthCallbackComponent } from './pages/auth-callback.component';
import { OnboardingComponent } from './pages/onboarding.component';
import { InviteComponent } from './pages/invite.component';
import { AppsComponent } from './pages/apps.component';
import { AppSettingsComponent } from './pages/app-settings.component';
import { MembersComponent } from './pages/members.component';
import { GuideListComponent } from './pages/guide-list.component';
import { GuideEditorComponent } from './pages/guide-editor.component';
import { PagesComponent } from './pages/pages.component';
import { OperatorComponent } from './pages/operator.component';

// Route params (:orgId, :appId, :id, :token) are bound to component inputs
// (withComponentInputBinding in app.config.ts).
export const routes: Routes = [
  { path: 'login', component: LoginComponent, title: 'Sign in · Guide Studio' },
  { path: 'auth/callback', component: AuthCallbackComponent, title: 'Signing in · Guide Studio' },
  {
    path: 'welcome',
    component: OnboardingComponent,
    canActivate: [signedIn],
    title: 'Welcome · Guide Studio',
  },
  {
    path: 'invite/:token',
    component: InviteComponent,
    canActivate: [signedIn],
    title: 'Invitation · Guide Studio',
  },
  {
    path: 'operator',
    component: OperatorComponent,
    canActivate: [platformAdmin],
    title: 'Administration · Guide Studio',
  },
  {
    path: 'o/:orgId',
    canActivate: [orgMember],
    children: [
      { path: 'apps', component: AppsComponent, title: 'Applications · Guide Studio' },
      { path: 'members', component: MembersComponent, title: 'Members · Guide Studio' },
      {
        path: 'apps/:appId/guides',
        component: GuideListComponent,
        canActivate: [appRole('viewer')],
        title: 'Guides · Guide Studio',
      },
      {
        path: 'apps/:appId/guides/:id',
        component: GuideEditorComponent,
        canActivate: [appRole('viewer')],
        title: 'Edit guide · Guide Studio',
      },
      {
        path: 'apps/:appId/pages',
        component: PagesComponent,
        canActivate: [appRole('viewer')],
        title: 'Pages · Guide Studio',
      },
      {
        path: 'apps/:appId/settings',
        component: AppSettingsComponent,
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
