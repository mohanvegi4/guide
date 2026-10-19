import { DatePipe } from '@angular/common';
import { Component, OnInit, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { ApiService, describeError } from '../core/api.service';
import { GUIDE_TYPES, GuideScope, GuideSummary, GuideType } from '../core/models';

@Component({
  selector: 'app-guide-list',
  imports: [RouterLink, ReactiveFormsModule, DatePipe],
  template: `
    <div class="page-header">
      <div>
        <h1>{{ scope === 'global' ? 'Global guides' : 'Guides' }}</h1>
        @if (scope === 'global') {
          <p class="notice">Global guides are shown to <strong>every tenant</strong>. Analytics here are aggregated across all tenants.</p>
        }
      </div>
    </div>

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

    @if (error()) {
      <p class="error" role="alert">{{ error() }}</p>
    }

    @if (loading()) {
      <p class="muted">Loading…</p>
    } @else if (guides().length === 0) {
      <p class="muted">No guides yet — create one above.</p>
    } @else {
      <table class="table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Type</th>
            <th>Status</th>
            <th>Live version</th>
            <th>Updated</th>
            <th>Enabled</th>
          </tr>
        </thead>
        <tbody>
          @for (g of guides(); track g.id) {
            <tr>
              <td><a [routerLink]="[basePath, g.id]">{{ g.name }}</a></td>
              <td>{{ g.type }}</td>
              <td><span class="badge" [class]="'badge ' + g.status">{{ g.status }}</span></td>
              <td>{{ g.current_version_number ? 'v' + g.current_version_number : '—' }}</td>
              <td>{{ g.updated_at | date: 'short' }}</td>
              <td>
                <label class="switch" [title]="g.current_version_id ? '' : 'Publish a version first — an enabled guide with nothing published shows nothing'">
                  <input
                    type="checkbox"
                    [checked]="g.enabled"
                    [disabled]="pending().has(g.id)"
                    (change)="toggle(g, $any($event.target).checked)"
                    [attr.aria-label]="'Enable ' + g.name"
                  />
                  <span>{{ g.enabled ? 'On' : 'Off' }}</span>
                </label>
              </td>
            </tr>
          }
        </tbody>
      </table>
    }
  `,
})
export class GuideListComponent implements OnInit {
  private readonly api = inject(ApiService);
  private readonly router = inject(Router);
  protected readonly guideTypes = GUIDE_TYPES;
  protected readonly scope: GuideScope = inject(ActivatedRoute).snapshot.data['scope'] ?? 'tenant';
  protected readonly basePath = this.scope === 'global' ? '/global' : '/guides';

  protected readonly guides = signal<GuideSummary[]>([]);
  protected readonly loading = signal(true);
  protected readonly creating = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly pending = signal(new Set<string>());

  protected readonly createForm = inject(FormBuilder).nonNullable.group({
    name: ['', [Validators.required, Validators.maxLength(200)]],
    type: ['tooltip' as GuideType, Validators.required],
  });

  ngOnInit(): void {
    this.api.listGuides(this.scope).subscribe({
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
    this.api.createGuide(this.scope, name.trim(), type).subscribe({
      next: (g) => void this.router.navigate([this.basePath, g.id]),
      error: (err) => {
        this.error.set(describeError(err));
        this.creating.set(false);
      },
    });
  }

  /** Optimistic toggle; reverted if the backend rejects it. */
  toggle(guide: GuideSummary, enabled: boolean): void {
    this.setGuide(guide.id, { enabled });
    this.pending.update((s) => new Set(s).add(guide.id));
    this.api.setEnabled(this.scope, guide.id, enabled).subscribe({
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
