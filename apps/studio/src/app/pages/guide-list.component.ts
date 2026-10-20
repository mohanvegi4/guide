import { DatePipe } from '@angular/common';
import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { ApiService, describeError } from '../core/api.service';
import { AuthService } from '../core/auth.service';
import { AppAnalytics, GUIDE_TYPES, GuideSummary, GuideType, appRoleAtLeast } from '../core/models';

interface OverviewRow {
  guideId: string;
  name: string;
  shown: number;
  completed: number;
  /** Completion rate as a whole percentage. */
  completionPct: number;
  /** Shown, relative to the most-shown guide (for the bar). */
  shownPct: number;
}

@Component({
  selector: 'app-guide-list',
  imports: [RouterLink, ReactiveFormsModule, DatePipe],
  template: `
    <div class="page-header">
      <div>
        <h1>Guides</h1>
      </div>
    </div>

    @if (overview(); as o) {
      <section class="card">
        <div class="section-head">
          <h2>Analytics</h2>
          <span class="muted small">
            Last {{ o.windowDays }} days: {{ o.visitors }} visitor{{ o.visitors === 1 ? '' : 's' }},
            {{ o.accounts }} account{{ o.accounts === 1 ? '' : 's' }}
          </span>
        </div>
        @if (overviewRows().length === 0) {
          <p class="muted small">No events recorded yet.</p>
        } @else {
          <table class="table compact">
            <thead>
              <tr>
                <th>Guide</th>
                <th class="num">Shown</th>
                <th class="num">Completed</th>
                <th class="num">Rate</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              @for (r of overviewRows(); track r.guideId) {
                <tr>
                  <th scope="row" class="step-label" [title]="r.name">
                    <a [routerLink]="[r.guideId]">{{ r.name }}</a>
                  </th>
                  <td class="num">{{ r.shown }}</td>
                  <td class="num">{{ r.completed }}</td>
                  <td class="num">{{ r.completionPct }}%</td>
                  <td class="bar-cell"><div class="bar" [style.width.%]="r.shownPct"></div></td>
                </tr>
              }
            </tbody>
          </table>
        }
      </section>
    }

    @if (canEdit()) {
      <section class="card">
        <h2>New guide</h2>
        <form class="inline-form" [formGroup]="createForm" (ngSubmit)="create()">
          <label>
            Name
            <input formControlName="name" placeholder="e.g. Welcome tour" />
          </label>
          <label>
            Type
            <select formControlName="type">
              @for (t of guideTypes; track t) {
                <option [value]="t">{{ t }}</option>
              }
            </select>
          </label>
          <button type="submit" class="primary" [disabled]="createForm.invalid || creating()">Create</button>
        </form>
      </section>
    }

    @if (error()) {
      <p class="error" role="alert">{{ error() }}</p>
    }

    @if (loading()) {
      <p class="muted">Loading…</p>
    } @else if (guides().length === 0) {
      <p class="muted">{{ canEdit() ? 'No guides yet — create one above.' : 'No guides yet.' }}</p>
    } @else {
      <table class="table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Type</th>
            <th>Status</th>
            <th>Page</th>
            <th>Starts</th>
            <th>Live version</th>
            <th>Updated</th>
            <th>Enabled</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          @for (g of guides(); track g.id) {
            <tr>
              <td>
                <a [routerLink]="[g.id]">{{ g.name }}</a>
              </td>
              <td>{{ g.type }}</td>
              <td>
                <span class="badge" [class]="'badge ' + g.status">{{ g.status }}</span>
              </td>
              <td>{{ g.page_name ?? (g.current_version_id ? 'Custom route' : '—') }}</td>
              <td>
                {{ g.activation === 'manual' ? 'From help center' : g.activation ? 'Automatically' : '—' }}
              </td>
              <td>{{ g.current_version_number ? 'v' + g.current_version_number : '—' }}</td>
              <td>{{ g.updated_at | date: 'short' }}</td>
              <td>
                <label
                  class="switch"
                  [title]="
                    g.current_version_id
                      ? ''
                      : 'Publish a version first — an enabled guide with nothing published shows nothing'
                  "
                >
                  <input
                    type="checkbox"
                    [checked]="g.enabled"
                    [disabled]="pending().has(g.id) || !canPublish()"
                    (change)="toggle(g, $any($event.target).checked)"
                    [attr.aria-label]="'Enable ' + g.name"
                  />
                  <span>{{ g.enabled ? 'On' : 'Off' }}</span>
                </label>
              </td>
              <td>
                @if (canEdit()) {
                  <button
                    type="button"
                    class="link danger"
                    [disabled]="pending().has(g.id)"
                    (click)="remove(g)"
                    [attr.aria-label]="'Delete ' + g.name"
                  >
                    Delete
                  </button>
                }
              </td>
            </tr>
          }
        </tbody>
      </table>
    }
  `,
})
export class GuideListComponent {
  private readonly api = inject(ApiService);
  private readonly router = inject(Router);
  protected readonly guideTypes = GUIDE_TYPES;
  private readonly auth = inject(AuthService);
  readonly orgId = input.required<string>();
  readonly appId = input.required<string>();
  protected readonly canEdit = computed(() => appRoleAtLeast(this.auth.appRole(this.appId()), 'editor'));
  protected readonly canPublish = computed(() =>
    appRoleAtLeast(this.auth.appRole(this.appId()), 'publisher'),
  );

