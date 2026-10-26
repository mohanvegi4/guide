import { DatePipe } from '@angular/common';
import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { Observable } from 'rxjs';
import { ApiService, describeError } from '../core/api.service';
import { runRequest } from '../core/request';
import { saveResponseAsFile } from '../core/download';
import { AuthService } from '../core/auth.service';
import {
  AgentError,
  App,
  HELP_POSITIONS,
  HelpAnalytics,
  HelpPosition,
  ROUTE_MODES,
  isOrgManager,
} from '../core/models';
import { EnvironmentsComponent } from '../components/environments.component';
import { EnvironmentSelectComponent } from '../components/environment-select.component';

/**
 * Install + security settings for one app (app admins):
 *  - the <head> snippet with this app's public key
 *  - environments (release stages) with the websites that belong to each
 *  - optional signed visitor identity (secret shown once)
 *  - how the app routes (path or hash), which decides what guides match on
 *  - the help center's button and placement, with its usage over the last 30 days
 *  - app on/off, key rotation, deleting the app (type-the-name confirmation)
 *  - the newest errors the agent reported from the app's pages
 */
@Component({
  selector: 'app-app-settings',
  imports: [DatePipe, FormsModule, EnvironmentsComponent, EnvironmentSelectComponent],
  template: `
    @if (app(); as a) {
      <div class="page-header">
        <div>
          <h1>{{ a.name }} — {{ admin() ? 'settings' : 'install' }}</h1>
          <p class="muted small">
            Public key <code>{{ a.public_key }}</code>
          </p>
        </div>
        <label class="switch big">
          <input
            type="checkbox"
            [checked]="a.enabled"
            [disabled]="busy() || !admin()"
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

      @if (!admin()) {
        <p class="muted small">
          Websites, signed identity, the help center and the danger zone are managed by this app's admins.
        </p>
      }

      @if (admin()) {
        <section class="card">
          <h2>2. Environments &amp; websites</h2>
          <app-environments [appId]="a.id" [canDelete]="manager()" />
          <div class="inline-form">
            <label>
              Routing
              <select
                aria-label="Routing"
                [ngModel]="a.route_mode"
                [disabled]="busy()"
                (ngModelChange)="save({ routeMode: $event })"
              >
                @for (m of routeModes; track m[0]) {
                  <option [value]="m[0]">{{ m[1] }}</option>
                }
              </select>
            </label>
          </div>
          <p class="muted small">
            How your app addresses pages. Guides are matched on the URL path, or, for a hash router, on the
            part after <code>#</code>. Write page URLs the same way in both cases
            (<code>/settings/team</code>).
          </p>
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
          <label class="switch">
            <input
              type="checkbox"
              [checked]="a.match_site_theme"
              [disabled]="busy()"
              (change)="save({ matchSiteTheme: $any($event.target).checked })"
            />
            <span>Match the website's theme</span>
          </label>
          <p class="muted small">
            @if (a.match_site_theme) {
              Guides and the help center take your site's Bootstrap theme: its primary color, font, text
              color and corners, page by page (so a site with several themes gets each one). The color
              below is used only on pages without a Bootstrap theme.
            } @else {
              Guides and the help center use the color below for their buttons, and Guide Engine's own
              font and corners.
            }
          </p>
          <div class="inline-form">
            <label
              >Button label <input [(ngModel)]="helpLabel" maxlength="40" aria-label="Help button label"
            /></label>
            <label
              >{{ a.match_site_theme ? 'Fallback color' : 'Button color' }}
              <input type="color" [(ngModel)]="helpColor" aria-label="Help button color"
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
            Where the topic list opens — and the "Go to another page?" dialog shown when a visitor picks a
            topic that lives elsewhere. The floating button sits in that corner (bottom right when centered).
          </p>
          <p class="muted small">
            Using your own help button instead? Hide ours and open the help center from yours:
          </p>
          <pre class="snippet code">{{ customButtonExample }}</pre>

          <div class="card nested help-analytics">
            <div class="section-head">
              <h3 class="subhead">Help center analytics</h3>
              <div class="toolbar">
                <app-environment-select [appId]="a.id" [(value)]="analyticsEnvironment" />
                <button type="button" class="link" (click)="loadAnalytics()">Refresh</button>
              </div>
            </div>
            @if (analyticsError()) {
              <p class="error">{{ analyticsError() }}</p>
            } @else if (analytics(); as s) {
              <p class="muted small">Last {{ s.days }} days.</p>
              <table class="table compact">
                <tbody>
                  <tr>
                    <th scope="row">Opened</th>
                    <td class="num">{{ s.opens }}</td>
                  </tr>
                  <tr>
                    <th scope="row">Searches</th>
                    <td class="num">{{ s.searches }}</td>
                  </tr>
                  <tr>
                    <th scope="row">Guides started from here</th>
                    <td class="num">{{ s.guidesStarted }}</td>
                  </tr>
                </tbody>
              </table>
              @if (s.topQueries.length > 0) {
                <h4 class="subhead">Top searches</h4>
                <p class="muted small">
                  What visitors looked for, and how many topics each search found on average. A search that
                  finds nothing is a topic worth adding.
                </p>
                <table class="table compact">
                  <thead>
                    <tr>
                      <th>Query</th>
                      <th class="num">Times</th>
                      <th class="num">Topics found</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (q of s.topQueries; track q.query) {
                      <tr [class.bad]="q.avgResults === 0">
                        <td>{{ q.query }}</td>
                        <td class="num">{{ q.count }}</td>
                        <td class="num">{{ q.avgResults ?? '–' }}</td>
                      </tr>
                    }
                  </tbody>
                </table>
              } @else if (s.opens === 0 && s.searches === 0) {
                <p class="muted small">No help-center opens or searches recorded yet.</p>
              }
            } @else {
              <p class="muted small">Loading…</p>
            }
          </div>
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
          <h2>Danger zone</h2>
          <h3 class="subhead">Public key</h3>
          <p class="muted small">
            Rotating stops every installed snippet immediately until you update it with the new key.
          </p>
          <button type="button" class="danger" (click)="rotate()" [disabled]="busy()">
            Rotate public key
          </button>
          <h3 class="subhead">Forget a visitor</h3>
          <p class="muted small">
            For an end user's "what do you hold about me?" or "forget me" request. Enter the visitor id your
            site passed to <code>guideEngine.initialize</code>: <strong>Export</strong> downloads their events
            and guide state; <strong>Forget</strong> deletes them (the guides they finished will show again
            for that id).
          </p>
          <form class="inline-form" (ngSubmit)="forgetVisitor(a)">
            <label>
              Visitor id
              <input name="visitorId" [(ngModel)]="visitorId" autocomplete="off" aria-label="Visitor id" />
            </label>
            <button type="button" (click)="exportVisitor(a)" [disabled]="busy() || !visitorId.trim()">
              Export visitor
            </button>
            <button type="submit" class="danger" [disabled]="busy() || !visitorId.trim()">
              Forget visitor
            </button>
          </form>
          <h3 class="subhead">Delete app</h3>
          <p class="muted small">
            Deletes <strong>{{ a.name }}</strong> with its guides, pages, analytics and per-app roles.
            Installed snippets stop loading guides immediately. This cannot be undone; an owner can export the
            organization's data first (Members → Danger zone).
          </p>
          <form class="inline-form" (ngSubmit)="deleteApp(a)">
            <label>
              Type <strong>{{ a.name }}</strong> to confirm
              <input name="confirmName" [(ngModel)]="confirmName" autocomplete="off" />
            </label>
            <button type="submit" class="danger" [disabled]="busy() || confirmName !== a.name">
              Delete app
            </button>
          </form>
        </section>
      }
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
  private readonly router = inject(Router);
  readonly appId = input.required<string>();
  /** Settings are app-admin work; everyone else gets the install instructions only. */
  protected readonly admin = computed(() => this.auth.appRole(this.appId()) === 'app_admin');
  /** Managers and owners may delete environments (their releases go with them). */
  protected readonly manager = computed(() => isOrgManager(this.auth.orgRole(this.app()?.org_id)));

  protected readonly app = signal<App | null>(null);
  protected readonly errors = signal<AgentError[]>([]);
  protected readonly secret = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly message = signal<string | null>(null);
  protected readonly copied = signal<string | null>(null);
  protected readonly analytics = signal<HelpAnalytics | null>(null);
  protected readonly analyticsError = signal<string | null>(null);
  /** Which environment the help-center numbers are from ('' = production). */
  protected readonly analyticsEnvironment = signal('');
  protected readonly justCreated = inject(ActivatedRoute).snapshot.queryParamMap.has('new');
  protected confirmName = '';
  protected visitorId = '';
  protected helpLabel = 'Help';
  protected helpColor = '#4f46e5';
  protected helpPosition: HelpPosition = 'bottom-right';
  protected readonly positions = HELP_POSITIONS;
  protected readonly routeModes = ROUTE_MODES;
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
    effect(() => {
      const appId = this.appId();
      this.analyticsEnvironment();
      untracked(() => this.loadAnalytics(appId));
    });
  }

  /** Help-center usage; its own error signal so a failure here doesn't hide the settings. */
  loadAnalytics(appId = this.appId()): void {
    this.analyticsError.set(null);
    this.api.helpAnalytics(appId, this.analyticsEnvironment() || undefined).subscribe({
      next: (s) => this.analytics.set(s),
      error: (err) => this.analyticsError.set(describeError(err)),
    });
  }

  private setApp(a: App): void {
    this.app.set(a);
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

  /** Data-subject request, step 1: a JSON file with everything held about this visitor id. */
  exportVisitor(a: App): void {
    const id = this.visitorId.trim();
    if (!id) return;
    this.run(this.api.exportVisitor(a.id, id), (response) => {
      saveResponseAsFile(response, `guide-engine-visitor-${id}.json`);
      this.message.set(`Exported visitor “${id}”.`);
    });
  }

  /** Data-subject request, step 2: delete that visitor's events and guide state. */
  forgetVisitor(a: App): void {
    const id = this.visitorId.trim();
    if (!id) return;
    if (
      !confirm(`Forget visitor “${id}” in ${a.name}? Their events and guide state are deleted permanently.`)
    )
      return;
    this.run(this.api.forgetVisitor(a.id, id), (r) => {
      this.visitorId = '';
      this.message.set(
        `Forgot visitor “${id}”: ${r.events} event${r.events === 1 ? '' : 's'} and ${r.guideState} guide state row${r.guideState === 1 ? '' : 's'} deleted.`,
      );
    });
  }

  /** Danger zone: deletes the app (the typed name is checked again by the backend). */
  deleteApp(a: App): void {
    if (this.confirmName !== a.name) return;
    this.run(this.api.deleteApp(a.id, this.confirmName), async () => {
      // The app is gone: re-read /me so the switchers no longer offer it, then leave its pages.
      await this.auth.refresh();
      void this.router.navigate(['/o', a.org_id, 'apps']);
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
