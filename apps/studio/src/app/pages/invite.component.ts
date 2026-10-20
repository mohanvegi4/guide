import { Component, effect, inject, input, signal, untracked } from '@angular/core';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiService, describeError } from '../core/api.service';
import { AuthService } from '../core/auth.service';
import { InvitationPreview, ORG_ROLES, roleLabel } from '../core/models';

/** /invite/:token — shows what you're invited to and lets you accept. */
@Component({
  selector: 'app-invite',
  template: `
    <section class="card narrow">
      @if (invitation(); as inv) {
        <h1>Join {{ inv.orgName }}</h1>
        @if (inv.accepted) {
          <p class="notice">This invitation has already been used.</p>
        } @else if (inv.expired) {
          <p class="notice">This invitation has expired. Ask for a new one.</p>
        } @else {
          <p>
            You're invited as <strong>{{ roleLabel(inv.orgRole) }}</strong>: {{ roleDescription(inv.orgRole) }}
          </p>
          @if (inv.email) { <p class="muted small">For {{ inv.email }}.</p> }
          <button class="primary" (click)="accept()" [disabled]="busy()">Accept invitation</button>
        }
      } @else if (!error()) {
        <p class="muted">Loading invitation…</p>
      }
      @if (error()) {
        <p class="error" role="alert">{{ error() }}</p>
      }
    </section>
  `,
})
export class InviteComponent {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  readonly token = input.required<string>();
  protected readonly invitation = signal<InvitationPreview | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected readonly roleLabel = roleLabel;
  protected roleDescription(role: string): string {
    return ORG_ROLES.find((r) => r.role === role)?.description ?? '';
  }

  constructor() {
    // untracked: the interceptor reads the auth token signal (see guide list).
    effect(() => {
      const token = this.token();
      untracked(() =>
        this.api.getInvitation(token).subscribe({
          next: (inv) => this.invitation.set(inv),
          error: (err) => this.error.set(describeError(err)),
        })
      );
    });
  }

  async accept(): Promise<void> {
    this.busy.set(true);
    try {
      const { orgId } = await firstValueFrom(this.api.acceptInvitation(this.token()));
      await this.auth.refresh();
      void this.router.navigate(['/o', orgId, 'apps']);
    } catch (err) {
      this.error.set(describeError(err));
      this.busy.set(false);
    }
  }
}
