import { DatePipe } from '@angular/common';
import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Observable, forkJoin } from 'rxjs';
import { ApiService, describeError } from '../core/api.service';
import { AuthService } from '../core/auth.service';
import {
  APP_ROLES,
  App,
  AppRole,
  Invitation,
  Member,
  OrgRole,
  SupportAccess,
  isOrgAdmin,
} from '../core/models';

/**
 * People in an organization. Org admins/owners manage everyone; per-app roles:
 * viewer < editor (drafts, previews) < publisher (go live) < app admin (settings).
 * Org owners and admins can do everything in every app.
 */
@Component({
  selector: 'app-members',
  imports: [FormsModule, DatePipe],
  template: `
    <div class="page-header">
      <div>
        <h1>Members</h1>
        <p class="muted small">Owners and admins manage every app. Members get a role per app.</p>
      </div>
    </div>
    @if (error()) {
      <p class="error" role="alert">{{ error() }}</p>
    }

    <table class="table">
      <thead>
        <tr>
          <th>Person</th>
          <th>Organization role</th>
          @for (a of apps(); track a.id) {
            <th>{{ a.name }}</th>
          }
          <th></th>
        </tr>
      </thead>
      <tbody>
        @for (m of members(); track m.userId) {
          <tr>
            <td>
              <strong>{{ m.name ?? m.email ?? m.userId }}</strong>
              @if (m.email && m.name) {
                <div class="muted small">{{ m.email }}</div>
              }
              @if (m.userId === myId()) {
                <div class="muted small">you</div>
              }
            </td>
            <td>
              @if (admin()) {
                <select
                  [ngModel]="m.orgRole"
                  (ngModelChange)="setOrgRole(m, $event)"
                  [attr.aria-label]="'Organization role for ' + (m.name ?? m.email)"
                >
                  @for (r of orgRoles(); track r) {
                    <option [value]="r">{{ r }}</option>
                  }
                </select>
              } @else {
                {{ m.orgRole }}
              }
            </td>
            @for (a of apps(); track a.id) {
              <td>
                @if (m.orgRole !== 'member') {
                  <span class="muted small">all</span>
                } @else if (admin()) {
                  <select
                    [ngModel]="m.appRoles[a.id] ?? ''"
                    (ngModelChange)="setAppRole(m, a.id, $event)"
                    [attr.aria-label]="a.name + ' role'"
                  >
                    <option value="">no access</option>
                    @for (r of appRoles; track r) {
                      <option [value]="r">{{ r }}</option>
                    }
                  </select>
                } @else {
                  {{ m.appRoles[a.id] ?? '—' }}
                }
              </td>
            }
            <td>
              @if (admin() || m.userId === myId()) {
                <button type="button" class="link" (click)="remove(m)">
                  {{ m.userId === myId() ? 'Leave' : 'Remove' }}
                </button>
              }
            </td>
          </tr>
        }
      </tbody>
    </table>

    @if (admin()) {
      <section class="card">
        <h2>Invite someone</h2>
        <p class="muted small">
          You'll get a link to send them (valid 7 days, single use). If you enter an email, only that person
          can use it.
        </p>
        <form class="invite-form" (ngSubmit)="invite()">
          <label>Email (optional) <input name="email" type="email" [(ngModel)]="inviteEmail" /></label>
          <label
            >Organization role
            <select name="orgRole" [(ngModel)]="inviteOrgRole">
              <option value="member">member</option>
              <option value="admin">admin</option>
            </select>
          </label>
          @if (inviteOrgRole === 'member') {
            @for (a of apps(); track a.id) {
              <label
                >{{ a.name }}
                <select [name]="'app-' + a.id" [(ngModel)]="inviteAppRoles[a.id]">
                  <option [ngValue]="undefined">no access</option>
                  @for (r of appRoles; track r) {
                    <option [value]="r">{{ r }}</option>
                  }
                </select>
              </label>
            }
          }
          <button class="primary" [disabled]="busy()">Create invite link</button>
        </form>
        @if (inviteLink()) {
          <div class="preview-link">
            <input
              class="mono"
              [value]="inviteLink()"
              readonly
              aria-label="Invite link"
              (focus)="$any($event.target).select()"
            />
            <button type="button" (click)="copyInvite()">{{ copied() ? 'Copied ✓' : 'Copy link' }}</button>
          </div>
        }
        @if (invitations().length) {
          <h3 class="subhead">Pending invitations</h3>
          <ul class="plain">
            @for (i of invitations(); track i.id) {
              <li>
                {{ i.email ?? 'anyone with the link' }} · {{ i.org_role }} · expires
                {{ i.expires_at | date: 'mediumDate' }}
                <button type="button" class="link" (click)="revoke(i)">revoke</button>
              </li>
            }
          </ul>
        }
      </section>

      <section class="card">
        <div class="section-head">
          <h2>Guide Engine support access</h2>
          @if (support(); as s) {
            @if (s.active) {
              <span class="badge published">open until {{ s.until | date: 'short' }}</span>
            } @else {
              <span class="badge">off</span>
            }
          }
        </div>
        <p class="muted small">
          Guide Engine's support team can't see your organization unless you let them. Open a window and they
          can view your guides, pages, analytics and members <strong>read-only</strong> for that time; every
          page they open is listed below. It closes by itself on the date you choose.
        </p>
        @if (support(); as s) {
          @if (s.active && s.grantedBy) {
            <p class="small muted">Granted by {{ s.grantedBy.name ?? s.grantedBy.email }}.</p>
          }
          @if (owner()) {
            <div class="inline-form">
              <label>
                Open for
                <select [(ngModel)]="supportDays" name="supportDays" aria-label="Support access duration">
                  <option [ngValue]="1">1 day</option>
                  <option [ngValue]="7">7 days</option>
                  <option [ngValue]="30">30 days</option>
                  <option [ngValue]="90">90 days (maximum)</option>
                </select>
              </label>
              <button type="button" (click)="grantSupport()" [disabled]="busy()">
                {{ s.active ? 'Extend' : 'Grant access' }}
              </button>
              @if (s.active) {
                <button type="button" class="danger" (click)="revokeSupport()" [disabled]="busy()">
                  Close now
                </button>
              }
            </div>
          } @else {
            <p class="small muted">Only owners can open or close support access.</p>
          }
          @if (s.log.length) {
            <h3 class="subhead">Access log</h3>
            <table class="table compact">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Who</th>
                  <th>What</th>
                </tr>
              </thead>
              <tbody>
                @for (l of s.log; track l.occurredAt + l.path) {
                  <tr>
                    <td>{{ l.occurredAt | date: 'short' }}</td>
                    <td>{{ l.admin.name ?? l.admin.email ?? 'Guide Engine support' }}</td>
                    <td>
                      <code>{{ l.method }} {{ l.path }}</code>
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          } @else if (s.active) {
            <p class="small muted">No access yet.</p>
          }
        }
      </section>
    }
  `,
})
export class MembersComponent {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  readonly orgId = input.required<string>();

