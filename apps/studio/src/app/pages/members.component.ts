import { DatePipe } from '@angular/common';
import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { Observable } from 'rxjs';
import { ApiService, describeError } from '../core/api.service';
import { AuthService } from '../core/auth.service';
import { saveResponseAsFile } from '../core/download';
import { Invitation, Member, ORG_ROLES, OrgRole, SupportAccess, isOrgManager, roleLabel } from '../core/models';

/**
 * People in an organization. One role per person, for every site:
 * owner > manager > editor > viewer (see ORG_ROLES). Owners and managers
 * manage members and invitations; only owners hand out or take away "owner".
 */
@Component({
  selector: 'app-members',
  imports: [FormsModule, DatePipe],
  template: `
    <div class="page-header">
      <div>
        <h1>Members</h1>
        <p class="muted small">One role per person, for every site in the organization.</p>
      </div>
    </div>
    @if (error()) {
      <p class="error" role="alert">{{ error() }}</p>
    }

    <table class="table">
      <thead>
        <tr>
          <th>Person</th>
          <th>Role</th>
          <th>What they can do</th>
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
              @if (admin() && (m.orgRole !== 'owner' || owner())) {
                <select
                  [ngModel]="m.orgRole"
                  (ngModelChange)="setOrgRole(m, $event)"
                  [attr.aria-label]="'Organization role for ' + (m.name ?? m.email)"
                >
                  @for (r of orgRoles(); track r.role) {
                    <option [value]="r.role">{{ r.label }}</option>
                  }
                </select>
              } @else {
                {{ roleLabel(m.orgRole) }}
              }
            </td>
            <td class="muted small">{{ roleDescription(m.orgRole) }}</td>
            <td>
              @if (m.userId === myId() || (admin() && (m.orgRole !== 'owner' || owner()))) {
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
          @if (mailEnabled()) {
            Enter an email and we'll send them the invitation (valid 7 days, single use); only that person can
            use it. Without an email you'll get a link to send yourself.
          } @else {
            You'll get a link to send them (valid 7 days, single use). If you enter an email, only that person
            can use it.
          }
        </p>
        <form class="invite-form" (ngSubmit)="invite()">
          <label>Email (optional) <input name="email" type="email" [(ngModel)]="inviteEmail" /></label>
          <label
            >Role
            <select name="orgRole" [(ngModel)]="inviteOrgRole">
              @for (r of invitableRoles; track r.role) {
                <option [value]="r.role">{{ r.label }}</option>
              }
            </select>
          </label>
          <span class="muted small">{{ roleDescription(inviteOrgRole) }}</span>
          <button class="primary" [disabled]="busy()">
            {{ mailEnabled() && inviteEmail.trim() ? 'Send invitation' : 'Create invite link' }}
          </button>
        </form>
        @if (emailedTo()) {
          <p class="small" role="status">
            Invitation emailed to <strong>{{ emailedTo() }}</strong> — if it doesn't arrive, send them this
            link:
          </p>
        }
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
                {{ i.email ?? 'anyone with the link' }} · {{ roleLabel(i.org_role) }} · expires
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

    @if (owner()) {
      <section class="card danger-zone">
        <h2>Danger zone</h2>
        <p class="muted small">
          <strong>Export</strong> downloads everything this organization authored as one JSON file: apps
          (never their signing secrets), saved pages, guides with every version, members, pending invitations
          and per-guide totals. Raw visitor events are not included.
        </p>
        <button type="button" (click)="exportData()" [disabled]="busy()">Export organization data</button>
        @if (exported()) {
          <p class="small" role="status">Downloaded {{ exported() }}.</p>
        }
        <h3 class="subhead">Delete organization</h3>
        <p class="muted small">
          Deletes <strong>{{ orgName() }}</strong> with all its apps, guides, pages, analytics, members and
          invitations. Installed snippets stop loading guides immediately. This cannot be undone; export first
          if you may need the data.
        </p>
        <form class="inline-form" (ngSubmit)="deleteOrg()">
          <label>
            Type <strong>{{ orgName() }}</strong> to confirm
            <input name="confirmName" [(ngModel)]="confirmName" autocomplete="off" />
          </label>
          <button type="submit" class="danger" [disabled]="busy() || confirmName !== orgName()">
            Delete organization
          </button>
        </form>
      </section>
    }
  `,
})
export class MembersComponent {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  readonly orgId = input.required<string>();

