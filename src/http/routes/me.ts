import { Router } from 'express';
import type { Store } from '../../services/store.js';
import { toPublicUser } from '../../services/users.js';
import type { ProfileOverview } from '../../types.js';
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
      const friendRequests = await store.friends.incomingCount(daily.user._id);
      res.json({ user: toPublicUser(daily.user), bonus: daily.bonus, friendRequests });
    }),
  );

  r.get(
    '/overview',
    ah(async (_req, res) => {
      const me = currentUser(res);
      const [overview, friends] = await Promise.all([store.users.overview(me), store.friends.countFor(me._id)]);
      const body: ProfileOverview = { ...overview, friends };
      res.json(body);
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
