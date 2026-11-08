import { Router } from 'express';
import type { Store } from '../../services/store.js';
import { toPublicUser } from '../../services/users.js';
import { parseQueryInt } from '../../validate.js';
import { ah, currentUser, requireUser } from '../middleware.js';

export function meRoutes(store: Store): Router {
  const r = Router();
  r.use(requireUser(store));

  // opening the app counts as the day's login, so the daily bonus is paid here too
  r.get(
    '/',
    ah(async (_req, res) => {
      const daily = await store.users.claimLoginBonus(currentUser(res));
      res.json({ user: toPublicUser(daily.user), bonus: daily.bonus });
    }),
  );

  r.get(
    '/games',
    ah(async (req, res) => {
      const limit = parseQueryInt(req.query.limit, 20, 50) || 20;
      res.json({ games: await store.games.recentFor(currentUser(res)._id, limit) });
    }),
  );

  return r;
}