  protected readonly guides = signal<GuideSummary[]>([]);
  /** Null until loaded; the card is hidden (not an error) if the rollup fails. */
  protected readonly overview = signal<AppAnalytics | null>(null);
  /** Guides that were shown at least once, most-shown first (the backend's order). */
  protected readonly overviewRows = computed<OverviewRow[]>(() => {
    const guides = (this.overview()?.guides ?? []).filter((g) => g.shown > 0);
    const max = Math.max(1, ...guides.map((g) => g.shown));
    return guides.map((g) => ({
      guideId: g.guideId,
      name: g.name,
      shown: g.shown,
      completed: g.completed,
      completionPct: Math.round(g.completionRate * 100),
      shownPct: (g.shown / max) * 100,
    }));
  });
  protected readonly loading = signal(true);
  protected readonly creating = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly pending = signal(new Set<string>());

  protected readonly createForm = inject(FormBuilder).nonNullable.group({
    name: ['', [Validators.required, Validators.maxLength(200)]],
    type: ['tooltip' as GuideType, Validators.required],
  });

  constructor() {
    // untracked: the HTTP interceptor reads the auth token signal; without it
    // this effect would re-run (re-fetch) on every token renewal.
    effect(() => {
      const appId = this.appId();
      untracked(() => this.load(appId));
    });
  }

  private load(appId: string): void {
    this.loading.set(true);
    // The rollup is a nice-to-have on this page: failures just hide the card.
    this.api.appAnalytics(appId).subscribe({
      next: (o) => this.overview.set(o),
      error: () => this.overview.set(null),
    });
    this.api.listGuides(appId).subscribe({
      next: (guides) => {
        this.guides.set(guides);
        this.loading.set(false);
      },
      error: (err) => {
        this.error.set(describeError(err));
        this.loading.set(false);
      },
    });
  }

  create(): void {
    const { name, type } = this.createForm.getRawValue();
    this.creating.set(true);
    this.api.createGuide(this.appId(), name.trim(), type).subscribe({
      next: (g) => void this.router.navigate(['/o', this.orgId(), 'apps', this.appId(), 'guides', g.id]),
      error: (err) => {
        this.error.set(describeError(err));
        this.creating.set(false);
      },
    });
  }

  /** Optimistic toggle; reverted if the backend rejects it. */
  /** Deletes a guide with its versions, analytics and visitor state. No undo, so the prompt says what goes. */
  remove(guide: GuideSummary): void {
    const live =
      guide.enabled && guide.current_version_id ? ' It is live: visitors stop seeing it right away.' : '';
    if (!confirm(`Delete the guide “${guide.name}” with all its versions and analytics?${live}`)) return;
    this.pending.update((p) => new Set(p).add(guide.id));
    this.api.deleteGuide(this.appId(), guide.id).subscribe({
      next: () => {
        this.guides.update((list) => list.filter((g) => g.id !== guide.id));
        this.pending.update((p) => {
          const next = new Set(p);
          next.delete(guide.id);
          return next;
        });
      },
      error: () => {
        this.pending.update((p) => {
          const next = new Set(p);
          next.delete(guide.id);
          return next;
        });
      },
    });
  }

  toggle(guide: GuideSummary, enabled: boolean): void {
    this.setGuide(guide.id, { enabled });
    this.pending.update((s) => new Set(s).add(guide.id));
    this.api.setEnabled(this.appId(), guide.id, enabled).subscribe({
      next: () => this.clearPending(guide.id),
      error: (err) => {
        this.setGuide(guide.id, { enabled: !enabled });
        this.clearPending(guide.id);
        this.error.set(describeError(err));
      },
    });
  }

  private setGuide(id: string, patch: Partial<GuideSummary>): void {
    this.guides.update((list) => list.map((g) => (g.id === id ? { ...g, ...patch } : g)));
  }

  private clearPending(id: string): void {
    this.pending.update((s) => {
      const next = new Set(s);
      next.delete(id);
      return next;
    });
  }
}
