import { Router } from 'express';
import type { Store } from '../../services/store.js';
import { toPublicUser } from '../../services/users.js';
import type { ProfileOverview } from '../../types.js';
import { asPayload, parseQueryInt } from '../../validate.js';
import { ApiError } from '../errors.js';
import { ah, currentUser, requireUser } from '../middleware.js';

export function meRoutes(store: Store, onAvatarChanged: (userId: string, avatar: string | null) => void): Router {
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

  // a face on a background ("fox.sunset"), or null for the first letter; locked ones need the level first
  r.post(
    '/avatar',
    ah(async (req, res) => {
      const avatar = asPayload(req.body).avatar;
      if (avatar !== null && (typeof avatar !== 'string' || avatar.length > 40)) throw new ApiError(400, 'Pick one of the avatars');
      const user = await store.users.setAvatar(currentUser(res)._id, avatar);
      onAvatarChanged(user.id, user.avatar);
      res.json({ user });
    }),
  );

  // the practice tutorial for a game was finished or skipped: it isn't offered again on any phone
  r.post(
    '/tutorial',
    ah(async (req, res) => {
      const game = asPayload(req.body).game;
      if (game !== 'bluff' && game !== 'crazy7') throw new ApiError(400, 'Unknown game');
      res.json({ user: await store.users.markTutorial(currentUser(res)._id, game) });
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
