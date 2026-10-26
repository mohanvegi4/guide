import { DatePipe } from '@angular/common';
import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { Observable, forkJoin } from 'rxjs';
import {
  FormArray,
  FormBuilder,
  FormControl,
  FormGroup,
  ReactiveFormsModule,
  Validators,
} from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { AuthService } from '../core/auth.service';
import { ApiService, describeError } from '../core/api.service';
import { runRequest } from '../core/request';
import {
  AppPage,
  appRoleAtLeast,
  GUIDE_TYPES,
  GuideActivation,
  GuideDetail,
  GuideType,
  GuideVersion,
  PreviewLink,
  PublishPayload,
  STEP_ACTIONS,
  STEP_POSITIONS,
  StepAction,
  StepActionType,
  StepPayload,
  StepPosition,
} from '../core/models';
import { VersionHistoryComponent } from '../components/version-history.component';
import { AnalyticsComponent } from '../components/analytics.component';
import { ReleasesComponent } from '../components/releases.component';

type ActionForm = FormGroup<{ label: FormControl<string>; action: FormControl<StepActionType> }>;
type StepForm = FormGroup<{
  /** '' for a step that hasn't been saved yet; the backend assigns one. */
  id: FormControl<string>;
  type: FormControl<GuideType>;
  anchorId: FormControl<string>;
  position: FormControl<StepPosition>;
  content: FormControl<string>;
  actions: FormArray<ActionForm>;
}>;

/** Matches the backend's targetSelector convention: [data-guide-id="..."] */
const ANCHOR_ID_PATTERN = /^[A-Za-z0-9_-]*$/;
const SELECTOR_PATTERN = /^\[data-guide-id="([A-Za-z0-9_-]+)"\]$/;

/**
 * Form-based guide editor. Deliberately no visual DOM-overlay editor (out of
 * scope for v1): authors reference elements by the data-guide-id the product
 * engineers set via the [guideAnchor] / v-guide-anchor directives.
 */
@Component({
  selector: 'app-guide-editor',
  imports: [
    ReactiveFormsModule,
    RouterLink,
    DatePipe,
    VersionHistoryComponent,
    ReleasesComponent,
    AnalyticsComponent,
  ],
  templateUrl: './guide-editor.component.html',
})
export class GuideEditorComponent {
  private readonly api = inject(ApiService);
  private readonly router = inject(Router);
  private readonly fb = inject(FormBuilder).nonNullable;
  private readonly auth = inject(AuthService);
  // Route params, bound as inputs (withComponentInputBinding) so switching
  // guides/apps re-loads instead of showing stale data.
  readonly orgId = input.required<string>();
  readonly appId = input.required<string>();
  readonly id = input.required<string>();
  private get guideId(): string {
    return this.id();
  }
  protected readonly canEdit = computed(() => appRoleAtLeast(this.auth.appRole(this.appId()), 'editor'));
  protected readonly canPublish = computed(() =>
    appRoleAtLeast(this.auth.appRole(this.appId()), 'publisher'),
  );

  protected readonly guideTypes = GUIDE_TYPES;
  protected readonly positions = STEP_POSITIONS;
  protected readonly actionTypes = STEP_ACTIONS;

  protected readonly guide = signal<GuideDetail | null>(null);
  /** The app's saved pages, for the "Where" picker. */
  protected readonly pages = signal<AppPage[]>([]);
  protected readonly newPageName = signal('');
  protected readonly loading = signal(true);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly message = signal<string | null>(null);
  /** Which version the form was last loaded from (for the "editing from" hint). */
  protected readonly loadedFrom = signal<{ number: number; draft: boolean } | null>(null);
  protected readonly previewLink = signal<(PreviewLink & { versionNumber: number }) | null>(null);
  protected readonly copied = signal(false);
  /** Steps of the live version (else the newest), labelling the per-step analytics. */
  protected readonly analyticsSteps = computed(() => {
    const g = this.guide();
    if (!g) return [];
    const v = g.versions.find((x) => x.id === g.current_version_id) ?? g.versions[0];
    return v?.steps ?? [];
  });

