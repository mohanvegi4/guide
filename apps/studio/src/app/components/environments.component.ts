import { Component, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Observable } from 'rxjs';
import { ApiService, describeError } from '../core/api.service';
import { Environment } from '../core/models';
import { runRequest } from '../core/request';
import { parseWebsites } from '../pages/websites';

/** One environment as edited in the card (websites as the textarea's text). */
interface Draft {
  id: string;
  /** As stored: labels and the delete confirmation use it, not the unsaved edit. */
  savedName: string;
  name: string;
  websites: string;
  analyticsEnabled: boolean;
}

/**
 * App settings → Environments: the app's release stages in promotion order
 * (the last is production), each with the websites that belong to it and
 * its own analytics switch. App admins edit them; deleting one needs a
 * manager, since its releases go with it.
 */
@Component({
  selector: 'app-environments',
  imports: [FormsModule],
  template: `
    <p class="muted small">
      Guides only load on these websites. Each website belongs to one environment, which is how a
      page's guides, show-once state and analytics are told apart. New versions are released to the
      first environment and promoted down the list; the last one is production.
    </p>
    @if (error()) {
      <p class="error" role="alert">{{ error() }}</p>
    }
    @if (message()) {
      <p class="success" role="status">{{ message() }}</p>
    }
    <ol class="environments">
      @for (d of drafts(); track d.id; let i = $index, first = $first, last = $last) {
        <li class="card nested" [attr.data-testid]="'environment-' + d.savedName">
          <div class="section-head">
            <h3 class="subhead">
              {{ i + 1 }}. {{ d.savedName }}
              @if (last && drafts().length > 1) {
                <span class="badge published">production</span>
              }
            </h3>
            <div class="toolbar">
              <button
                type="button"
                class="link"
                [disabled]="busy() || first"
                (click)="move(i, -1)"
                [attr.aria-label]="'Move ' + d.savedName + ' earlier'"
              >
                ↑
              </button>
              <button
                type="button"
                class="link"
                [disabled]="busy() || last"
                (click)="move(i, 1)"
                [attr.aria-label]="'Move ' + d.savedName + ' later'"
              >
                ↓
              </button>
              @if (canDelete() && drafts().length > 1) {
                <button
                  type="button"
                  class="link danger"
                  [disabled]="busy()"
                  (click)="remove(d)"
                  [attr.aria-label]="'Delete ' + d.savedName"
                >
                  Delete
                </button>
              }
            </div>
          </div>
          <div class="inline-form">
            <label
              >Name
              <input
                [(ngModel)]="d.name"
                maxlength="40"
                [attr.aria-label]="'Name of ' + d.savedName"
            /></label>
            <label class="switch">
              <input type="checkbox" [(ngModel)]="d.analyticsEnabled" />
              <span>Record analytics</span>
            </label>
          </div>
          <textarea
            rows="2"
            [(ngModel)]="d.websites"
            [attr.aria-label]="'Websites of ' + d.savedName + ', one per line'"
          ></textarea>
          <div class="toolbar">
            <button type="button" (click)="save(d)" [disabled]="busy()">
              Save {{ d.savedName }}
            </button>
          </div>
        </li>
      }
    </ol>

    <form class="inline-form" (ngSubmit)="add()">
      <label
        >New environment
        <input name="newName" [(ngModel)]="newName" maxlength="40" placeholder="e.g. Test"
      /></label>
      <label
        >Websites
        <input
          name="newWebsites"
          [(ngModel)]="newWebsites"
          placeholder="https://test.example.com"
        />
      </label>
      <button type="submit" [disabled]="busy() || !newName.trim()">Add before production</button>
    </form>
  `,
})
export class EnvironmentsComponent {
  private readonly api = inject(ApiService);
  readonly appId = input.required<string>();
  /** Managers and owners: deleting an environment removes its releases too. */
  readonly canDelete = input(false);

  protected readonly drafts = signal<Draft[]>([]);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly message = signal<string | null>(null);
  protected newName = '';
  protected newWebsites = '';

  constructor() {
    effect(() => {
      const appId = this.appId();
      untracked(() =>
        this.api.listEnvironments(appId).subscribe({
          next: (list) => this.show(list),
          error: (err) => this.error.set(describeError(err)),
        }),
      );
    });
  }

  private show(list: Environment[]): void {
    this.drafts.set(
      list.map((e) => ({
        id: e.id,
        savedName: e.name,
        name: e.name,
        websites: e.websites.join('\n'),
        analyticsEnabled: e.analyticsEnabled,
      })),
    );
  }

  private reload(): void {
    this.api.listEnvironments(this.appId()).subscribe({ next: (list) => this.show(list) });
  }

  save(d: Draft): void {
    const websites = parseWebsites(d.websites);
    if (typeof websites === 'string') {
      this.error.set(websites);
      return;
    }
    this.run(
      this.api.updateEnvironment(this.appId(), d.id, {
        name: d.name.trim(),
        websites,
        analyticsEnabled: d.analyticsEnabled,
      }),
      (e) => {
        this.message.set(`Saved ${e.name}.`);
        this.reload();
      },
    );
  }

  add(): void {
    const websites = parseWebsites(this.newWebsites);
    if (typeof websites === 'string') {
      this.error.set(websites);
      return;
    }
    this.run(
      this.api.createEnvironment(this.appId(), { name: this.newName.trim(), websites }),
      (e) => {
        this.newName = '';
        this.newWebsites = '';
        this.message.set(`Added ${e.name}.`);
        this.reload();
      },
    );
  }

  /** Swaps a stage with its neighbour; moving one to the end makes it production. */
  move(index: number, by: -1 | 1): void {
    const ids = this.drafts().map((d) => d.id);
    [ids[index], ids[index + by]] = [ids[index + by], ids[index]];
    const becomesProduction = index + by === ids.length - 1 || index === ids.length - 1;
    if (
      becomesProduction &&
      !confirm(
        'This changes which environment is production: its releases become what end users see. Continue?',
      )
    )
      return;
    this.run(this.api.reorderEnvironments(this.appId(), ids), (list) => {
      this.show(list);
      this.message.set('Order saved.');
    });
  }

  remove(d: Draft): void {
    const typed = prompt(
      `Delete the environment “${d.savedName}” with its releases and visitor state? Its websites stop loading guides. Type its name to confirm.`,
    );
    if (typed === null) return;
    this.run(this.api.deleteEnvironment(this.appId(), d.id, typed), () => {
      this.message.set(`Deleted ${d.savedName}.`);
      this.reload();
    });
  }

  private run<T>(obs: Observable<T>, onOk: (value: T) => void): void {
    runRequest({ busy: this.busy, error: this.error, message: this.message }, obs, onOk);
  }
}
