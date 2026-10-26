import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { ApiService, describeError } from '../core/api.service';
import { AccountAnalytics, StepPayload } from '../core/models';
import { EnvironmentSelectComponent } from './environment-select.component';

/** Funnel order for display; event types not listed here are appended after. */
const FUNNEL = [
  'guide_shown',
  'guide_step_viewed',
  'guide_step_completed',
  'guide_completed',
  'guide_dismissed',
  'guide_error',
] as const;

interface Row {
  type: string;
  count: number;
  pct: number;
}

interface StepRow {
  label: string;
  views: number;
  completed: number;
  dismissed: number;
  /** Share of this step's viewers who neither completed nor dismissed it here. */
  viewPct: number;
}

interface AccountRow extends AccountAnalytics {
  label: string;
  /** Shown, relative to the account shown the guide most. */
  shownPct: number;
}

/** Simple counts table + CSS bar chart — no chart library needed for v1. */
@Component({
  selector: 'app-analytics',
  imports: [EnvironmentSelectComponent],
  template: `
    <section class="card">
      <div class="section-head">
        <h2>Analytics</h2>
        <div class="toolbar">
          <app-environment-select [appId]="appId()" [(value)]="environment" />
          <label class="switch">
            <input
              type="checkbox"
              [checked]="byAccount()"
              (change)="setByAccount($any($event.target).checked)"
            />
            <span>By account</span>
          </label>
          <button type="button" class="link" (click)="refresh()">Refresh</button>
        </div>
      </div>
      @if (error()) {
        <p class="error">{{ error() }}</p>
      } @else if (total() === 0) {
        <p class="muted">No events recorded yet.</p>
      } @else {
        <table class="table compact">
          <tbody>
            @for (r of rows(); track r.type) {
              <tr>
                <th scope="row">{{ r.type }}</th>
                <td class="num">{{ r.count }}</td>
                <td class="bar-cell">
                  <div class="bar" [style.width.%]="r.pct" [class.bad]="r.type === 'guide_error'"></div>
                </td>
              </tr>
            }
          </tbody>
        </table>

        @if (startedFromHelp() > 0) {
          <p class="muted small">
            Started from the help center {{ startedFromHelp() }} time{{ startedFromHelp() === 1 ? '' : 's' }}.
          </p>
        }
        @if (stepRows().length > 0) {
          <h3 class="subhead">Per step</h3>
          <p class="muted small">
            Step ids survive edits, so counts carry across versions. Labels are from the live version.
          </p>
          <table class="table compact">
            <thead>
              <tr>
                <th>Step</th>
                <th class="num">Views</th>
                <th class="num">Done</th>
                <th class="num">Dismissed</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              @for (r of stepRows(); track r.label) {
                <tr>
                  <th scope="row" class="step-label" [title]="r.label">{{ r.label }}</th>
                  <td class="num">{{ r.views }}</td>
                  <td class="num">{{ r.completed }}</td>
                  <td class="num">{{ r.dismissed }}</td>
                  <td class="bar-cell"><div class="bar" [style.width.%]="r.viewPct"></div></td>
                </tr>
              }
            </tbody>
          </table>
        }
        @if (byAccount()) {
          <h3 class="subhead">By account</h3>
          @if (accountRows().length === 0) {
            <p class="muted small">Loading…</p>
          } @else {
            <p class="muted small">
              The accounts shown this guide most (up to 50). "No account" is visitors the host page didn't
              identify.
            </p>
            <table class="table compact">
              <thead>
                <tr>
                  <th>Account</th>
                  <th class="num">Shown</th>
                  <th class="num">Done</th>
                  <th class="num">Dismissed</th>
                  <th class="num">Visitors</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                @for (r of accountRows(); track r.accountId) {
                  <tr>
                    <th scope="row" class="step-label" [title]="r.label">{{ r.label }}</th>
                    <td class="num">{{ r.shown }}</td>
                    <td class="num">{{ r.completed }}</td>
                    <td class="num">{{ r.dismissed }}</td>
                    <td class="num">{{ r.visitors }}</td>
                    <td class="bar-cell"><div class="bar" [style.width.%]="r.shownPct"></div></td>
                  </tr>
                }
              </tbody>
            </table>
          }
        }
      }
    </section>
  `,
})
export class AnalyticsComponent {
  private readonly api = inject(ApiService);
  readonly appId = input.required<string>();
  readonly guideId = input.required<string>();
  /** Steps used to label the per-step table, in display order. */
  readonly steps = input<Array<Pick<StepPayload, 'content'> & { id?: string }>>([]);

