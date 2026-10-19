import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Observable } from 'rxjs';
import { ApiService, describeError } from '../core/api.service';
import { AuthService } from '../core/auth.service';
import { AppPage, PagePayload, RouteMatch, appRoleAtLeast } from '../core/models';
import { runRequest } from '../core/request';

/** Must start with "/" but not "//" (no scheme, no other host). Empty is allowed; required-ness is separate. */
const SITE_PATH = /^(\/(?!\/).*)?$/;

/**
 * Saved pages for one app: named URL rules ("Team settings" -> /settings/team)
 * that guides pick instead of each typing a route. Guides on a page follow it:
 * editing a page's URL moves every guide on it, live ones included.
 *
 * One reactive form serves both the "New page" card and the inline row
 * editor (only one page is edited at a time).
 */
@Component({
  selector: 'app-pages',
  imports: [RouterLink, ReactiveFormsModule],
  template: `
    <div class="page-header">
      <div>
        <h1>Pages</h1>
        <p class="muted small">
          Name the parts of your app once, then pick them in any guide. Change a page's URL here and every
          guide on it follows — including live ones, without republishing.
        </p>
      </div>
    </div>

    @if (error()) {
      <p class="error" role="alert">{{ error() }}</p>
    }
    @if (message()) {
      <p class="success" role="status">{{ message() }}</p>
    }

    @if (canEdit() && !editingId()) {
      <section class="card">
        <h2>New page</h2>
        <form class="page-form" [formGroup]="form" (ngSubmit)="create()">
          <label
            >Name <input formControlName="name" placeholder="e.g. Team settings" maxlength="120"
          /></label>
          <label>
            Match
            <select formControlName="type" aria-label="URL match type">
              <option value="exact">Exact path</option>
              <option value="pattern">Pattern (* wildcard)</option>
            </select>
          </label>
          <label>URL <input formControlName="value" placeholder="/settings/team or /projects/*" /></label>
          <label>
            Start page {{ form.controls.type.value === 'pattern' ? '(required)' : '(optional)' }}
            <input
              formControlName="startPath"
              [placeholder]="
                form.controls.type.value === 'exact'
                  ? form.controls.value.value || '/settings/team'
                  : '/projects/demo'
              "
            />
          </label>
          <button type="submit" class="primary" [disabled]="busy()">Save page</button>
        </form>
        <p class="muted small">
          <em>Start page</em>: where the help center takes visitors before starting a guide on this page. For
          a pattern like <code>/projects/*</code> pick one concrete page, e.g. <code>/projects/demo</code>.
        </p>
      </section>
    }

    @if (loading()) {
      <p class="muted">Loading…</p>
    } @else if (pages().length === 0) {
      <p class="muted">No saved pages yet.</p>
    } @else {
      <table class="table">
        <thead>
          <tr>
            <th>Name</th>
            <th>URL</th>
            <th>Start page</th>
            <th>Used by</th>
            <th><span class="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          @for (p of pages(); track p.id) {
            @if (editingId() === p.id) {
              <tr class="editing" [formGroup]="form">
                <td><input formControlName="name" aria-label="Page name" maxlength="120" /></td>
                <td>
                  <select formControlName="type" aria-label="URL match type">
                    <option value="exact">Exact</option>
                    <option value="pattern">Pattern</option>
                  </select>
                  <input formControlName="value" aria-label="URL" />
                </td>
                <td>
                  <input
                    formControlName="startPath"
                    aria-label="Start page"
                    [placeholder]="
                      form.controls.type.value === 'exact' ? form.controls.value.value : 'required'
                    "
                  />
                </td>
                <td class="small">
                  @if (urlLocked(p)) {
                    <span class="muted">Live guides use this page — only publishers can change its URL.</span>
                  } @else if (p.usage?.live) {
                    <span class="notice"
                      >Changing the URL moves {{ p.usage!.live }} live guide{{
                        p.usage!.live === 1 ? '' : 's'
                      }}
                      immediately.</span
                    >
                  }
                </td>
                <td>
                  <div class="row-actions">
                    <button type="button" class="primary" (click)="saveEdit(p)" [disabled]="busy()">
                      Save
                    </button>
                    <button type="button" (click)="cancelEdit()">Cancel</button>
                  </div>
                </td>
              </tr>
            } @else {
              <tr>
                <td>
                  <strong>{{ p.name }}</strong>
                </td>
                <td>
                  <code>{{ p.routeMatch.value }}</code>
                  @if (p.routeMatch.type === 'pattern') {
                    <span class="badge">pattern</span>
                  }
                </td>
                <td>
                  <code>{{ p.startPath ?? (p.routeMatch.type === 'exact' ? p.routeMatch.value : '—') }}</code>
                </td>
                <td>
                  @if (p.usage?.guides) {
                    <button
                      type="button"
                      class="link"
                      (click)="toggleUsage(p)"
                      [attr.aria-expanded]="usageFor() === p.id"
                    >
                      {{ p.usage!.guides }} guide{{ p.usage!.guides === 1 ? '' : 's' }}
                      @if (p.usage!.live) {
                        ({{ p.usage!.live }} live)
                      }
                    </button>
                    @if (usageFor() === p.id) {
                      <ul class="small">
                        @for (g of usage(); track g.id) {
                          <li>
                            <a [routerLink]="['/o', orgId(), 'apps', appId(), 'guides', g.id]">{{
                              g.name
                            }}</a>
                            <span class="muted"
                              >{{ g.live ? ' · live' : '' }}{{ g.draft ? ' · draft' : '' }}</span
                            >
                          </li>
                        }
                      </ul>
                    }
                  } @else {
                    <span class="muted">—</span>
                  }
                </td>
                <td>
                  @if (canEdit()) {
                    <div class="row-actions">
                      <button type="button" (click)="startEdit(p)" [disabled]="busy() || !!editingId()">
                        Edit
                      </button>
                      <button
                        type="button"
                        class="danger"
                        (click)="remove(p)"
                        [disabled]="busy() || !!p.usage?.guides"
                        [title]="p.usage?.guides ? 'In use — move its guides to another page first' : ''"
                      >
                        Delete
                      </button>
                    </div>
                  }
                </td>
              </tr>
            }
          }
        </tbody>
      </table>
    }
  `,
})
export class PagesComponent {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  readonly orgId = input.required<string>();
  readonly appId = input.required<string>();
  protected readonly canEdit = computed(() => appRoleAtLeast(this.auth.appRole(this.appId()), 'editor'));
  protected readonly canPublish = computed(() =>
    appRoleAtLeast(this.auth.appRole(this.appId()), 'publisher'),
  );

