import { DatePipe } from '@angular/common';
import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormArray, FormBuilder, FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { ApiService, describeError } from '../core/api.service';
import {
  GUIDE_TYPES,
  GuideDetail,
  GuideScope,
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
  imports: [ReactiveFormsModule, RouterLink, DatePipe, VersionHistoryComponent, AnalyticsComponent],
  templateUrl: './guide-editor.component.html',
})
export class GuideEditorComponent implements OnInit {
  private readonly api = inject(ApiService);
  private readonly fb = inject(FormBuilder).nonNullable;
  private readonly route = inject(ActivatedRoute).snapshot;
  private readonly guideId = this.route.paramMap.get('id')!;
  protected readonly scope: GuideScope = this.route.data['scope'] ?? 'tenant';
  protected readonly basePath = this.scope === 'global' ? '/global' : '/guides';

  protected readonly guideTypes = GUIDE_TYPES;
  protected readonly positions = STEP_POSITIONS;
  protected readonly actionTypes = STEP_ACTIONS;

  protected readonly guide = signal<GuideDetail | null>(null);
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
    routeType: this.fb.control<'exact' | 'pattern'>('exact'),
    routeValue: this.fb.control('/', [Validators.required, Validators.pattern(/^\//)]),
    startAt: this.fb.control(''),
    endAt: this.fb.control(''),
    steps: this.fb.array<StepForm>([]),
  });

  get steps(): FormArray<StepForm> {
    return this.form.controls.steps;
  }

  ngOnInit(): void {
    this.reload(true);
  }

  /** Re-fetches the guide; optionally (re)populates the form from its live version. */
  reload(populate: boolean): void {
    this.api.getGuide(this.scope, this.guideId).subscribe({
      next: (guide) => {
        this.guide.set(guide);
        this.loading.set(false);
        if (populate) {
          // Prefer the working draft (newest unpublished work), then the live version.
          const draft = guide.versions.find((v) => !v.published_at);
          const live = guide.versions.find((v) => v.id === guide.current_version_id);
          const source = draft ?? live ?? guide.versions[0];
          if (source) this.loadVersion(source);
          else this.resetToBlank(guide.type);
        }
      },
      error: (err) => {
        this.error.set(describeError(err));
        this.loading.set(false);
      },
    });
  }

  loadVersion(version: GuideVersion): void {
    this.form.patchValue({
      routeType: version.route_match.type,
      routeValue: version.route_match.value,
      startAt: toLocalInput(version.start_at),
      endAt: toLocalInput(version.end_at),
    });
    this.steps.clear();
    for (const step of version.steps) this.steps.push(this.stepForm(step));
    this.loadedFrom.set({ number: version.version_number, draft: !version.published_at });
    this.form.markAsPristine();
  }

  private resetToBlank(type: GuideType): void {
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
      routeMatch: { type: v.routeType, value: v.routeValue.trim() },
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

  private validate(action: string): boolean {
    this.form.markAllAsTouched();
    if (this.form.invalid || this.steps.length === 0) {
      this.error.set(`Fix the highlighted fields before you ${action} (at least one step is required).`);
      return false;
    }
    return true;
  }

  /** Publishing sends the form, which the backend saves as the draft and promotes in one step. */
  publish(): void {
    if (!this.validate('publish')) return;
    this.run(this.api.publish(this.scope, this.guideId, this.buildPayload()), (v) => {
      this.message.set(`Published v${v.versionNumber}.`);
      this.previewLink.set(null);
      this.reload(true);
    });
  }

  saveDraft(): void {
    if (!this.validate('save')) return;
    this.run(this.api.saveDraft(this.scope, this.guideId, this.buildPayload()), (v) => {
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
    this.api.saveDraft(this.scope, this.guideId, this.buildPayload()).subscribe({
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
    this.run(this.api.previewLink(this.scope, this.guideId, versionId), (link) => {
      this.previewLink.set({ ...link, versionNumber });
    });
  }

  copyPreview(): void {
    const link = this.previewLink();
    if (!link) return;
    void navigator.clipboard?.writeText(link.url ?? link.token).then(
      () => this.copied.set(true),
      () => this.error.set('Could not copy — select the link and copy it manually.')
    );
  }

  rollback(versionNumber: number): void {
    if (!confirm(`Make v${versionNumber} the live version? End users will see it on their next page load.`)) return;
    this.run(this.api.rollback(this.scope, this.guideId, versionNumber), () => {
      this.message.set(`Rolled back to v${versionNumber}.`);
      this.reload(false);
    });
  }

  toggleEnabled(enabled: boolean): void {
    this.run(this.api.setEnabled(this.scope, this.guideId, enabled), () => {
      this.guide.update((g) => (g ? { ...g, enabled } : g));
      this.message.set(enabled ? 'Guide enabled.' : 'Guide disabled.');
    });
  }

  private run<T>(obs: import('rxjs').Observable<T>, onOk: (value: T) => void): void {
    this.busy.set(true);
    this.error.set(null);
    this.message.set(null);
    obs.subscribe({
      next: (value) => {
        this.busy.set(false);
        onOk(value);
      },
      error: (err) => {
        this.busy.set(false);
        this.error.set(describeError(err));
      },
    });
  }
}

/** ISO timestamp -> value for <input type="datetime-local"> in the author's local time. */
function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}
