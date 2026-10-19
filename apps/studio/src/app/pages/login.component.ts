import { Component, inject, signal } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { AuthService } from '../core/auth.service';

@Component({
  selector: 'app-login',
  imports: [FormsModule, NgTemplateOutlet],
  template: `
    <section class="card narrow">
      <h1>Sign in to Guide Studio</h1>
      @if (expired) {
        <p class="notice">Your session expired or was rejected. Please sign in again.</p>
      }
      @if (error()) {
        <p class="error" role="alert">{{ error() }}</p>
      }

      @if (auth.config().oidc) {
        <button type="button" class="primary sso" (click)="sso()" [disabled]="busy()">Sign in with SSO</button>
      }

      @if (auth.config().tokenPaste) {
        @if (auth.config().oidc) {
          <details class="dev-login">
            <summary>Developer sign-in (paste a token)</summary>
            <ng-container *ngTemplateOutlet="paste" />
          </details>
        } @else {
          <ng-container *ngTemplateOutlet="paste" />
        }
      }

      <ng-template #paste>
        <p class="muted">For local development, mint a token from <code>packages/backend</code>:</p>
        <pre class="snippet">npm run mint-token -- --tenant &lt;tenant-uuid&gt; --user you --role guide_admin[,platform_admin]</pre>
        <form (ngSubmit)="submit()">
          <label for="token">Bearer token</label>
          <textarea id="token" name="token" rows="5" [(ngModel)]="token" required spellcheck="false"></textarea>
          <button type="submit" [class.primary]="!auth.config().oidc" [disabled]="!token.trim() || busy()">Sign in</button>
        </form>
      </ng-template>
    </section>
  `,
})
export class LoginComponent {
  protected readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly params = inject(ActivatedRoute).snapshot.queryParamMap;
  protected readonly expired = this.params.has('expired');
  protected token = '';
  protected readonly error = signal<string | null>(this.params.get('error'));
  protected readonly busy = signal(false);

  async submit(): Promise<void> {
    this.busy.set(true);
    const err = await this.auth.loginWithToken(this.token);
    this.busy.set(false);
    this.error.set(err);
    if (!err) void this.router.navigateByUrl(this.auth.homePath());
  }

  async sso(): Promise<void> {
    this.busy.set(true);
    try {
      await this.auth.signInWithSso(this.params.get('returnUrl') ?? '/');
    } catch {
      this.busy.set(false);
      this.error.set('Could not reach the identity provider.');
    }
  }
}