  protected readonly pages = signal<AppPage[]>([]);
  protected readonly loading = signal(true);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly message = signal<string | null>(null);
  /** The page whose row is being edited; the form then holds its values instead of a new page's. */
  protected readonly editingId = signal<string | null>(null);
  protected readonly usageFor = signal<string | null>(null);
  protected readonly usage = signal<NonNullable<AppPage['guides']>>([]);

  protected readonly form = inject(FormBuilder).nonNullable.group({
    name: ['', [Validators.required, Validators.maxLength(120)]],
    type: ['exact' as RouteMatch['type']],
    value: ['', [Validators.required, Validators.pattern(/^\//)]],
    startPath: ['', Validators.pattern(SITE_PATH)],
  });

  constructor() {
    // untracked: the interceptor reads the auth token signal (see guide list).
    effect(() => {
      const appId = this.appId();
      untracked(() => this.load(appId));
    });
  }

  private load(appId: string): void {
    this.loading.set(true);
    this.cancelEdit();
    this.usageFor.set(null);
    this.api.listPages(appId).subscribe({
      next: (pages) => {
        this.pages.set(pages);
        this.loading.set(false);
      },
      error: (err) => {
        this.error.set(describeError(err));
        this.loading.set(false);
      },
    });
  }

  /** Editors can rename pages live guides use, but not move them. */
  protected urlLocked(page: AppPage): boolean {
    return !!page.usage?.live && !this.canPublish();
  }

  /** The form as an API body, or a message saying what to fix. */
  private payload(): PagePayload | string {
    this.form.markAllAsTouched();
    return toPayload(this.form.getRawValue());
  }

  create(): void {
    const payload = this.payload();
    if (typeof payload === 'string') {
      this.error.set(payload);
      return;
    }
    this.run(this.api.createPage(this.appId(), payload), (page) => {
      this.form.reset();
      this.message.set(`Saved “${page.name}”. Pick it in any guide under Where & when.`);
      this.load(this.appId());
    });
  }

  startEdit(page: AppPage): void {
    this.message.set(null);
    this.error.set(null);
    this.editingId.set(page.id);
    this.form.reset({
      name: page.name,
      type: page.routeMatch.type,
      value: page.routeMatch.value,
      startPath: page.startPath ?? '',
    });
    // Editors may rename a page live guides use, but not move it.
    for (const c of [this.form.controls.type, this.form.controls.value, this.form.controls.startPath]) {
      if (this.urlLocked(page)) c.disable();
      else c.enable();
    }
  }

  cancelEdit(): void {
    this.editingId.set(null);
    this.form.reset();
    this.form.enable();
  }

  saveEdit(page: AppPage): void {
    const payload = this.payload();
    if (typeof payload === 'string') {
      this.error.set(payload);
      return;
    }
    const moved =
      payload.routeMatch.type !== page.routeMatch.type ||
      payload.routeMatch.value !== page.routeMatch.value ||
      (payload.startPath ?? null) !== page.startPath;
    const live = page.usage?.live ?? 0;
    if (
      moved &&
      live &&
      !confirm(`${live} live guide(s) will move to ${payload.routeMatch.value} right away. Continue?`)
    ) {
      return;
    }
    this.run(this.api.updatePage(this.appId(), page.id, payload), (updated) => {
      this.message.set(
        moved && updated.guides?.length
          ? `Saved. ${updated.guides.length} guide(s) now use ${updated.routeMatch.value}.`
          : 'Saved.',
      );
      this.load(this.appId());
    });
  }

  remove(page: AppPage): void {
    if (!confirm(`Delete the page “${page.name}”?`)) return;
    this.run(this.api.deletePage(this.appId(), page.id), () => {
      this.message.set(`Deleted “${page.name}”.`);
      this.load(this.appId());
    });
  }

  toggleUsage(page: AppPage): void {
    if (this.usageFor() === page.id) {
      this.usageFor.set(null);
      return;
    }
    this.usageFor.set(page.id);
    this.usage.set([]);
    this.api.getPage(this.appId(), page.id).subscribe({
      next: (p) => this.usage.set(p.guides ?? []),
      error: (err) => this.error.set(describeError(err)),
    });
  }

  private run<T>(obs: Observable<T>, onOk: (value: T) => void): void {
    runRequest({ busy: this.busy, error: this.error, message: this.message }, obs, onOk);
  }
}

export interface PageDraft {
  name: string;
  type: RouteMatch['type'];
  value: string;
  startPath: string;
}

/** Form values -> API body, or a message saying what to fix. */
export function toPayload(d: PageDraft): PagePayload | string {
  const name = d.name.trim();
  const value = d.value.trim();
  const startPath = d.startPath.trim();
  if (!name) return 'Give the page a name.';
  if (!value.startsWith('/')) return 'The URL must be a path starting with /, e.g. /settings/team.';
  if (!SITE_PATH.test(startPath)) return 'The start page must be a path on your site, e.g. /projects/demo.';
  if (d.type === 'pattern' && !startPath) {
    return 'A pattern page needs a start page — one concrete URL the help center can open, e.g. /projects/demo.';
  }
  return { name, routeMatch: { type: d.type, value }, startPath: startPath || null };
}
