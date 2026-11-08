import { Router } from 'express';
import type { Store } from '../../services/store.js';
import { toPublicUser } from '../../services/users.js';
import { parseQueryInt } from '../../validate.js';
import { ah, currentUser, requireUser } from '../middleware.js';

export function meRoutes(store: Store): Router {
  const r = Router();
  r.use(requireUser(store));

  r.get('/', (_req, res) => {
    res.json({ user: toPublicUser(currentUser(res)) });
  });

  r.get(
    '/games',
    ah(async (req, res) => {
      const limit = parseQueryInt(req.query.limit, 20, 50) || 20;
      res.json({ games: await store.games.recentFor(currentUser(res)._id, limit) });
    }),
  );

  return r;
}
