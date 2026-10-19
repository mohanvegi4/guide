import { DatePipe } from '@angular/common';
import { Component, effect, inject, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { Observable, forkJoin } from 'rxjs';
import { ApiService, describeError } from '../core/api.service';
import { AuthService } from '../core/auth.service';
import { PlatformAdmin, PlatformOrg } from '../core/models';
import { runRequest } from '../core/request';

/**
 * Guide Engine administration (platform admins only): every customer
 * organization with usage, suspension, the global kill switch, and who the
 * platform admins are. Nothing here shows a customer's guides: for that, the
 * organization's owner must grant support access, after which "Open" enters
 * read-only support mode (auth.service enterSupport).
 */
@Component({
  selector: 'app-operator',
  imports: [FormsModule, DatePipe],
  template: `
    <div class="page-header">
      <div>
        <h1>Guide Engine administration</h1>
        <p class="muted small">
          Every organization on this Guide Engine. Customers' guides stay private unless they grant support
          access.
        </p>
      </div>
      <label class="switch big" [title]="'Global kill switch: off stops every guide for every customer'">
        <input
          type="checkbox"
          [checked]="killSwitch()"
          [disabled]="busy()"
          (change)="setKillSwitch($any($event.target).checked)"
          aria-label="Guides on for everyone"
        />
        <span>{{ killSwitch() ? 'Guides on for everyone' : 'ALL GUIDES OFF' }}</span>
      </label>
    </div>

    @if (error()) {
      <p class="error" role="alert">{{ error() }}</p>
    }
    @if (message()) {
      <p class="success" role="status">{{ message() }}</p>
    }

    @if (loading()) {
      <p class="muted">Loading…</p>
    } @else {
      <table class="table">
        <thead>
          <tr>
            <th>Organization</th>
            <th>Owners</th>
            <th>Apps</th>
            <th>Guides</th>
            <th>Events (30d)</th>
            <th>Status</th>
            <th>Support access</th>
            <th><span class="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          @for (o of orgs(); track o.id) {
            <tr>
              <td>
                <strong>{{ o.name }}</strong>
                <div class="muted small">
                  since {{ o.createdAt | date: 'mediumDate' }} · {{ o.usage.members }} member{{
                    o.usage.members === 1 ? '' : 's'
                  }}
                </div>
              </td>
              <td class="small">
                @for (w of o.owners; track w.email) {
                  <div>
                    {{ w.name ?? w.email }}
                    @if (w.name && w.email) {
                      <span class="muted"> {{ w.email }}</span>
                    }
                  </div>
                }
              </td>
              <td class="num">{{ o.usage.apps }}</td>
              <td class="num">{{ o.usage.guides }}</td>
              <td class="num">{{ o.usage.events30d }}</td>
              <td>
                @if (o.suspendedAt) {
                  <span class="badge archived">suspended {{ o.suspendedAt | date: 'shortDate' }}</span>
                } @else {
                  <span class="badge published">active</span>
                }
              </td>
              <td class="small">
                @if (o.supportAccessUntil) {
                  granted until {{ o.supportAccessUntil | date: 'short' }}
                } @else {
                  <span class="muted">not granted</span>
                }
              </td>
              <td>
                <div class="row-actions">
                  <button
                    type="button"
                    (click)="open(o)"
                    [disabled]="busy() || !o.supportAccessUntil || !!o.suspendedAt"
                    [title]="
                      o.supportAccessUntil
                        ? 'View this organization read-only (logged)'
                        : 'The owner has not granted support access'
                    "
                  >
                    Open (read-only)
                  </button>
                  <button
                    type="button"
                    [class.danger]="!o.suspendedAt"
                    (click)="toggleSuspended(o)"
                    [disabled]="busy()"
                  >
                    {{ o.suspendedAt ? 'Lift suspension' : 'Suspend' }}
                  </button>
                </div>
              </td>
            </tr>
          }
        </tbody>
      </table>
    }

    <section class="card">
      <h2>Platform admins</h2>
      <p class="muted small">
        People who can see this page. Grant by email; they must have signed in to the Studio at least once.
        You can't remove yourself.
      </p>
      <ul class="versions">
        @for (a of admins(); track a.id) {
          <li>
            <span
              ><strong>{{ a.name ?? a.email }}</strong>
              <span class="muted small"
                >{{ a.email }} · last seen {{ a.lastSeenAt | date: 'short' }}</span
              ></span
            >
            <button
              type="button"
              class="link"
              (click)="setAdmin(a.email!, false)"
              [disabled]="busy() || a.id === myId()"
            >
              Remove
            </button>
          </li>
        }
      </ul>
      <form class="inline-form" (submit)="$event.preventDefault(); setAdmin(newAdminEmail, true)">
        <label
          >Email
          <input
            type="email"
            [(ngModel)]="newAdminEmail"
            name="email"
            placeholder="name@company.com"
            required
        /></label>
        <button type="submit" [disabled]="busy() || !newAdminEmail.trim()">Grant admin</button>
      </form>
    </section>
  `,
})
export class OperatorComponent {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  protected readonly orgs = signal<PlatformOrg[]>([]);
  protected readonly admins = signal<PlatformAdmin[]>([]);
  protected readonly killSwitch = signal(true);
  protected readonly loading = signal(true);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly message = signal<string | null>(null);
  protected newAdminEmail = '';
  protected readonly myId = () => this.auth.me()?.user.id;

  constructor() {
    // untracked: the interceptor reads the auth token signal (see guide list).
    effect(() => untracked(() => this.load()));
  }

  private load(): void {
    forkJoin({
      orgs: this.api.platformOrgs(),
      admins: this.api.platformAdmins(),
      kill: this.api.killSwitch(),
    }).subscribe({
      next: ({ orgs, admins, kill }) => {
        this.orgs.set(orgs);
        this.admins.set(admins);
        this.killSwitch.set(kill.enabled);
        this.loading.set(false);
      },
      error: (err) => {
        this.error.set(describeError(err));
        this.loading.set(false);
      },
    });
  }

  setKillSwitch(enabled: boolean): void {
    if (
      !enabled &&
      !confirm('Turn off every guide for every customer? Their visitors see nothing until it is on again.')
    ) {
      this.killSwitch.set(true);
      return;
    }
    this.run(this.api.setKillSwitch(enabled), (r) => {
      this.killSwitch.set(r.enabled);
      this.message.set(r.enabled ? 'Guides are on for everyone.' : 'All guides are off.');
    });
  }

  toggleSuspended(org: PlatformOrg): void {
    const suspend = !org.suspendedAt;
    if (suspend && !confirm(`Suspend ${org.name}? Its apps serve no guides until the suspension is lifted.`))
      return;
    this.run(this.api.setOrgSuspended(org.id, suspend), (r) => {
      this.orgs.update((list) =>
        list.map((o) => (o.id === org.id ? { ...o, suspendedAt: r.suspendedAt } : o)),
      );
      this.message.set(suspend ? `${org.name} is suspended.` : `${org.name} is active again.`);
    });
  }

  /** Enters read-only support mode for the organization (it must have granted access). */
  async open(org: PlatformOrg): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    const failure = await this.auth.enterSupport(org.id);
    this.busy.set(false);
    if (failure) {
      this.error.set(failure);
      return;
    }
    const first = this.auth.org(org.id)?.apps[0];
    void this.router.navigate(first ? ['/o', org.id, 'apps', first.id, 'guides'] : ['/o', org.id, 'apps']);
  }

  setAdmin(email: string, platformAdmin: boolean): void {
    if (!platformAdmin && !confirm(`Remove platform admin access from ${email}?`)) return;
    this.run(this.api.setPlatformAdmin(email.trim(), platformAdmin), () => {
      this.newAdminEmail = '';
      this.message.set(
        platformAdmin ? `${email} is now a platform admin.` : `${email} is no longer a platform admin.`,
      );
      this.api.platformAdmins().subscribe({ next: (admins) => this.admins.set(admins) });
    });
  }

  private run<T>(obs: Observable<T>, onOk: (value: T) => void): void {
    runRequest({ busy: this.busy, error: this.error, message: this.message }, obs, onOk);
  }
}
