import { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * Express 4 does not catch rejected promises from async handlers: a thrown
 * error becomes an unhandledRejection and the request hangs until the client
 * times out. Wrapping every async route forwards the error to the centralized
 * error handler in app.ts instead (HttpError -> its status; anything else ->
 * a generic 500).
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>
): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}
