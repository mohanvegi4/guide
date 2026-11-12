import { randomUUID } from 'crypto';
import type { IncomingMessage, ServerResponse } from 'http';
import type { Request, RequestHandler, Response } from 'express';
import pino, { Logger } from 'pino';
import pinoHttp from 'pino-http';
import { agentKeyPrefix, routeLabel } from './routeLabel';

/**
 * One structured logger for the backend: JSON lines on stdout, one object per
 * event, so a log shipper can index them without parsing free text. Pretty
 * output is a developer's terminal concern (`| npx pino-pretty`), not a
 * runtime dependency.
 *
 * What is never logged: request bodies, headers, tokens, full public keys.
 * Request lines carry the route pattern rather than the raw URL.
 */
export function createLogger(
  env: NodeJS.ProcessEnv = process.env,
  destination: pino.DestinationStream = pino.destination(1),
): Logger {
  // Tests are silent unless LOG_LEVEL asks otherwise; everything else logs info and up.
  const level = env.LOG_LEVEL || (env.NODE_ENV === 'test' ? 'silent' : 'info');
  return pino(
    {
      level,
      base: { service: 'guide-engine-backend' },
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: { level: (label) => ({ level: label }) },
    },
    destination,
  );
}

export const logger = createLogger();

// Honour a request id from the proxy/caller so one id follows a request across
// services; anything that isn't a short safe token is replaced, so a header
// can't inject newlines or megabytes into the log stream.
const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export function requestIdFrom(req: IncomingMessage): string {
  const incoming = req.headers['x-request-id'];
  return typeof incoming === 'string' && REQUEST_ID.test(incoming) ? incoming : randomUUID();
}

/** Assigns the request id, echoes it in `X-Request-Id`, and logs one line per completed request. */
export function requestLogging(log: Logger = logger): RequestHandler {
  return pinoHttp({
    logger: log,
    genReqId: (req, res) => {
      const id = requestIdFrom(req);
      res.setHeader('X-Request-Id', id);
      return id;
    },
    customAttributeKeys: { reqId: 'requestId' },
    // req.log carries only the request id: no serialized request object
    // (its headers would include Authorization).
    quietReqLogger: true,
    quietResLogger: true,
    customLogLevel: (_req, res) => (res.statusCode >= 500 ? 'error' : 'info'),
    customSuccessMessage: () => 'request completed',
    customErrorMessage: () => 'request completed',
    customSuccessObject: (req, res, val: { responseTime: number }) => requestLine(req, res, val),
    customErrorObject: (req, res, _err, val: { responseTime: number }) => requestLine(req, res, val),
    // Probes every few seconds would drown the real traffic.
    autoLogging: { ignore: (req) => /^\/(?:health|ready|metrics)(?:\?|$)/.test(req.url ?? '') },
  });
}

function requestLine(req: IncomingMessage, res: ServerResponse, val: { responseTime: number }) {
  const request = req as Request;
  const keyPrefix = agentKeyPrefix(request);
  return {
    method: request.method,
    route: routeLabel(request, res as Response),
    status: res.statusCode,
    durationMs: val.responseTime,
    ...(keyPrefix ? { keyPrefix } : {}),
  };
}

/** The request-scoped logger pino-http attached, or the root logger outside a request. */
export function requestLogger(req: Request): Logger {
  return (req as Request & { log?: Logger }).log ?? logger;
}
