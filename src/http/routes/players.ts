import { Router } from 'express';
import type { RequestHandler } from 'express';
import type { Presence } from '../../presence.js';
import type { Store } from '../../services/store.js';
import { parseUsername } from '../../validate.js';
import { ah, currentUser, requireUser, userRateLimit } from '../middleware.js';

/** public player cards, for logged-in players (lobby, friends, search) */
export function playerRoutes(store: Store, presence: Presence, limited: RequestHandler): Router {
  const r = Router();
  r.use(requireUser(store));

  r.get(
    '/:username',
    limited,
    ah(async (req, res) => {
      const profile = await store.friends.profileOf(currentUser(res)._id, parseUsername(req.params.username));
      // only friends (and you) see whether someone is online
      const online = profile.status === 'friend' || profile.status === 'me' ? presence.isOnline(profile.id) : null;
      res.json({ profile: { ...profile, online, lastSeen: profile.status === 'friend' && online === false ? profile.lastSeen : null } });
    }),
  );

  // my record against a friend, for their card; null when they aren't my friend or we never finished a game together
  // its own limit, so opening friends' cards one after another doesn't use up the profile limit twice as fast
  const rivalLimited = userRateLimit(60, 60_000);
  r.get(
    '/:username/rival',
    rivalLimited,
    ah(async (req, res) => {
      res.json({ record: await store.rivals.withFriend(currentUser(res)._id, parseUsername(req.params.username)) });
    }),
  );

  return r;
}
