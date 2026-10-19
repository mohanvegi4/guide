import { Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiService, describeError } from '../core/api.service';
import { AuthService } from '../core/auth.service';
import { parseWebsites } from './websites';

/** First sign-in with no organization yet: create one, with its first app. */
@Component({
  selector: 'app-onboarding',
  imports: [ReactiveFormsModule],
  template: `
    <section class="card narrow">
      <h1>Welcome to Guide Studio</h1>
      <p class="muted">
        Create your organization and the first application you want to add guides to. You can add more apps and
        invite teammates later.
      </p>
      <form [formGroup]="form" (ngSubmit)="create()">
        <label>Organization name <input formControlName="org" placeholder="e.g. Acme Inc." /></label>
        <label>First application <input formControlName="app" placeholder="e.g. Acme web app" /></label>
        <label>
          Website(s) where the app runs — one per line
          <textarea formControlName="websites" rows="3" placeholder="https://app.acme.com&#10;http://localhost:4200"></textarea>
          <small class="muted">Guides only load on these sites. You can change this later.</small>
        </label>
        @if (error()) {
          <p class="error" role="alert">{{ error() }}</p>
        }
        <button class="primary" [disabled]="form.invalid || busy()">Create organization</button>
      </form>
    </section>
  `,
})
export class OnboardingComponent {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly form = inject(FormBuilder).nonNullable.group({
    org: ['', [Validators.required, Validators.maxLength(200)]],
    app: ['', [Validators.required, Validators.maxLength(200)]],
    websites: ['', Validators.required],
  });

  async create(): Promise<void> {
    const v = this.form.getRawValue();
    const websites = parseWebsites(v.websites);
    if (typeof websites === 'string') {
      this.error.set(websites);
      return;
    }
    this.busy.set(true);
    try {
      const res = await firstValueFrom(this.api.createOrg(v.org.trim(), { name: v.app.trim(), websites }));
      await this.auth.refresh();
      // Straight to the install snippet: that's the next thing they need.
      void this.router.navigate(['/o', res.org.id, 'apps', res.app.id, 'settings'], { queryParams: { new: 1 } });
    } catch (err) {
      this.error.set(describeError(err));
      this.busy.set(false);
    }
  }
}
