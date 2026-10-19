import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import {
  AnalyticsResponse,
  App,
  AppPage,
  AppRole,
  GuideDetail,
  GuideSummary,
  GuideType,
  HelpPosition,
  Invitation,
  InvitationPreview,
  Member,
  OrgRole,
  PagePayload,
  PreviewLink,
  PublishPayload,
  PublishedVersion,
} from './models';

/**
 * Typed client for the Studio API. All calls go to /api/v1 on the Studio's
 * own origin; the dev server (proxy.conf.json) or a production reverse proxy
 * forwards them to the backend, so the Studio needs no CORS. What the user
 * can reach is decided server-side from their memberships.
 */
@Injectable({ providedIn: 'root' })
export class ApiService {
  private readonly http = inject(HttpClient);
  private readonly base = '/api/v1';

  // ---- organizations & apps ----
  createOrg(name: string, app: { name: string; websites: string[] }) {
    return this.http.post<{ org: { id: string; name: string }; app: App }>(`${this.base}/orgs`, {
      name,
      app,
    });
  }

  listApps(orgId: string): Observable<App[]> {
    return this.http.get<App[]>(`${this.base}/orgs/${orgId}/apps`);
  }

  createApp(orgId: string, name: string, websites: string[]): Observable<App> {
    return this.http.post<App>(`${this.base}/orgs/${orgId}/apps`, { name, websites });
  }

  getApp(appId: string): Observable<App> {
    return this.http.get<App>(`${this.base}/apps/${appId}`);
  }

  updateApp(
    appId: string,
    patch: {
      name?: string;
      websites?: string[];
      identityMode?: 'optional' | 'required';
      enabled?: boolean;
      helpEnabled?: boolean;
      helpButtonLabel?: string;
      helpButtonColor?: string;
      helpPosition?: HelpPosition;
    },
  ): Observable<App> {
    return this.http.patch<App>(`${this.base}/apps/${appId}`, patch);
  }

  rotateKey(appId: string): Observable<App> {
    return this.http.post<App>(`${this.base}/apps/${appId}/rotate-key`, {});
  }

  createSigningSecret(appId: string): Observable<{ secret: string }> {
    return this.http.post<{ secret: string }>(`${this.base}/apps/${appId}/signing-secret`, {});
  }

  // ---- members & invitations ----
  listMembers(orgId: string): Observable<Member[]> {
    return this.http.get<Member[]>(`${this.base}/orgs/${orgId}/members`);
  }

  updateMember(
    orgId: string,
    userId: string,
    patch: { orgRole?: OrgRole; appRoles?: Record<string, AppRole | null> },
  ) {
    return this.http.patch<void>(`${this.base}/orgs/${orgId}/members/${userId}`, patch);
  }

  removeMember(orgId: string, userId: string) {
    return this.http.delete<void>(`${this.base}/orgs/${orgId}/members/${userId}`);
  }

  listInvitations(orgId: string): Observable<Invitation[]> {
    return this.http.get<Invitation[]>(`${this.base}/orgs/${orgId}/invitations`);
  }

  createInvitation(
    orgId: string,
    body: { email?: string; orgRole: 'admin' | 'member'; appRoles: Record<string, AppRole> },
  ) {
    return this.http.post<Invitation & { token: string }>(`${this.base}/orgs/${orgId}/invitations`, body);
  }

  revokeInvitation(orgId: string, invitationId: string) {
    return this.http.delete<void>(`${this.base}/orgs/${orgId}/invitations/${invitationId}`);
  }

  getInvitation(token: string): Observable<InvitationPreview> {
    return this.http.get<InvitationPreview>(`${this.base}/invitations/${encodeURIComponent(token)}`);
  }

  acceptInvitation(token: string): Observable<{ orgId: string }> {
    return this.http.post<{ orgId: string }>(
      `${this.base}/invitations/${encodeURIComponent(token)}/accept`,
      {},
    );
  }

  // ---- saved pages (per app) ----
  private pages(appId: string): string {
    return `${this.base}/apps/${appId}/pages`;
  }

  listPages(appId: string): Observable<AppPage[]> {
    return this.http.get<AppPage[]>(this.pages(appId));
  }

  getPage(appId: string, pageId: string): Observable<AppPage> {
    return this.http.get<AppPage>(`${this.pages(appId)}/${pageId}`);
  }

  createPage(appId: string, body: PagePayload): Observable<AppPage> {
    return this.http.post<AppPage>(this.pages(appId), body);
  }

