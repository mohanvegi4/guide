import { Component, effect, inject, input, model, signal, untracked } from '@angular/core';
import { ApiService } from '../core/api.service';
import { Environment } from '../core/models';

/**
 * Picks which environment an analytics view reads. Analytics are kept per
 * environment and never mixed; '' stands for production (the last stage),
 * which is also what the backend answers for without one, so the default
 * view costs no extra request. Hidden while the app has a single environment.
 */
@Component({
  selector: 'app-environment-select',
  template: `
    @if (environments().length > 1) {
      <label class="environment-select">
        <span class="muted small">Environment</span>
        <select aria-label="Environment" (change)="value.set($any($event.target).value)">
          @for (e of environments(); track e.id; let last = $last) {
            <!-- [selected] per option: the options render after the select, so a [value] on it would be lost. -->
            <option [value]="last ? '' : e.id" [selected]="(last ? '' : e.id) === value()">
              {{ e.name }}
            </option>
          }
        </select>
      </label>
    }
  `,
})
export class EnvironmentSelectComponent {
  private readonly api = inject(ApiService);
  readonly appId = input.required<string>();
  /** The chosen environment id, '' for production. */
  readonly value = model('');
  protected readonly environments = signal<Environment[]>([]);

  constructor() {
    effect(() => {
      const appId = this.appId();
      // untracked: the interceptor reads the auth token signal.
      untracked(() => {
        this.value.set('');
        // Optional chrome: if it can't load, the view simply shows production.
        this.api.listEnvironments(appId).subscribe({
          next: (list) => this.environments.set(list),
          error: () => this.environments.set([]),
        });
      });
    });
  }
}
