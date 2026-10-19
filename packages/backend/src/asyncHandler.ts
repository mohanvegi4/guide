import { NextFunction, Request, RequestHandler, Response } from 'express';
import { AuthedRequest } from './middleware/tenant';

/**
 * Express 4 does not catch rejected promises from async handlers: a thrown
 * DB error becomes an unhandledRejection and the request hangs until the
 * client times out. Wrapping every async route forwards the error to the
 * centralized error handler in app.ts instead (which returns a generic 500).
 */
export function asyncHandler(
  fn: (req: AuthedRequest, res: Response, next: NextFunction) => Promise<unknown>
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req as AuthedRequest, res, next).catch(next);
  };
}
