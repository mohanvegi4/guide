/**
 * Thrown inside route handlers (including inside DB transactions, which then
 * roll back) and turned into a JSON error response by the handler in app.ts.
 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly details?: unknown
  ) {
    super(code);
  }
}

/** 404 for "doesn't exist" AND "exists but not yours": ids can't be probed. */
export const notFound = () => new HttpError(404, 'not_found');
export const forbidden = () => new HttpError(403, 'forbidden');
