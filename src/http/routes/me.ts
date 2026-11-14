import { Router } from 'express';
import type { PlayerLook } from '../../models.js';
import type { Store } from '../../services/store.js';
import { toPublicUser } from '../../services/users.js';
import { DEFAULT_CARD_BACK, DEFAULT_TABLE_THEME, type ProfileOverview, type PublicUser } from '../../types.js';
import { asPayload, parseQueryInt } from '../../validate.js';
import { ApiError } from '../errors.js';
import { ah, currentUser, requireUser } from '../middleware.js';

export function meRoutes(store: Store, onLookChanged: (userId: string, look: PlayerLook) => void): Router {
  const r = Router();
  // rooms the player is in show the new look at once
  const lookChanged = (user: PublicUser) =>
    onLookChanged(user.id, { avatar: user.avatar, back: user.cardBack ?? DEFAULT_CARD_BACK, table: user.tableTheme ?? DEFAULT_TABLE_THEME });
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
      lookChanged(user);
      res.json({ user });
    }),
  );

  // the card back everyone sees on this player's cards, or null for the classic one; locked ones need the level first
  r.post(
    '/back',
    ah(async (req, res) => {
      const back = asPayload(req.body).back;
      if (back !== null && (typeof back !== 'string' || back.length > 20)) throw new ApiError(400, 'Pick one of the card backs');
      const user = await store.users.setCardBack(currentUser(res)._id, back);
      lookChanged(user);
      res.json({ user });
    }),
  );

  // the table theme: their felt, and the seat box everyone sees round their name; null for classic green
  r.post(
    '/table',
    ah(async (req, res) => {
      const table = asPayload(req.body).table;
      if (table !== null && (typeof table !== 'string' || table.length > 20)) throw new ApiError(400, 'Pick one of the tables');
      const user = await store.users.setTableTheme(currentUser(res)._id, table);
      lookChanged(user);
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