  protected readonly form = this.fb.group({
    // Where the guide shows: one of the app's saved pages (it then follows the
    // page's URL as it's edited), or a route of its own.
    where: this.fb.control<'page' | 'custom'>('custom'),
    pageId: this.fb.control(''),
    routeType: this.fb.control<'exact' | 'pattern'>('exact'),
    routeValue: this.fb.control('/', [Validators.required, Validators.pattern(/^\//)]),
    startAt: this.fb.control(''),
    endAt: this.fb.control(''),
    // Audience: everyone, or only the listed account ids (one per line / comma separated).
    audience: this.fb.control<'all' | 'accounts'>('all'),
    accountIds: this.fb.control(''),
    // Visitor tags: everyone, or only visitors carrying at least one of the
    // listed tags (what the host app says they may do, e.g. "POINT_OF_SALE").
    tagAudience: this.fb.control<'all' | 'tags'>('all'),
    visitorTags: this.fb.control(''),
    // How the guide starts: automatically on its page, or only from the help center.
    activation: this.fb.control<GuideActivation>('auto'),
    // Help center listing (on-demand, searchable).
    helpListed: this.fb.control(false),
    helpTitle: this.fb.control('', Validators.maxLength(120)),
    helpDescription: this.fb.control('', Validators.maxLength(500)),
    helpKeywords: this.fb.control(''),
    helpStartPath: this.fb.control('', Validators.pattern(/^(\/(?!\/).*)?$/)),
    steps: this.fb.array<StepForm>([]),
  });

  get steps(): FormArray<StepForm> {
    return this.form.controls.steps;
  }

  constructor() {
    effect(() => {
      this.appId();
      this.id();
      untracked(() => this.load()); // untracked: the interceptor reads the auth token signal
    });
    // The custom-route fields only count while "A custom route" is chosen.
    // Disabling them keeps Angular's own validity honest (form.invalid,
    // ng-invalid styling), so validate() needs no special case; getRawValue()
    // still includes their values for "Save as page" and the auto-match below.
    this.form.controls.where.valueChanges.pipe(takeUntilDestroyed()).subscribe((where) => {
      for (const c of [this.form.controls.routeType, this.form.controls.routeValue]) {
        if (where === 'page') c.disable({ emitEvent: false });
        else c.enable({ emitEvent: false });
      }
      // Switching to "A saved page" picks the page matching the custom route, if one exists.
      const v = this.form.getRawValue();
      if (where !== 'page' || v.pageId) return;
      const match = this.pages().find(
        (p) => p.routeMatch.type === v.routeType && p.routeMatch.value === v.routeValue.trim(),
      );
      if (match) this.form.controls.pageId.setValue(match.id);
    });
  }

  /** First load: the guide and the app's pages together, so the form is populated once both are known. */
  private load(): void {
    this.loading.set(true);
    forkJoin({
      guide: this.api.getGuide(this.appId(), this.guideId),
      pages: this.api.listPages(this.appId()),
    }).subscribe({
      next: ({ guide, pages }) => {
        this.pages.set(pages);
        this.setGuide(guide, true);
      },
      error: (err) => {
        this.error.set(describeError(err));
        this.loading.set(false);
      },
    });
  }

  /** The saved page currently picked in the form (if any). */
  protected selectedPage(): AppPage | undefined {
    const v = this.form.getRawValue();
    return v.where === 'page' ? this.pages().find((p) => p.id === v.pageId) : undefined;
  }

  pageLabel(page: AppPage): string {
    return `${page.name} — ${page.routeMatch.value}`;
  }

  /** Saves the custom route as a reusable page and switches the guide onto it. */
  saveRouteAsPage(): void {
    const v = this.form.getRawValue();
    const name = this.newPageName().trim();
    if (!name) {
      this.error.set('Give the page a name, e.g. "Team settings".');
      return;
    }
    if (v.routeType === 'pattern' && !v.helpStartPath.trim()) {
      this.error.set(
        'A pattern page needs a start page — fill in the help center start page first, or use an exact path.',
      );
      return;
    }
    const routeMatch = { type: v.routeType, value: v.routeValue.trim() };
    this.run(
      this.api.createPage(this.appId(), {
        name,
        routeMatch,
        ...(v.routeType === 'pattern' ? { startPath: v.helpStartPath.trim() } : {}),
      }),
      (page) => {
        this.pages.update((list) => [...list, page].sort((a, b) => a.name.localeCompare(b.name)));
        this.form.patchValue({ where: 'page', pageId: page.id });
        // The page now carries the start page; the guide doesn't need its own.
        if (v.routeType === 'pattern') this.form.controls.helpStartPath.setValue('');
        this.form.markAsDirty();
        this.newPageName.set('');
        this.message.set(`Saved page “${page.name}”. Other guides can use it too.`);
      },
    );
  }

  /** Re-fetches the guide; optionally (re)populates the form from its live version. */
  reload(populate: boolean): void {
    this.api.getGuide(this.appId(), this.guideId).subscribe({
      next: (guide) => this.setGuide(guide, populate),
      error: (err) => {
        this.error.set(describeError(err));
        this.loading.set(false);
      },
    });
  }

  private setGuide(guide: GuideDetail, populate: boolean): void {
    this.guide.set(guide);
    this.loading.set(false);
    if (!populate) return;
    // Prefer the working draft (newest unpublished work), then the live version.
    const draft = guide.versions.find((v) => !v.published_at);
    const live = guide.versions.find((v) => v.id === guide.current_version_id);
    const source = draft ?? live ?? guide.versions[0];
    if (source) this.loadVersion(source);
    else this.resetToBlank(guide.type);
  }

  loadVersion(version: GuideVersion): void {
    this.form.patchValue({
      where: version.page_id ? 'page' : 'custom',
      pageId: version.page_id ?? '',
      routeType: version.route_match.type,
      routeValue: version.route_match.value,
      audience: version.account_ids?.length ? 'accounts' : 'all',
      accountIds: (version.account_ids ?? []).join('\n'),
      tagAudience: version.visitor_tags?.length ? 'tags' : 'all',
      visitorTags: (version.visitor_tags ?? []).join('\n'),
      activation: version.activation ?? 'auto',
      helpListed: version.help !== null && version.help !== undefined,
      helpTitle: version.help?.title ?? '',
      helpDescription: version.help?.description ?? '',
      helpKeywords: (version.help?.keywords ?? []).join(', '),
      helpStartPath: version.help?.startPath ?? '',
      startAt: toLocalInput(version.start_at),
      endAt: toLocalInput(version.end_at),
    });
    this.steps.clear();
    for (const step of version.steps) this.steps.push(this.stepForm(step));
    this.loadedFrom.set({ number: version.version_number, draft: !version.published_at });
    this.form.markAsPristine();
  }

  private resetToBlank(type: GuideType): void {
    // A brand-new guide starts on "A saved page" once the app has some.
    this.form.controls.where.setValue(this.pages().length ? 'page' : 'custom');
    this.steps.clear();
    this.steps.push(this.stepForm({ type }));
    this.loadedFrom.set(null);
  }

  // ---------- steps ----------

  addStep(): void {
    const type = this.guide()?.type ?? 'tooltip';
    this.steps.push(this.stepForm({ type }));
    this.form.markAsDirty();
  }

  removeStep(i: number): void {
    this.steps.removeAt(i);
    this.form.markAsDirty();
  }

  moveStep(i: number, delta: -1 | 1): void {
    const j = i + delta;
    if (j < 0 || j >= this.steps.length) return;
    const step = this.steps.at(i);
    this.steps.removeAt(i, { emitEvent: false });
    this.steps.insert(j, step);
    this.form.markAsDirty();
  }

  addAction(step: StepForm): void {
    step.controls.actions.push(this.actionForm({ label: 'Next', action: 'next' }));
    this.form.markAsDirty();
  }

  removeAction(step: StepForm, i: number): void {
    step.controls.actions.removeAt(i);
    this.form.markAsDirty();
  }

  private stepForm(step: Partial<StepPayload>): StepForm {
    const anchor = step.targetSelector?.match(SELECTOR_PATTERN)?.[1] ?? '';
    const actions = step.actions ?? [
      { label: 'Next', action: 'next' as const },
      { label: 'Dismiss', action: 'dismiss' as const },
    ];
    return this.fb.group({
      id: this.fb.control(step.id ?? ''),
      type: this.fb.control<GuideType>(step.type ?? 'tooltip'),
      anchorId: this.fb.control(anchor, Validators.pattern(ANCHOR_ID_PATTERN)),
      position: this.fb.control<StepPosition>(step.position ?? (anchor ? 'bottom' : 'center')),
      content: this.fb.control(step.content ?? '', [Validators.required, Validators.maxLength(20000)]),
      actions: this.fb.array(actions.map((a) => this.actionForm(a))),
    });
  }

  private actionForm(a: StepAction): ActionForm {
    return this.fb.group({
      label: this.fb.control(a.label, [Validators.required, Validators.maxLength(100)]),
      action: this.fb.control<StepActionType>(a.action),
    });
  }

  // ---------- publish / rollback ----------

  private buildPayload(): PublishPayload {
    const v = this.form.getRawValue();
    return {
      ...(v.where === 'page'
        ? { pageId: v.pageId }
        : { routeMatch: { type: v.routeType, value: v.routeValue.trim() } }),
      accountIds: v.audience === 'accounts' ? parseList(v.accountIds) : null,
      visitorTags: v.tagAudience === 'tags' ? parseList(v.visitorTags) : null,
      activation: v.activation,
      // An on-demand guide is only reachable from the help center, so it's always listed.
      help: this.helpListed()
        ? {
            title: v.helpTitle.trim() || this.guide()?.name || 'Untitled',
            description: v.helpDescription.trim(),
            keywords: [
              ...new Set(
                v.helpKeywords
                  .split(',')
                  .map((k) => k.trim())
                  .filter(Boolean),
              ),
            ],
            ...(v.helpStartPath.trim() ? { startPath: v.helpStartPath.trim() } : {}),
          }
        : null,
      ...(v.startAt ? { startAt: new Date(v.startAt).toISOString() } : {}),
      ...(v.endAt ? { endAt: new Date(v.endAt).toISOString() } : {}),
      steps: v.steps.map((s, order) => ({
        ...(s.id ? { id: s.id } : {}),
        order,
        type: s.type,
        ...(s.anchorId.trim() ? { targetSelector: `[data-guide-id="${s.anchorId.trim()}"]` } : {}),
        position: s.position,
        content: s.content,
        actions: s.actions,
      })),
    };
  }

  /** Listed in the help center: ticked, or implied by "only from the help center". */
  protected helpListed(): boolean {
    const v = this.form.getRawValue();
    return v.helpListed || v.activation === 'manual';
  }

  /** A wildcard route has no single page to send help-center visitors to. */
  protected helpNeedsStartPage(): boolean {
    const v = this.form.getRawValue();
    // Saved pattern pages always carry their own start page.
    return this.helpListed() && v.where === 'custom' && v.routeType === 'pattern' && !v.helpStartPath.trim();
  }

  /** Why the visitor-tags box can't be saved as typed, or null. Mirrors the backend's rule. */
  protected visitorTagProblem(): string | null {
    const v = this.form.getRawValue();
    if (v.tagAudience !== 'tags') return null;
    const tags = parseList(v.visitorTags) ?? [];
    if (tags.length === 0) return 'Audience: list at least one visitor tag, or choose "All visitors".';
    if (tags.length > MAX_GUIDE_TAGS) return `Audience: at most ${MAX_GUIDE_TAGS} visitor tags per guide.`;
    const bad = tags.find((t) => !VISITOR_TAG.test(t));
    return bad
      ? `Audience: "${bad}" isn't a valid visitor tag (letters, digits and _ . : / - only, up to 100 characters).`
      : null;
  }

  /** Placeholder for the help start page: what's used when it's left empty. */
  protected defaultStartPage(): string {
    const v = this.form.getRawValue();
    const page = this.selectedPage();
    if (page) return page.startPath ?? page.routeMatch.value;
    return v.routeType === 'exact' ? v.routeValue : '/projects/new';
  }

  private validate(action: string): boolean {
    this.form.markAllAsTouched();
    const v = this.form.getRawValue();
    if (v.where === 'page' && !this.selectedPage()) {
      this.error.set('Choose a saved page for this guide, or switch to a custom route.');
      return false;
    }
    const tagProblem = this.visitorTagProblem();
    if (tagProblem) {
      this.error.set(tagProblem);
      return false;
    }
    if (this.helpNeedsStartPage()) {
      this.error.set(
        'Help center: add a start page — the route is a pattern, so we need a page to send people to.',
      );
      return false;
    }
    if (this.form.invalid || this.steps.length === 0) {
      this.error.set(`Fix the highlighted fields before you ${action} (at least one step is required).`);
      return false;
    }
    return true;
  }

  /** Publishing sends the form, which the backend saves as the draft and promotes in one step. */
  publish(): void {
    if (!this.validate('publish')) return;
    this.run(this.api.publish(this.appId(), this.guideId, this.buildPayload()), (v) => {
      this.message.set(`Published v${v.versionNumber}.`);
      this.previewLink.set(null);
      this.reload(true);
    });
  }

  saveDraft(): void {
    if (!this.validate('save')) return;
    this.run(this.api.saveDraft(this.appId(), this.guideId, this.buildPayload()), (v) => {
      this.message.set(`Draft saved (v${v.versionNumber}, not live).`);
      this.form.markAsPristine();
      this.loadedFrom.set({ number: v.versionNumber, draft: true });
      this.reload(false);
    });
  }

  /** Saves the form as the draft first, so the preview shows exactly what's on screen. */
  previewDraft(): void {
    if (!this.validate('preview')) return;
    this.busy.set(true);
    this.api.saveDraft(this.appId(), this.guideId, this.buildPayload()).subscribe({
      next: (draft) => {
        this.form.markAsPristine();
        this.loadedFrom.set({ number: draft.versionNumber, draft: true });
        this.reload(false);
        this.mintPreview(draft.id, draft.versionNumber);
      },
      error: (err) => {
        this.busy.set(false);
        this.error.set(describeError(err));
      },
    });
  }

  previewVersion(version: GuideVersion): void {
    this.mintPreview(version.id, version.version_number);
  }

  private mintPreview(versionId: string, versionNumber: number): void {
    this.copied.set(false);
    this.run(this.api.previewLink(this.appId(), this.guideId, versionId), (link) => {
      this.previewLink.set({ ...link, versionNumber });
    });
  }

  copyPreview(): void {
    const link = this.previewLink();
    if (!link) return;
    void navigator.clipboard?.writeText(link.url ?? link.token).then(
      () => this.copied.set(true),
      () => this.error.set('Could not copy — select the link and copy it manually.'),
    );
  }

  rollback(versionNumber: number): void {
    if (
      !confirm(`Make v${versionNumber} the live version in production? End users will see it on their next page load.`)
    )
      return;
    this.run(this.api.rollback(this.appId(), this.guideId, versionNumber), () => {
      this.message.set(`Rolled back to v${versionNumber}.`);
      this.reload(false);
    });
  }

  /** Deletes the guide with everything attached to it; there is no undo, so say what goes. */
  remove(): void {
    const g = this.guide();
    if (!g) return;
    const live = g.enabled && g.current_version_id ? ' It is live: visitors stop seeing it right away.' : '';
    if (!confirm(`Delete the guide “${g.name}” with all its versions and analytics?${live}`)) return;
    this.run(this.api.deleteGuide(this.appId(), this.guideId), () => {
      void this.router.navigate(['/o', this.orgId(), 'apps', this.appId(), 'guides']);
    });
  }

  toggleEnabled(enabled: boolean): void {
    this.run(this.api.setEnabled(this.appId(), this.guideId, enabled), () => {
      this.guide.update((g) => (g ? { ...g, enabled } : g));
      this.message.set(enabled ? 'Guide enabled.' : 'Guide disabled.');
    });
  }

  private run<T>(obs: Observable<T>, onOk: (value: T) => void): void {
    runRequest({ busy: this.busy, error: this.error, message: this.message }, obs, onOk);
  }
}

/** ISO timestamp -> value for <input type="datetime-local"> in the author's local time. */
function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

/** A visitor tag, as the backend accepts it (auth/visitor.ts). */
const VISITOR_TAG = /^[A-Za-z0-9_.:/-]{1,100}$/;
const MAX_GUIDE_TAGS = 100;

/** Account ids or visitor tags from an audience box: one per line or comma separated, de-duplicated. */
function parseList(text: string): string[] | null {
  const items = [
    ...new Set(
      text
        .split(/[\n,]/)
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
  return items.length ? items : null;
}
