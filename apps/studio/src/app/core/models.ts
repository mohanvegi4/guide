// Mirrors the backend's request/response shapes (packages/backend/src/routes/guides.ts).
// Admin endpoints return DB rows (snake_case); request bodies are camelCase.

export const GUIDE_TYPES = ['tooltip', 'modal', 'banner', 'tour', 'checklist', 'survey', 'beacon'] as const;
export type GuideType = (typeof GUIDE_TYPES)[number];

export const STEP_POSITIONS = ['bottom', 'top', 'left', 'right', 'center'] as const;
export type StepPosition = (typeof STEP_POSITIONS)[number];

export const STEP_ACTIONS = ['next', 'back', 'dismiss', 'complete'] as const;
export type StepActionType = (typeof STEP_ACTIONS)[number];

export type GuideStatus = 'draft' | 'published' | 'archived';

/** 'tenant' = the signed-in tenant's own guides; 'global' = shown to every tenant (platform admins). */
export type GuideScope = 'tenant' | 'global';

export const GUIDE_ADMIN = 'guide_admin';
export const PLATFORM_ADMIN = 'platform_admin';

export interface GuideSummary {
  id: string;
  name: string;
  type: GuideType;
  status: GuideStatus;
  enabled: boolean;
  current_version_id: string | null;
  current_version_number: number | null;
  updated_at: string;
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
  route_match: RouteMatch;
  start_at: string | null;
  end_at: string | null;
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

export interface PublishPayload {
  steps: StepPayload[];
  routeMatch: RouteMatch;
  startAt?: string;
  endAt?: string;
}

export interface PublishedVersion {
  id: string;
  versionNumber: number;
}

export interface PreviewLink {
  token: string;
  /** Null when the backend has no PREVIEW_APP_BASE_URL configured. */
  url: string | null;
  expiresAt: string;
}

export interface AnalyticsResponse {
  guideId: string;
  counts: Array<{ event_type: string; count: number }>;
  steps: Array<{ step_id: string; event_type: string; count: number }>;
}
