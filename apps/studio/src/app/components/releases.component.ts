import { DatePipe } from '@angular/common';
import {
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService, describeError } from '../core/api.service';
import { GuideDetail, GuideRelease } from '../core/models';
import { runRequest } from '../core/request';

/**
 * What each environment (release stage) runs, and the controls to move a
 * guide through them: publishing puts a new version in the first stage,
 * "Promote" hands it to the next one, "Revert" undoes an environment's latest
 * release change (repeatedly, walking back its log), and "Withdraw" takes the
 * guide out of one environment. Changes to production ask first.
 */
@Component({
  selector: 'app-releases',
  imports: [DatePipe],
  template: `
    <section class="card" data-testid="releases">
      <h2>Environments</h2>
      @if (error()) {
        <p class="error" role="alert">{{ error() }}</p>
      }
      @if (message()) {
        <p class="success" role="status">{{ message() }}</p>
      }
      @if (releases().length === 0 && !error()) {
        <p class="muted small">Loading…</p>
      }
      <ul class="versions releases">
        @for (r of releases(); track r.environmentId; let i = $index, last = $last) {
          <li>
            <div class="release-row">
              <div>
                <strong>{{ r.name }}</strong>
                @if (last && releases().length > 1) {
                  <span class="muted small"> · production</span>
                }
                <div>
                  @if (r.versionNumber) {
                    <span class="badge published">v{{ r.versionNumber }}</span>
                    <span class="muted small"> since {{ r.releasedAt | date: 'short' }}</span>
                  } @else {
                    <span class="muted small">Nothing released</span>
                  }
                </div>
              </div>
              @if (canPublish()) {
                <div class="version-actions">
                  @if (promoteTarget(i); as next) {
                    <button
                      type="button"
                      class="link"
                      [disabled]="busy()"
                      (click)="promote(r, next)"
                    >
                      Promote to {{ next.name }}
                    </button>
                  }
                  @if (r.canRevert) {
                    <button
                      type="button"
                      class="link"
                      [disabled]="busy()"
                      (click)="revert(r, last)"
                    >
                      Revert
                    </button>
                  }
                  @if (r.versionId) {
                    <button
                      type="button"
                      class="link danger"
                      [disabled]="busy()"
                      (click)="withdraw(r, last)"
                    >
                      Withdraw
                    </button>
                  }
                </div>
              }
            </div>
            @if (canPublish() && published().length > 0) {
              <div class="inline-form release-pick">
                <select [attr.aria-label]="'Version to release in ' + r.name" #pick>
                  @for (v of published(); track v.id) {
                    <option [value]="v.id" [selected]="v.id === r.versionId">
                      v{{ v.version_number }}
                    </option>
                  }
                </select>
                <button
                  type="button"
                  [disabled]="busy()"
                  (click)="release(r, pick.value, last)"
                  [attr.aria-label]="'Release the chosen version in ' + r.name"
                >
                  Release
                </button>
              </div>
            }
            @if (r.history.length > 0) {
              <details>
                <summary class="muted small">History ({{ r.history.length }})</summary>
                <ul class="release-history">
                  @for (h of r.history; track $index) {
                    <li class="small" [class.muted]="h.reverted">
                      {{ h.action === 'release' ? 'Released v' + h.versionNumber : 'Withdrawn' }}
                      · {{ h.at | date: 'short' }}{{ h.by ? ' · ' + h.by : '' }}
                      @if (h.reverted) {
                        <span> (reverted)</span>
                      }
                    </li>
                  }
                </ul>
              </details>
            }
          </li>
        }
      </ul>
    </section>
  `,
})
export class ReleasesComponent {
  private readonly api = inject(ApiService);
  readonly appId = input.required<string>();
  readonly guide = input.required<GuideDetail>();
  readonly canPublish = input(false);
  /** A release changed: the editor re-reads the guide (production mirrors into its live version). */
  readonly changed = output<void>();

  protected readonly releases = signal<GuideRelease[]>([]);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly message = signal<string | null>(null);
  /** Versions that may be released, newest first (drafts never go live anywhere). */
  protected readonly published = computed(() =>
    this.guide()
      .versions.filter((v) => v.published_at)
      .sort((a, b) => b.version_number - a.version_number),
  );

  constructor() {
    // Re-read whenever the editor re-reads the guide (publishing changes the first stage).
    effect(() => {
      const appId = this.appId();
      const id = this.guide().id;
      untracked(() =>
        this.api.releases(appId, id).subscribe({
          next: (list) => this.releases.set(list),
          error: (err) => this.error.set(describeError(err)),
        }),
      );
    });
  }

  /** The next stage, when it doesn't already run what this one runs. */
  protected promoteTarget(index: number): GuideRelease | null {
    const list = this.releases();
    const here = list[index];
    const next = list[index + 1];
    return here?.versionId && next && next.versionId !== here.versionId ? next : null;
  }

  promote(from: GuideRelease, to: GuideRelease): void {
    const isProduction = to === this.releases()[this.releases().length - 1];
    if (
      isProduction &&
      !confirm(
        `Release v${from.versionNumber} to ${to.name}? End users see it on their next page load.`,
      )
    )
      return;
    this.apply(
      this.api.promote(this.appId(), this.guide().id, from.environmentId),
      `Promoted v${from.versionNumber} to ${to.name}.`,
    );
  }

  release(env: GuideRelease, versionId: string, isProduction: boolean): void {
    const version = this.published().find((v) => v.id === versionId);
    if (!version || versionId === env.versionId) return;
    if (isProduction && !confirm(`Make v${version.version_number} live in ${env.name}?`)) return;
    this.apply(
      this.api.setRelease(this.appId(), this.guide().id, env.environmentId, versionId),
      `Released v${version.version_number} in ${env.name}.`,
    );
  }

  revert(env: GuideRelease, isProduction: boolean): void {
    if (isProduction && !confirm(`Undo the latest release change in ${env.name}?`)) return;
    this.apply(
      this.api.revertRelease(this.appId(), this.guide().id, env.environmentId),
      `Reverted ${env.name}.`,
    );
  }

  withdraw(env: GuideRelease, isProduction: boolean): void {
    if (
      !confirm(
        `Withdraw the guide from ${env.name}?${isProduction ? ' End users stop seeing it.' : ''}`,
      )
    )
      return;
    this.apply(
      this.api.setRelease(this.appId(), this.guide().id, env.environmentId, null),
      `Withdrawn from ${env.name}.`,
    );
  }

  private apply(obs: Observable<GuideRelease[]>, done: string): void {
    runRequest({ busy: this.busy, error: this.error, message: this.message }, obs, (list) => {
      this.releases.set(list);
      this.message.set(done);
      this.changed.emit();
    });
  }
}
