import { Component, effect, inject, input, signal, untracked } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiService, describeError } from '../core/api.service';
import { AuthService } from '../core/auth.service';
import { App, isOrgManager } from '../core/models';
import { parseWebsites } from './websites';

/** An organization's applications. Org admins create apps; everyone sees the apps they can access. */
@Component({
  selector: 'app-apps',
  imports: [RouterLink, ReactiveFormsModule],
  template: `
    <div class="page-header">
      <div>
        <h1>Applications</h1>
        <p class="muted">Each application has its own install snippet, guides and analytics.</p>
      </div>
    </div>

    @if (error()) {
      <p class="error" role="alert">{{ error() }}</p>
    }

    <div class="app-grid">
      @for (a of apps(); track a.id) {
        <article class="card app-card">
          <h2><a [routerLink]="['/o', orgId(), 'apps', a.id, 'guides']">{{ a.name }}</a></h2>
          <p class="muted small">
            {{ a.allowed_origins.length ? a.allowed_origins.join(', ') : 'No websites yet' }}
          </p>
          <p class="small">
            <span class="badge" [class.published]="a.enabled">{{ a.enabled ? 'on' : 'off' }}</span>
            <span class="badge">{{ a.role }}</span>
            @if (a.identity_mode === 'required') { <span class="badge">signed identity</span> }
          </p>
          <div class="toolbar small">
            <a [routerLink]="['/o', orgId(), 'apps', a.id, 'guides']">Guides</a>
            @if (a.role === 'app_admin') {
              <a [routerLink]="['/o', orgId(), 'apps', a.id, 'settings']">Settings &amp; install</a>
            }
          </div>
        </article>
      } @empty {
        <p class="muted">You don't have access to any applications in this organization yet.</p>
      }
    </div>

    @if (canCreate()) {
      <section class="card">
        <h2>New application</h2>
        <form class="inline-form" [formGroup]="form" (ngSubmit)="create()">
          <label>Name <input formControlName="name" placeholder="e.g. Admin console" /></label>
          <label class="grow">Website(s) <input formControlName="websites" placeholder="https://admin.acme.com, http://localhost:4200" /></label>
          <button class="primary" [disabled]="form.invalid || busy()">Create</button>
        </form>
      </section>
    }
  `,
})
export class AppsComponent {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  readonly orgId = input.required<string>();

  protected readonly apps = signal<App[]>([]);
  protected readonly error = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected readonly form = inject(FormBuilder).nonNullable.group({
    name: ['', [Validators.required, Validators.maxLength(200)]],
    websites: [''],
  });

  protected canCreate(): boolean {
    return isOrgManager(this.auth.orgRole(this.orgId()));
  }

  constructor() {
    // untracked: the interceptor reads the auth token signal (see guide list).
    effect(() => {
      const orgId = this.orgId();
      untracked(() =>
        this.api.listApps(orgId).subscribe({
          next: (apps) => this.apps.set(apps),
          error: (err) => this.error.set(describeError(err)),
        })
      );
    });
  }

  async create(): Promise<void> {
    const v = this.form.getRawValue();
    const websites = parseWebsites(v.websites);
    if (typeof websites === 'string') {
      this.error.set(websites);
      return;
    }
    this.busy.set(true);
    try {
      const app = await firstValueFrom(this.api.createApp(this.orgId(), v.name.trim(), websites));
      await this.auth.refresh();
      void this.router.navigate(['/o', this.orgId(), 'apps', app.id, 'settings'], { queryParams: { new: 1 } });
    } catch (err) {
      this.error.set(describeError(err));
      this.busy.set(false);
    }
  }
}
