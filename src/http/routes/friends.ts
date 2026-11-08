import { Router } from 'express';
import { ObjectId } from 'mongodb';
import type { Presence } from '../../presence.js';
import type { Store } from '../../services/store.js';
import type { FriendsResponse, FriendView } from '../../types.js';
import { asPayload, parseUserId, parseUsername } from '../../validate.js';
import { ah, currentUser, requireUser } from '../middleware.js';

export function friendRoutes(store: Store, presence: Presence): Router {
  const r = Router();
  r.use(requireUser(store));

  const withOnline = (list: FriendView[]) => list.map((f) => ({ ...f, online: presence.isOnline(f.id) }));

  r.get(
    '/',
    ah(async (_req, res) => {
      const lists = await store.friends.list(currentUser(res)._id);
      const body: FriendsResponse = {
        // online friends first, then by name
        friends: withOnline(lists.friends).sort((a, b) => Number(b.online) - Number(a.online)),
        incoming: withOnline(lists.incoming),
        outgoing: withOnline(lists.outgoing),
      };
      res.json(body);
    }),
  );

  r.post(
    '/request',
    ah(async (req, res) => {
      const result = await store.friends.request(currentUser(res), parseUsername(asPayload(req.body).username));
      res.json({ result });
    }),
  );

  r.post(
    '/:id/accept',
    ah(async (req, res) => {
      await store.friends.accept(currentUser(res)._id, new ObjectId(parseUserId(req.params.id)));
      res.status(204).end();
    }),
  );

  r.post(
    '/:id/remove',
    ah(async (req, res) => {
      await store.friends.remove(currentUser(res)._id, new ObjectId(parseUserId(req.params.id)));
      res.status(204).end();
    }),
  );

  return r;
}
