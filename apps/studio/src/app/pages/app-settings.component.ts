import { DatePipe } from '@angular/common';
import { Component, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { Observable } from 'rxjs';
import { ApiService, describeError } from '../core/api.service';
import { runRequest } from '../core/request';
import { AuthService } from '../core/auth.service';
import { AgentError, App, HELP_POSITIONS, HelpPosition } from '../core/models';
import { parseWebsites } from './websites';

/**
 * Install + security settings for one app (app admins):
 *  - the <head> snippet with this app's public key
 *  - websites allowed to load guides
 *  - optional signed visitor identity (secret shown once)
 *  - app on/off, key rotation
 *  - the newest errors the agent reported from the app's pages
 */
@Component({
  selector: 'app-app-settings',
  imports: [DatePipe, FormsModule],
  template: `
    @if (app(); as a) {
      <div class="page-header">
        <div>
          <h1>{{ a.name }} — settings</h1>
          <p class="muted small">
            Public key <code>{{ a.public_key }}</code>
          </p>
        </div>
        <label class="switch big">
          <input
            type="checkbox"
            [checked]="a.enabled"
            [disabled]="busy()"
            (change)="save({ enabled: $any($event.target).checked })"
          />
          <span>{{ a.enabled ? 'Guides on' : 'Guides off' }}</span>
        </label>
      </div>

      @if (justCreated) {
        <p class="success">Your app is ready. Add this snippet to your site, then create your first guide.</p>
      }
      @if (error()) {
        <p class="error" role="alert">{{ error() }}</p>
      }
      @if (message()) {
        <p class="success" role="status">{{ message() }}</p>
      }

      <section class="card">
        <div class="section-head">
          <h2>1. Install</h2>
          <button type="button" (click)="copy(a.snippet ?? '', 'snippet')">
            {{ copied() === 'snippet' ? 'Copied ✓' : 'Copy snippet' }}
          </button>
        </div>
        <p class="muted small">
          Paste this into the <code>&lt;head&gt;</code> of every page of your app, and replace
          <code>USER_ID</code> / <code>ACCOUNT_ID</code> with your signed-in user's ids (leave the visitor out
          for anonymous users). Single-page apps need nothing else — route changes are detected automatically.
          After a user signs in later, call
          <code>guideEngine.identify(&#123; visitor: &#123; id &#125;, account: &#123; id &#125; &#125;)</code
          >.
        </p>
        <pre class="snippet code">{{ a.snippet }}</pre>
        <p class="muted small">
          Then mark elements guides should point at with <code>data-guide-id="…"</code> (e.g.
          <code>&lt;button data-guide-id="invite-button"&gt;</code>).
        </p>
      </section>

      <section class="card">
        <h2>2. Websites</h2>
        <p class="muted small">
          Guides only load on these sites. Include your development URL if you test locally.
        </p>
        <textarea rows="3" [(ngModel)]="websites" aria-label="Websites, one per line"></textarea>
        <div class="toolbar">
          <button type="button" (click)="saveWebsites()" [disabled]="busy()">Save websites</button>
        </div>
      </section>

      <section class="card">
        <h2>3. Signed identity (recommended)</h2>
        <p class="muted small">
          The snippet's key is public, so anyone could claim to be any visitor. To prevent that, have your
          server sign each user's identity with this app's secret and pass it as <code>jwt</code>.
        </p>
        @if (secret()) {
          <p class="notice small">
            Copy this secret now — it won't be shown again. Store it on your server only.
          </p>
          <pre class="snippet code">{{ secret() }}</pre>
          <button type="button" (click)="copy(secret()!, 'secret')">
            {{ copied() === 'secret' ? 'Copied ✓' : 'Copy secret' }}
          </button>
          <p class="muted small">Sign on your server (Node example):</p>
          <pre class="snippet code">{{ signingExample }}</pre>
        }
        <div class="toolbar">
          <button type="button" (click)="generateSecret(a)" [disabled]="busy()">
            {{ a.has_signing_secret ? 'Rotate signing secret' : 'Generate signing secret' }}
          </button>
          <label class="switch">
            <input
              type="checkbox"
              [checked]="a.identity_mode === 'required'"
              [disabled]="busy() || !a.has_signing_secret"
              (change)="save({ identityMode: $any($event.target).checked ? 'required' : 'optional' })"
            />
            <span>Require signed identity</span>
          </label>
        </div>
        @if (a.identity_mode === 'required') {
          <p class="muted small">Unsigned visitors get no guides.</p>
        }
      </section>

      <section class="card">
        <div class="section-head">
          <h2>4. Help center</h2>
          <label class="switch">
            <input
              type="checkbox"
              [checked]="a.help_enabled"
              [disabled]="busy()"
              (change)="save({ helpEnabled: $any($event.target).checked })"
            />
            <span>{{ a.help_enabled ? 'On' : 'Off' }}</span>
          </label>
        </div>
        <p class="muted small">
          A floating button opens a searchable list of the guides you've marked
          <em>List in the help center</em>. It only appears when a visitor has at least one such guide.
        </p>
        <div class="inline-form">
          <label
            >Button label <input [(ngModel)]="helpLabel" maxlength="40" aria-label="Help button label"
          /></label>
          <label
            >Button color <input type="color" [(ngModel)]="helpColor" aria-label="Help button color"
          /></label>
          <span class="help-preview" [style.background]="helpColor">? {{ helpLabel || 'Help' }}</span>
        </div>
        <div class="inline-form">
          <label>
            Position
            <select [(ngModel)]="helpPosition" aria-label="Help button position">
              @for (p of positions; track p[0]) {
                <option [value]="p[0]">{{ p[1] }}</option>
              }
            </select>
          </label>
          <button type="button" (click)="saveHelpButton()" [disabled]="busy()">Save help button</button>
        </div>
        <p class="muted small">
          Where the topic list opens — and the "Go to another page?" dialog shown when a visitor picks a topic
          that lives elsewhere. The floating button sits in that corner (bottom right when centered).
        </p>
        <p class="muted small">
          Using your own help button instead? Hide ours and open the help center from yours:
        </p>
        <pre class="snippet code">{{ customButtonExample }}</pre>
      </section>

      <section class="card" data-testid="agent-errors">
        <h2>Recent agent errors</h2>
        <p class="muted small">
          Exceptions the Guide Engine script caught on your pages (a sample, newest first). Your visitors
          never see them; they are here so a broken page or a bad deploy doesn't stay silent.
        </p>
        @if (errors().length === 0) {
          <p class="muted">None reported.</p>
        } @else {
          <table class="agent-errors">
            <thead>
              <tr>
                <th>When</th>
                <th>Message</th>
                <th>Page</th>
              </tr>
            </thead>
            <tbody>
              @for (e of errors(); track e.id) {
                <tr>
                  <td class="muted small nowrap">{{ e.occurredAt | date: 'medium' }}</td>
                  <td>
                    <code>{{ e.message }}</code>
                    @if (e.agentVersion) {
                      <span class="muted small"> · agent {{ e.agentVersion }}</span>
                    }
                  </td>
                  <td class="muted small">{{ e.url || '—' }}</td>
                </tr>
              }
            </tbody>
          </table>
        }
      </section>

      <section class="card danger-zone">
        <h2>Public key</h2>
        <p class="muted small">
          Rotating stops every installed snippet immediately until you update it with the new key.
        </p>
        <button type="button" class="danger" (click)="rotate()" [disabled]="busy()">Rotate public key</button>
      </section>
    } @else if (!error()) {
      <p class="muted">Loading…</p>
    } @else {
      <p class="error">{{ error() }}</p>
    }
  `,
})
export class AppSettingsComponent {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  readonly appId = input.required<string>();

  protected readonly app = signal<App | null>(null);
  protected readonly errors = signal<AgentError[]>([]);
  protected readonly secret = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly message = signal<string | null>(null);
  protected readonly copied = signal<string | null>(null);
  protected readonly justCreated = inject(ActivatedRoute).snapshot.queryParamMap.has('new');
  protected websites = '';
  protected helpLabel = 'Help';
  protected helpColor = '#4f46e5';
  protected helpPosition: HelpPosition = 'bottom-right';
  protected readonly positions = HELP_POSITIONS;
  protected readonly customButtonExample = `guideEngine.initialize({ visitor: { id: 'USER_ID' }, helpButton: false });

// your button:
<button onclick="guideEngine.openHelp()">Help</button>
// also available: guideEngine.closeHelp(), guideEngine.toggleHelp()`;
  protected readonly signingExample = `import jwt from 'jsonwebtoken';
const token = jwt.sign(
  { visitor: { id: user.id }, account: { id: user.companyId } },
  process.env.GUIDE_ENGINE_SECRET,          // this app's signing secret
  { algorithm: 'HS256', expiresIn: '1h' },
);
// in the page: guideEngine.initialize({ jwt: token })`;

  constructor() {
    // untracked: the interceptor reads the auth token signal (see guide list).
    effect(() => {
      const appId = this.appId();
      untracked(() => {
        this.secret.set(null);
        this.api.getApp(appId).subscribe({
          next: (a) => this.setApp(a),
          error: (err) => this.error.set(describeError(err)),
        });
        // Diagnostic only: a failure here must not hide the settings page.
        this.errors.set([]);
        this.api
          .listErrors(appId)
          .subscribe({ next: (list) => this.errors.set(list), error: () => undefined });
      });
    });
  }

  private setApp(a: App): void {
    this.app.set(a);
    this.websites = a.allowed_origins.join('\n');
    this.helpLabel = a.help_button_label;
    this.helpColor = a.help_button_color;
    this.helpPosition = a.help_position;
  }

  save(patch: Parameters<ApiService['updateApp']>[1]): void {
    this.run(this.api.updateApp(this.appId(), patch), (a) => {
      this.app.update((prev) => ({ ...a, snippet: prev?.snippet }));
      this.message.set('Saved.');
      void this.auth.refresh();
    });
  }

  saveWebsites(): void {
    const parsed = parseWebsites(this.websites);
    if (typeof parsed === 'string') {
      this.error.set(parsed);
      return;
    }
    this.save({ websites: parsed });
  }

  saveHelpButton(): void {
    this.save({
      helpButtonLabel: this.helpLabel.trim() || 'Help',
      helpButtonColor: this.helpColor,
      helpPosition: this.helpPosition,
    });
  }

  generateSecret(a: App): void {
    if (
      a.has_signing_secret &&
      !confirm('Rotate the secret? Identities signed with the old one stop working.')
    )
      return;
    this.run(this.api.createSigningSecret(this.appId()), ({ secret }) => {
      this.secret.set(secret);
      this.app.update((prev) => (prev ? { ...prev, has_signing_secret: true } : prev));
    });
  }

  rotate(): void {
    if (!confirm('Rotate the public key? Every installed snippet stops loading guides until it is updated.'))
      return;
    this.run(this.api.rotateKey(this.appId()), (a) => {
      this.setApp(a);
      this.message.set('New key issued — update your snippet.');
    });
  }

  copy(text: string, what: string): void {
    void navigator.clipboard?.writeText(text).then(
      () => this.copied.set(what),
      () => this.error.set('Could not copy — select the text and copy it manually.'),
    );
  }

  private run<T>(obs: Observable<T>, onOk: (value: T) => void): void {
    runRequest({ busy: this.busy, error: this.error, message: this.message }, obs, onOk);
  }
}
