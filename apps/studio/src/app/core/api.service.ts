import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import {
  AnalyticsResponse,
  GuideDetail,
  GuideScope,
  GuideSummary,
  GuideType,
  PreviewLink,
  PublishPayload,
  PublishedVersion,
} from './models';

/**
 * Typed client for the guide-engine backend. All calls go through the dev
 * server proxy at /api (see proxy.conf.json) so the Studio needs no CORS.
 * Tenant scoping comes from the bearer token only — no tenant id is ever sent.
 */
@Injectable({ providedIn: 'root' })
export class ApiService {
  private readonly http = inject(HttpClient);

  /** Tenant guides live at /guides; global guides (platform admins) at /platform/guides. */
  private base(scope: GuideScope): string {
    return scope === 'global' ? '/api/platform/guides' : '/api/guides';
  }

  listGuides(scope: GuideScope): Observable<GuideSummary[]> {
    return this.http.get<GuideSummary[]>(this.base(scope));
  }

  createGuide(scope: GuideScope, name: string, type: GuideType): Observable<GuideSummary> {
    return this.http.post<GuideSummary>(this.base(scope), { name, type });
  }

  getGuide(scope: GuideScope, id: string): Observable<GuideDetail> {
    return this.http.get<GuideDetail>(`${this.base(scope)}/${id}`);
  }

  setEnabled(scope: GuideScope, id: string, enabled: boolean): Observable<{ id: string; enabled: boolean }> {
    return this.http.patch<{ id: string; enabled: boolean }>(`${this.base(scope)}/${id}/flag`, { enabled });
  }

  publish(scope: GuideScope, id: string, payload: PublishPayload): Observable<PublishedVersion> {
    return this.http.post<PublishedVersion>(`${this.base(scope)}/${id}/publish`, payload);
  }

  /** Saves work-in-progress as the guide's single draft (not live). */
  saveDraft(scope: GuideScope, id: string, payload: PublishPayload): Observable<PublishedVersion> {
    return this.http.put<PublishedVersion>(`${this.base(scope)}/${id}/draft`, payload);
  }

  previewLink(scope: GuideScope, id: string, versionId: string): Observable<PreviewLink> {
    return this.http.post<PreviewLink>(`${this.base(scope)}/${id}/preview-token`, { versionId });
  }

  rollback(scope: GuideScope, id: string, versionNumber: number): Observable<unknown> {
    return this.http.post(`${this.base(scope)}/${id}/rollback/${versionNumber}`, {});
  }

  analytics(scope: GuideScope, id: string): Observable<AnalyticsResponse> {
    return this.http.get<AnalyticsResponse>(`${this.base(scope)}/${id}/analytics`);
  }
}

/** Human-readable message from a backend error response. */
export function describeError(err: unknown): string {
  if (err instanceof HttpErrorResponse) {
    const body = err.error as { error?: string; details?: { fieldErrors?: Record<string, string[]>; formErrors?: string[] } } | null;
    if (err.status === 0) return 'Cannot reach the backend. Is it running on :3000?';
    if (body?.error === 'preview_not_configured') return 'Preview is not configured on the backend (PREVIEW_TOKEN_SECRET).';
    if (body?.error === 'empty_content_after_sanitize') {
      return 'A step has no content left after removing unsafe HTML (e.g. scripts). Add some text.';
    }
    if (body?.details) {
      const fields = Object.entries(body.details.fieldErrors ?? {}).map(([k, v]) => `${k}: ${v.join(', ')}`);
      const all = [...(body.details.formErrors ?? []), ...fields];
      if (all.length) return `Validation failed — ${all.join('; ')}`;
    }
    if (err.status === 403) return 'You don\'t have the role needed for this (guide_admin or platform_admin).';
    if (err.status === 404) return 'Not found.';
    return body?.error ? `Request failed: ${body.error}` : `Request failed (${err.status}).`;
  }
  return 'Something went wrong.';
}
