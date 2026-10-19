import { DatePipe } from '@angular/common';
import { Component, computed, input, output } from '@angular/core';
import { GuideDetail, GuideVersion } from '../core/models';

@Component({
  selector: 'app-version-history',
  imports: [DatePipe],
  template: `
    <section class="card">
      <h2>Versions</h2>
      @if (versions().length === 0) {
        <p class="muted">Nothing published yet.</p>
      } @else {
        <ul class="versions">
          @for (v of versions(); track v.id) {
            <li [class.current]="v.id === guide().current_version_id">
              <div>
                <strong>v{{ v.version_number }}</strong>
                @if (v.id === guide().current_version_id) { <span class="badge published">live</span> }
                @if (!v.published_at) { <span class="badge draft">draft</span> }
                <div class="muted small">
                  {{ (v.published_at ?? v.created_at) | date: 'medium' }} · {{ v.steps.length }} step(s)
                </div>
              </div>
              <div class="version-actions">
                <button type="button" class="link" (click)="load.emit(v)">Load into editor</button>
                <button type="button" class="link" [disabled]="busy()" (click)="preview.emit(v)">Preview</button>
                @if (v.published_at && v.id !== guide().current_version_id) {
                  <button type="button" class="link" [disabled]="busy()" (click)="rollback.emit(v.version_number)">
                    Roll back to this
                  </button>
                }
              </div>
            </li>
          }
        </ul>
      }
    </section>
  `,
})
export class VersionHistoryComponent {
  readonly guide = input.required<GuideDetail>();
  readonly busy = input(false);
  readonly rollback = output<number>();
  readonly load = output<GuideVersion>();
  readonly preview = output<GuideVersion>();

  protected readonly versions = computed(() =>
    [...this.guide().versions].sort((a, b) => b.version_number - a.version_number)
  );
}
