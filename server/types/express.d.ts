import type { Request as _Request } from 'express';

declare global {
  namespace Express {
    interface Request {
      /** B-1: trace identifier injected by the traceIdMiddleware. */
      traceId?: string;
    }
  }
}

export {};
