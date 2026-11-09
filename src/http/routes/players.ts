import { Router } from 'express';
import type { Presence } from '../../presence.js';
import type { Store } from '../../services/store.js';
import { parseUsername } from '../../validate.js';
import { ah, currentUser, requireUser } from '../middleware.js';

/** public player cards, for logged-in players (lobby, friends, search) */
export function playerRoutes(store: Store, presence: Presence): Router {
  const r = Router();
  r.use(requireUser(store));

  r.get(
    '/:username',
    ah(async (req, res) => {
      const profile = await store.friends.profileOf(currentUser(res)._id, parseUsername(req.params.username));
      res.json({ profile: { ...profile, online: presence.isOnline(profile.id) } });
    }),
  );

  return r;
}