  private readonly counts = signal<Record<string, number>>({});
  protected readonly startedFromHelp = signal(0);
  /** step_id -> event_type -> count */
  private readonly stepCounts = signal<Record<string, Record<string, number>>>({});
  protected readonly error = signal<string | null>(null);
  /** Whether to ask the backend for the per-account breakdown (an extra query; off by default). */
  protected readonly byAccount = signal(false);
  /** Which environment's numbers ('' = production); they are never added up across environments. */
  protected readonly environment = signal('');
  private readonly accounts = signal<AccountAnalytics[]>([]);

  protected readonly accountRows = computed<AccountRow[]>(() => {
    const accounts = this.accounts();
    const max = Math.max(1, ...accounts.map((a) => a.shown));
    return accounts.map((a) => ({
      ...a,
      label: a.accountId ?? 'No account',
      shownPct: (a.shown / max) * 100,
    }));
  });

  protected readonly rows = computed<Row[]>(() => {
    const counts = this.counts();
    const types = [
      ...FUNNEL,
      ...Object.keys(counts).filter((t) => !(FUNNEL as readonly string[]).includes(t)),
    ];
    const max = Math.max(1, ...Object.values(counts));
    return types.map((type) => ({ type, count: counts[type] ?? 0, pct: ((counts[type] ?? 0) / max) * 100 }));
  });
  /**
   * One row per live step, plus one for events on steps that no longer exist
   * (removed in a later version), so totals still reconcile.
   */
  protected readonly stepRows = computed<StepRow[]>(() => {
    const byStep = this.stepCounts();
    if (Object.keys(byStep).length === 0) return [];
    const known = new Set<string>();
    const row = (label: string, ids: string[]): StepRow => {
      const sum = (type: string) => ids.reduce((n, id) => n + (byStep[id]?.[type] ?? 0), 0);
      // The first step's "view" is logged as guide_shown, later ones as guide_step_viewed.
      const views = sum('guide_shown') + sum('guide_step_viewed');
      return {
        label,
        views,
        completed: sum('guide_step_completed'),
        dismissed: sum('guide_dismissed'),
        viewPct: 0,
      };
    };
    const rows = this.steps().map((s, i) => {
      if (s.id) known.add(s.id);
      return row(`${i + 1}. ${plainText(s.content)}`, s.id ? [s.id] : []);
    });
    const removed = Object.keys(byStep).filter((id) => !known.has(id));
    if (removed.length) rows.push(row('Removed steps', removed));
    const max = Math.max(1, ...rows.map((r) => r.views));
    return rows.map((r) => ({ ...r, viewPct: (r.views / max) * 100 }));
  });

  protected readonly total = computed(() => Object.values(this.counts()).reduce((a, b) => a + b, 0));

  constructor() {
    // Re-fetch when the guide changes — and ONLY then. untracked() matters:
    // the HTTP interceptor reads the auth token signal synchronously, which
    // would otherwise make the token a dependency of this effect and re-fire
    // the request on every token renewal (and unauthenticated on sign-out).
    effect(() => {
      this.appId();
      this.guideId();
      this.environment();
      untracked(() => this.refresh());
    });
  }

  setByAccount(on: boolean): void {
    this.byAccount.set(on);
    if (on) this.refresh();
    else this.accounts.set([]);
  }

  refresh(): void {
    const options = { byAccount: this.byAccount(), environmentId: this.environment() || undefined };
    this.api.analytics(this.appId(), this.guideId(), options).subscribe({
      next: (res) => {
        this.error.set(null);
        this.accounts.set(res.accounts ?? []);
        // pg returns COUNT as int (cast server-side); Number() guards older responses.
        this.counts.set(Object.fromEntries(res.counts.map((c) => [c.event_type, Number(c.count)])));
        this.startedFromHelp.set(Number(res.startedFromHelp ?? 0));
        const byStep: Record<string, Record<string, number>> = {};
        for (const c of res.steps ?? []) {
          (byStep[c.step_id] ??= {})[c.event_type] = Number(c.count);
        }
        this.stepCounts.set(byStep);
      },
      error: (err) => this.error.set(describeError(err)),
    });
  }
}

/** Short, tag-free label from step HTML (Angular escapes it on render). */
function plainText(html: string): string {
  const text = html
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > 40 ? `${text.slice(0, 40)}…` : text || '(empty)';
}
