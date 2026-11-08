import { Router } from 'express';
import type { Store } from '../../services/store.js';
import { asPayload, parseName, parsePassword, parseUsername } from '../../validate.js';
import { ApiError } from '../errors.js';
import { ah, requireUser, type rateLimit } from '../middleware.js';

export function authRoutes(store: Store, limited: ReturnType<typeof rateLimit>): Router {
  const r = Router();

  r.post(
    '/register',
    limited,
    ah(async (req, res) => {
      const b = asPayload(req.body);
      const username = parseUsername(b.username);
      const password = parsePassword(b.password);
      // display name is what others see at the table; same rules as a guest name
      const displayName = parseName(b.displayName === undefined || b.displayName === '' ? username.slice(0, 16) : b.displayName);
      res.status(201).json(await store.users.register(username, password, displayName));
    }),
  );

  r.post(
    '/login',
    limited,
    ah(async (req, res) => {
      const b = asPayload(req.body);
      if (typeof b.username !== 'string' || typeof b.password !== 'string' || b.password.length > 128) {
        throw new ApiError(400, 'Enter your username and password');
      }
      res.json(await store.users.login(b.username.trim().toLowerCase(), b.password));
    }),
  );

  r.post(
    '/logout',
    requireUser(store),
    ah(async (_req, res) => {
      await store.users.logout(res.locals.token as string);
      res.status(204).end();
    }),
  );

  return r;
}