  protected readonly appRoles = APP_ROLES;
  protected readonly members = signal<Member[]>([]);
  protected readonly apps = signal<App[]>([]);
  protected readonly invitations = signal<Invitation[]>([]);
  protected readonly error = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected readonly inviteLink = signal<string | null>(null);
  protected readonly copied = signal(false);
  protected inviteEmail = '';
  protected inviteOrgRole: 'admin' | 'member' = 'member';
  protected inviteAppRoles: Record<string, AppRole | undefined> = {};

  protected readonly myId = computed(() => this.auth.me()?.user.id);
  protected readonly admin = computed(() => isOrgAdmin(this.auth.orgRole(this.orgId())));
  protected readonly owner = computed(() => this.auth.orgRole(this.orgId()) === 'owner');
  protected readonly support = signal<SupportAccess | null>(null);
  protected supportDays = 7;
  /** Only owners can hand out or take away "owner". */
  protected readonly orgRoles = computed<OrgRole[]>(() =>
    this.auth.orgRole(this.orgId()) === 'owner' ? ['owner', 'admin', 'member'] : ['admin', 'member'],
  );

  constructor() {
    // untracked: load() reads the auth signals (roles, token via the interceptor).
    effect(() => {
      this.orgId();
      untracked(() => this.load());
    });
  }