  updatePage(appId: string, pageId: string, body: PagePayload): Observable<AppPage> {
    return this.http.put<AppPage>(`${this.pages(appId)}/${pageId}`, body);
  }

  deletePage(appId: string, pageId: string): Observable<void> {
    return this.http.delete<void>(`${this.pages(appId)}/${pageId}`);
  }

  // ---- guides (per app) ----
  private guides(appId: string): string {
    return `${this.base}/apps/${appId}/guides`;
  }

  listGuides(appId: string): Observable<GuideSummary[]> {
    return this.http.get<GuideSummary[]>(this.guides(appId));
  }

  createGuide(appId: string, name: string, type: GuideType): Observable<GuideSummary> {
    return this.http.post<GuideSummary>(this.guides(appId), { name, type });
  }

  getGuide(appId: string, id: string): Observable<GuideDetail> {
    return this.http.get<GuideDetail>(`${this.guides(appId)}/${id}`);
  }

  setEnabled(appId: string, id: string, enabled: boolean): Observable<{ id: string; enabled: boolean }> {
    return this.http.patch<{ id: string; enabled: boolean }>(`${this.guides(appId)}/${id}/flag`, { enabled });
  }

  publish(appId: string, id: string, payload: PublishPayload): Observable<PublishedVersion> {
    return this.http.post<PublishedVersion>(`${this.guides(appId)}/${id}/publish`, payload);
  }

  /** Saves work-in-progress as the guide's single draft (not live). */
  saveDraft(appId: string, id: string, payload: PublishPayload): Observable<PublishedVersion> {
    return this.http.put<PublishedVersion>(`${this.guides(appId)}/${id}/draft`, payload);
  }

  previewLink(appId: string, id: string, versionId: string): Observable<PreviewLink> {
    return this.http.post<PreviewLink>(`${this.guides(appId)}/${id}/preview-token`, { versionId });
  }

  rollback(appId: string, id: string, versionNumber: number): Observable<unknown> {
    return this.http.post(`${this.guides(appId)}/${id}/rollback/${versionNumber}`, {});
  }

  analytics(appId: string, id: string): Observable<AnalyticsResponse> {
    return this.http.get<AnalyticsResponse>(`${this.guides(appId)}/${id}/analytics`);
  }
}

const MESSAGES: Record<string, string> = {
  preview_not_configured: 'Preview is not configured on the backend (PREVIEW_TOKEN_SECRET).',
  empty_content_after_sanitize:
    'A step has no content left after removing unsafe HTML (e.g. scripts). Add some text.',
  signing_secret_required: 'Generate a signing secret first, then require signed identity.',
  last_owner: 'An organization needs at least one owner. Make someone else an owner first.',
  invitation_used: 'This invitation has already been used.',
  invitation_expired: 'This invitation has expired. Ask for a new one.',
  invitation_email_mismatch: 'This invitation was sent to a different email address.',
  already_member: "You're already a member of this organization.",
  unknown_app: 'One of the selected apps no longer exists.',
  no_draft_to_publish: 'There is no saved draft to publish.',
  page_name_taken: 'This app already has a page with that name.',
  unknown_page: 'That saved page no longer exists. Pick another page or use a custom route.',
};

/** Human-readable message from a backend error response. */
export function describeError(err: unknown): string {
  if (err instanceof HttpErrorResponse) {
    const body = err.error as {
      error?: string;
      details?: { fieldErrors?: Record<string, string[]>; formErrors?: string[] };
    } | null;
    if (err.status === 0) return 'Cannot reach the backend. Is it running on :3000?';
    if (body?.error === 'page_in_use') {
      const names = (body.details as { guides?: Array<{ name: string }> } | undefined)?.guides?.map(
        (g) => g.name,
      );
      return `This page is used by ${names?.length ? names.join(', ') : 'guides'}. Move them to another page first.`;
    }
    if (body?.error && MESSAGES[body.error]) return MESSAGES[body.error];
    if (body?.details) {
      const fields = Object.entries(body.details.fieldErrors ?? {}).map(([k, v]) => `${k}: ${v.join(', ')}`);
      const all = [...(body.details.formErrors ?? []), ...fields];
      if (all.length) return `Validation failed — ${all.join('; ')}`;
    }
    if (err.status === 403) return "Your role doesn't allow this.";
    if (err.status === 404) return 'Not found.';
    return body?.error ? `Request failed: ${body.error}` : `Request failed (${err.status}).`;
  }
  return 'Something went wrong.';
}
