/**
 * One place for what a guide version looks like outside the database: the
 * Studio API (routes/studio/guides.ts) and the organization export
 * (services/lifecycle.ts) both read versions through these, so a new
 * guide_version column only has to be added here.
 */

const VERSION_COLUMN_NAMES = [
  'id',
  'version_number',
  'steps',
  'route_match',
  'page_id',
  'start_at',
  'end_at',
  'account_ids',
  'visitor_tags',
  'help',
  'activation',
  'published_at',
] as const;

/** The guide_version columns a version read selects, optionally qualified with a table alias. */
export function versionColumns(alias?: string): string {
  return VERSION_COLUMN_NAMES.map((c) => (alias ? `${alias}.${c}` : c)).join(', ');
}

export interface VersionRow {
  id: string;
  version_number: number;
  steps: unknown;
  route_match: unknown;
  page_id: string | null;
  start_at: string | null;
  end_at: string | null;
  account_ids: string[] | null;
  visitor_tags: string[] | null;
  help: unknown;
  activation: 'auto' | 'manual';
  published_at: string | null;
}

export interface VersionResponse {
  id: string;
  versionNumber: number;
  steps: unknown;
  routeMatch: unknown;
  pageId: string | null;
  startAt: string | null;
  endAt: string | null;
  accountIds: string[] | null;
  visitorTags: string[] | null;
  help: unknown;
  activation: 'auto' | 'manual';
  publishedAt: string | null;
}

export function toVersionResponse(row: VersionRow): VersionResponse {
  return {
    id: row.id,
    versionNumber: row.version_number,
    steps: row.steps,
    routeMatch: row.route_match,
    pageId: row.page_id,
    startAt: row.start_at,
    endAt: row.end_at,
    accountIds: row.account_ids,
    visitorTags: row.visitor_tags,
    help: row.help,
    activation: row.activation,
    publishedAt: row.published_at,
  };
}
