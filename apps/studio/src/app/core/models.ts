// Mirrors the backend's Studio API (packages/backend/src/routes/studio/*).
// Responses that are database rows use snake_case; request bodies use camelCase.

export const GUIDE_TYPES = ['tooltip', 'modal', 'banner', 'tour', 'checklist', 'survey', 'beacon'] as const;
export type GuideType = (typeof GUIDE_TYPES)[number];

export const STEP_POSITIONS = ['bottom', 'top', 'left', 'right', 'center'] as const;
export type StepPosition = (typeof STEP_POSITIONS)[number];

export const STEP_ACTIONS = ['next', 'back', 'dismiss', 'complete'] as const;
export type StepActionType = (typeof STEP_ACTIONS)[number];

export type GuideStatus = 'draft' | 'published' | 'archived';

export type OrgRole = 'owner' | 'admin' | 'member';
export const APP_ROLES = ['viewer', 'editor', 'publisher', 'app_admin'] as const;
export type AppRole = (typeof APP_ROLES)[number];

const APP_ROLE_RANK: Record<AppRole, number> = { viewer: 0, editor: 1, publisher: 2, app_admin: 3 };
export function appRoleAtLeast(role: AppRole | undefined, min: AppRole): boolean {
  return role !== undefined && APP_ROLE_RANK[role] >= APP_ROLE_RANK[min];
}
export const isOrgAdmin = (role: OrgRole | undefined) => role === 'owner' || role === 'admin';

/** GET /v1/me */
export interface Me {
  user: { id: string; email: string | null; name: string | null; platformAdmin: boolean };
  orgs: MyOrg[];
}
export interface MyOrg {
  id: string;
  name: string;
  role: OrgRole;
  /** Set by a platform admin: the org's apps serve no guides until lifted. */
  suspendedAt: string | null;
  apps: Array<{ id: string; name: string; role: AppRole }>;
  /** Present only in support mode: a platform admin viewing this org read-only until then. */
  supportAccessUntil?: string;
}

// ---- Guide Engine administration (platform admins) ----

/** GET /v1/platform/orgs */
export interface PlatformOrg {
  id: string;
  name: string;
  createdAt: string;
  suspendedAt: string | null;
  /** The open support window, or null when not granted / expired. */
  supportAccessUntil: string | null;
  owners: Array<{ name: string | null; email: string | null }>;
  usage: { members: number; apps: number; guides: number; events30d: number };
}

export interface PlatformOrgDetail extends PlatformOrg {
  apps: Array<{
    id: string;
    name: string;
    publicKey: string;
    enabled: boolean;
    websites: string[];
    createdAt: string;
    usage: { guides: number; events30d: number; errors24h: number };
  }>;
}

/** GET /v1/apps/:appId/errors — an exception the install snippet reported from a customer's page. */
export interface AgentError {
  id: string;
  message: string;
  stack: string | null;
  agentVersion: string | null;
  url: string | null;
  occurredAt: string;
}

export interface PlatformAdmin {
  id: string;
  email: string | null;
  name: string | null;
  lastSeenAt: string;
}

/** GET /v1/orgs/:orgId/support-access — what the organization granted, and who used it. */
export interface SupportAccess {
  active: boolean;
  until: string | null;
  grantedBy: { name: string | null; email: string | null } | null;
  maxDays: number;
  log: Array<{
    method: string;
    path: string;
    occurredAt: string;
    admin: { name: string | null; email: string | null };
  }>;
}

/** GET /v1/support-context (with X-Support-Org): the org as a platform admin may see it. */
export interface SupportContext {
  id: string;
  name: string;
  role: 'member';
  apps: Array<{ id: string; name: string; role: 'viewer' }>;
  supportAccessUntil: string;
}

/** Where the help list (and its "Go to another page?" dialog) appears. */
export const HELP_POSITIONS = [
  ['bottom-right', 'Bottom right'],
  ['bottom-left', 'Bottom left'],
  ['top-right', 'Top right'],
  ['top-left', 'Top left'],
  ['center', 'Center of the screen'],
] as const;
export type HelpPosition = (typeof HELP_POSITIONS)[number][0];

/** How the app's router addresses pages; decides which part of the URL guides are matched on. */
export const ROUTE_MODES = [
  ['path', 'Path (/settings/team)'],
  ['hash', 'Hash (/#/settings/team)'],
] as const;
export type RouteMode = (typeof ROUTE_MODES)[number][0];

export interface App {
  id: string;
  org_id: string;
  name: string;
  public_key: string;
  allowed_origins: string[];
  identity_mode: 'optional' | 'required';
  has_signing_secret: boolean;
  enabled: boolean;
  help_enabled: boolean;
  help_button_label: string;
  help_button_color: string;
  help_position: HelpPosition;
  route_mode: RouteMode;
  created_at: string;
  role: AppRole;
  /** Present on GET /v1/apps/:id — the exact <head> snippet for this app. */
  snippet?: string;
}

export interface Member {
  userId: string;
  email: string | null;
  name: string | null;
  orgRole: OrgRole;
  appRoles: Record<string, AppRole>;
}