  protected readonly members = signal<Member[]>([]);
  protected readonly invitations = signal<Invitation[]>([]);
  protected readonly error = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected readonly inviteLink = signal<string | null>(null);
  /** Set when the backend emailed the last invitation (the link is still shown as a fallback). */
  protected readonly emailedTo = signal<string | null>(null);
  protected readonly copied = signal(false);
  protected readonly mailEnabled = computed(() => this.auth.config().mailEnabled);
  protected inviteEmail = '';
  protected inviteOrgRole: Exclude<OrgRole, 'owner'> = 'viewer';
  protected readonly roleLabel = roleLabel;
  protected readonly invitableRoles = ORG_ROLES.filter((r) => r.role !== 'owner');

  protected readonly myId = computed(() => this.auth.me()?.user.id);
  protected readonly admin = computed(() => isOrgManager(this.auth.orgRole(this.orgId())));
  protected readonly owner = computed(() => this.auth.orgRole(this.orgId()) === 'owner');
  protected readonly support = signal<SupportAccess | null>(null);
  protected supportDays = 7;
  protected readonly orgName = computed(() => this.auth.org(this.orgId())?.name ?? '');
  /** The file name of the last export, for the confirmation line. */
  protected readonly exported = signal<string | null>(null);
  protected confirmName = '';
  /** Only owners can hand out or take away "owner". */
  protected readonly orgRoles = computed(() =>
    this.auth.orgRole(this.orgId()) === 'owner' ? ORG_ROLES : ORG_ROLES.filter((r) => r.role !== 'owner'),
  );
  protected roleDescription(role: string): string {
    return ORG_ROLES.find((r) => r.role === role)?.description ?? '';
  }

  constructor() {
    // untracked: load() reads the auth signals (roles, token via the interceptor).
    effect(() => {
      this.orgId();
      untracked(() => this.load());
    });
  }

  private load(): void {
    const orgId = this.orgId();
    this.api.listMembers(orgId).subscribe({
      next: (members) => {
        this.members.set(members);
      },
      error: (err) => this.error.set(describeError(err)),
    });
    if (isOrgManager(this.auth.orgRole(orgId))) {
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

  /** Danger zone: the organization's data as a JSON download (owners). */
  exportData(): void {
    this.busy.set(true);
    this.error.set(null);
    this.api.exportOrg(this.orgId()).subscribe({
      next: (res) => {
        const fallback = `guide-engine-${this.orgName() || 'organization'}.json`;
        saveResponseAsFile(res, fallback);
        this.exported.set(
          res.headers.get('content-disposition')?.match(/filename="?([^";]+)/)?.[1] ?? fallback,
        );
        this.busy.set(false);
      },
      error: (err) => {
        this.error.set(describeError(err));
        this.busy.set(false);
      },
    });
  }

  /** Danger zone: deletes the organization (the typed name is checked again by the backend). */
  deleteOrg(): void {
    if (this.confirmName !== this.orgName()) return;
    this.busy.set(true);
    this.error.set(null);
    this.api.deleteOrg(this.orgId(), this.confirmName).subscribe({
      next: async () => {
        // The org is gone: re-read /me first so the home path no longer points at it.
        await this.auth.refresh();
        this.busy.set(false);
        void this.router.navigateByUrl(this.auth.homePath());
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


  remove(m: Member): void {
    const self = m.userId === this.myId();
    if (!confirm(self ? 'Leave this organization?' : `Remove ${m.name ?? m.email ?? 'this person'}?`)) return;
    this.run(this.api.removeMember(this.orgId(), m.userId), () => {
      if (self) window.location.assign('/');
    });
  }

  invite(): void {
    this.run(
      this.api.createInvitation(this.orgId(), {
        email: this.inviteEmail.trim() || undefined,
        orgRole: this.inviteOrgRole,
      }),
      (inv) => {
        const created = inv as Invitation & { token: string };
        this.copied.set(false);
        this.inviteLink.set(`${location.origin}/invite/${created.token}`);
        // The backend only reports emailSent when it actually handed the mail
        // to the transport; otherwise the inviter has to send the link.
        this.emailedTo.set(created.emailSent ? created.email : null);
        this.inviteEmail = '';
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