  private load(): void {
    const orgId = this.orgId();
    forkJoin({ members: this.api.listMembers(orgId), apps: this.api.listApps(orgId) }).subscribe({
      next: ({ members, apps }) => {
        this.members.set(members);
        this.apps.set(apps);
      },
      error: (err) => this.error.set(describeError(err)),
    });
    if (isOrgAdmin(this.auth.orgRole(orgId))) {
      this.api.listInvitations(orgId).subscribe({ next: (i) => this.invitations.set(i) });
      this.api.getSupportAccess(orgId).subscribe({ next: (s) => this.support.set(s) });
    }
  }

  grantSupport(): void {
    this.busy.set(true);
    this.api.grantSupportAccess(this.orgId(), this.supportDays).subscribe({
      next: (s) => {
        this.support.set(s);
        this.busy.set(false);
      },
      error: (err) => {
        this.error.set(describeError(err));
        this.busy.set(false);
      },
    });
  }

  revokeSupport(): void {
    if (
      !confirm(
        'Close support access now? Guide Engine support will no longer be able to see this organization.',
      )
    )
      return;
    this.busy.set(true);
    this.api.revokeSupportAccess(this.orgId()).subscribe({
      next: (s) => {
        this.support.set(s);
        this.busy.set(false);
      },
      error: (err) => {
        this.error.set(describeError(err));
        this.busy.set(false);
      },
    });
  }

  setOrgRole(m: Member, role: OrgRole): void {
    this.run(this.api.updateMember(this.orgId(), m.userId, { orgRole: role }));
  }

  setAppRole(m: Member, appId: string, role: AppRole | ''): void {
    this.run(this.api.updateMember(this.orgId(), m.userId, { appRoles: { [appId]: role || null } }));
  }

  remove(m: Member): void {
    const self = m.userId === this.myId();
    if (!confirm(self ? 'Leave this organization?' : `Remove ${m.name ?? m.email ?? 'this person'}?`)) return;
    this.run(this.api.removeMember(this.orgId(), m.userId), () => {
      if (self) window.location.assign('/');
    });
  }

  invite(): void {
    const appRoles = Object.fromEntries(
      Object.entries(this.inviteAppRoles).filter((e): e is [string, AppRole] => Boolean(e[1])),
    );
    this.run(
      this.api.createInvitation(this.orgId(), {
        email: this.inviteEmail.trim() || undefined,
        orgRole: this.inviteOrgRole,
        appRoles: this.inviteOrgRole === 'member' ? appRoles : {},
      }),
      (inv) => {
        this.copied.set(false);
        this.inviteLink.set(`${location.origin}/invite/${(inv as { token: string }).token}`);
        this.inviteEmail = '';
        this.inviteAppRoles = {};
      },
    );
  }

  revoke(i: Invitation): void {
    this.run(this.api.revokeInvitation(this.orgId(), i.id));
  }

  copyInvite(): void {
    const link = this.inviteLink();
    if (link) void navigator.clipboard?.writeText(link).then(() => this.copied.set(true));
  }

  private run(obs: Observable<unknown>, onOk?: (value: unknown) => void): void {
    this.busy.set(true);
    this.error.set(null);
    obs.subscribe({
      next: (v) => {
        this.busy.set(false);
        onOk?.(v);
        this.load();
        void this.auth.refresh();
      },
      error: (err) => {
        this.busy.set(false);
        this.error.set(describeError(err));
        this.load(); // put selects back to what the server has
      },
    });
  }
}