export interface Invitation {
  id: string;
  email: string | null;
  org_role: OrgRole;
  app_roles: Record<string, AppRole>;
  expires_at: string;
  token?: string; // only right after creation
  emailSent?: boolean; // only right after creation: the invite was emailed to `email`
}

export interface InvitationPreview {
  orgId: string;
  orgName: string;
  email: string | null;
  orgRole: OrgRole;
  apps: Array<{ id: string; name: string; role: AppRole }>;
  expired: boolean;
  accepted: boolean;
}

export interface GuideSummary {
  id: string;
  name: string;
  type: GuideType;
  status: GuideStatus;
  enabled: boolean;
  current_version_id: string | null;
  current_version_number: number | null;
  updated_at: string;
  /** The saved page the live version shows on (null = custom route / nothing live). */
  page_id: string | null;
  page_name: string | null;
}

export interface StepAction {
  label: string;
  action: StepActionType;
}

export interface StepPayload {
  /** Present for existing steps; keeps the step's identity (and analytics) across versions. */
  id?: string;
  order: number;
  type: GuideType;
  targetSelector?: string;
  content: string;
  position?: StepPosition;
  actions: StepAction[];
}

export interface RouteMatch {
  type: 'exact' | 'pattern';
  value: string;
}

export interface GuideVersion {
  id: string;
  guide_id: string;
  version_number: number;
  steps: Array<StepPayload & { id: string }>;
  /** Custom route, or a snapshot of the saved page's route when page_id is set. */
  route_match: RouteMatch;
  /** Saved page the version shows on; the guide follows the page's current URL. */
  page_id: string | null;
  start_at: string | null;
  end_at: string | null;
  /** null = every account */
  account_ids: string[] | null;
  /** null = not listed in the help center */
  help: HelpListing | null;
  /** null = unpublished draft */
  published_at: string | null;
  created_at: string;
}

export interface GuideDetail {
  id: string;
  name: string;
  type: GuideType;
  status: GuideStatus;
  enabled: boolean;
  current_version_id: string | null;
  versions: GuideVersion[];
}

/** How a guide appears in the help center. startPath: where visitors are sent before it starts. */
export interface HelpListing {
  title: string;
  description: string;
  keywords: string[];
  startPath?: string;
}

/** Exactly one of pageId (a saved page) or routeMatch (a custom route). */
export interface PublishPayload {
  steps: StepPayload[];
  pageId?: string;
  routeMatch?: RouteMatch;
  startAt?: string;
  endAt?: string;
  accountIds?: string[] | null;
  help?: HelpListing | null;
}

export interface PublishedVersion {
  id: string;
  versionNumber: number;
}

export interface PreviewLink {
  token: string;
  /** Null when the app has no websites configured. */
  url: string | null;
  expiresAt: string;
}

export interface AnalyticsResponse {
  guideId: string;
  counts: Array<{ event_type: string; count: number }>;
  steps: Array<{ step_id: string; event_type: string; count: number }>;
  /** Times the guide was started on demand from the help center. */
  startedFromHelp: number;
  /** Only with `?by=account`: the 50 accounts shown the guide most, most first. */
  accounts?: AccountAnalytics[];
}

export interface AccountAnalytics {
  /** null: visitors the host page didn't attach to an account. */
  accountId: string | null;
  shown: number;
  completed: number;
  dismissed: number;
  /** Distinct visitors of that account. */
  visitors: number;
}

/** GET /v1/apps/:appId/analytics — every guide's lifetime totals, plus recent reach. */
export interface AppAnalytics {
  guides: Array<{
    guideId: string;
    name: string;
    shown: number;
    completed: number;
    dismissed: number;
    /** completed / shown as a fraction (0–1); 0 when never shown. */
    completionRate: number;
  }>;
  /** Distinct visitors / accounts across all guides in the last `windowDays`. */
  visitors: number;
  accounts: number;
  windowDays: number;
}

/** GET /v1/apps/:appId/help-analytics — how the help center was used over the last `days`. */
export interface HelpAnalytics {
  days: number;
  opens: number;
  searches: number;
  /** Guides started from the help center (guide_shown with source = help). */
  guidesStarted: number;
  /** The most common search queries (normalized), with the average number of topics they matched. */
  topQueries: Array<{ query: string; count: number; avgResults: number | null }>;
}

/** GET /v1/apps/:appId/pages — a saved page: a named, reusable URL rule. */
export interface AppPage {
  id: string;
  name: string;
  routeMatch: RouteMatch;
  /** Where the help center sends visitors for guides on this page (null = the exact URL). */
  startPath: string | null;
  createdAt: string;
  updatedAt: string;
  /** In lists: guides whose live version or draft is on the page. */
  usage?: { guides: number; live: number };
  /** In single-page reads and updates. */
  guides?: Array<{ id: string; name: string; live: boolean; draft: boolean }>;
}

export interface PagePayload {
  name: string;
  routeMatch: RouteMatch;
  startPath?: string | null;
}
