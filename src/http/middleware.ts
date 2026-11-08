import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { WithId } from 'mongodb';
import type { UserDoc } from '../db/documents.js';
import type { Store } from '../services/store.js';
import { ApiError } from './errors.js';

/** passes errors from async handlers to the error handler (Express 4 doesn't) */
export const ah =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<void>): RequestHandler =>
  (req, res, next) => {
    fn(req, res, next).catch(next);
  };

export function bearerToken(req: Request): string | null {
  const match = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '');
  return match ? match[1] : null;
}

/** sets res.locals.user and res.locals.token, or answers 401 */
export function requireUser(store: Store): RequestHandler {
  return ah(async (req, res, next) => {
    const token = bearerToken(req);
    if (!token) throw new ApiError(401, 'Log in first');
    const user = await store.users.userForToken(token);
    if (!user) throw new ApiError(401, 'Session expired, log in again');
    res.locals.user = user;
    res.locals.token = token;
    next();
  });
}

export function requireAdmin(store: Store): RequestHandler[] {
  const adminOnly: RequestHandler = (_req, res, next) =>
    next(currentUser(res).role === 'admin' ? undefined : new ApiError(403, 'Admins only'));
  return [requireUser(store), adminOnly];
}

export const currentUser = (res: Response) => res.locals.user as WithId<UserDoc>;

/** fixed window per client IP; enough for a single small server */
export function rateLimit(max: number, windowMs: number): RequestHandler {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return (req, res, next) => {
    const now = Date.now();
    const key = req.ip ?? 'unknown';
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(key, entry);
    }
    if (hits.size > 10_000) for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
    if (++entry.count > max) {
      res.setHeader('Retry-After', String(Math.ceil((entry.resetAt - now) / 1000)));
      next(new ApiError(429, 'Too many attempts, try again in a few minutes'));
      return;
    }
    next();
  };
}
