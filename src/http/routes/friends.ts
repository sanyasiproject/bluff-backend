import { Router, type RequestHandler } from 'express';
import { ObjectId } from 'mongodb';
import type { Presence } from '../../presence.js';
import type { Store } from '../../services/store.js';
import type { FriendsResponse, FriendView, Phase } from '../../types.js';
import { asPayload, parseSearch, parseUserId, parseUsername } from '../../validate.js';
import { ah, currentUser, requireUser } from '../middleware.js';

/** tells a user's open apps that their friends or requests changed */
export type NotifyFriends = (userId: string) => void;

/** the room a user is in (its code and stage), or null */
export type RoomOfUser = (userId: string) => { code: string; phase: Phase } | null;

export function friendRoutes(store: Store, presence: Presence, notify: NotifyFriends, roomOf: RoomOfUser, limited: RequestHandler): Router {
  const r = Router();
  r.use(requireUser(store));

  /** live parts: online now, whether they're in my room, another room (and its stage), or free to invite */
  const live = (list: FriendView[], myRoom: string | null): FriendView[] =>
    list.map((f) => {
      const theirs = roomOf(f.id);
      const here = theirs?.code === myRoom;
      const online = presence.isOnline(f.id);
      return {
        ...f,
        online,
        lastSeen: online ? null : f.lastSeen,
        inRoom: !theirs ? null : here ? 'here' : 'other',
        roomPhase: theirs && !here ? theirs.phase : null,
      };
    });

  r.get(
    '/',
    ah(async (_req, res) => {
      const me = currentUser(res)._id;
      const lists = await store.friends.list(me);
      const myRoom = roomOf(me.toHexString())?.code ?? null;
      const body: FriendsResponse = {
        // online friends first, then by name
        friends: live(lists.friends, myRoom).sort((a, b) => Number(b.online) - Number(a.online)),
        incoming: live(lists.incoming, myRoom),
        outgoing: live(lists.outgoing, myRoom),
      };
      res.json(body);
    }),
  );

  r.get(
    '/search',
    limited,
    ah(async (req, res) => {
      const players = await store.friends.search(currentUser(res)._id, parseSearch(req.query.q));
      // online status and last online time only for people who are already friends
      res.json({
        players: players.map((p) => {
          const online = p.status === 'friend' ? presence.isOnline(p.id) : null;
          return { ...p, online, lastSeen: online === false ? p.lastSeen : null };
        }),
      });
    }),
  );

  r.post(
    '/request',
    limited,
    ah(async (req, res) => {
      const { result, otherId } = await store.friends.request(currentUser(res), parseUsername(asPayload(req.body).username));
      notify(otherId.toHexString());
      res.json({ result });
    }),
  );

  r.post(
    '/:id/accept',
    limited,
    ah(async (req, res) => {
      const otherId = parseUserId(req.params.id);
      await store.friends.accept(currentUser(res)._id, new ObjectId(otherId));
      notify(otherId);
      res.status(204).end();
    }),
  );

  r.post(
    '/:id/remove',
    limited,
    ah(async (req, res) => {
      const otherId = parseUserId(req.params.id);
      await store.friends.remove(currentUser(res)._id, new ObjectId(otherId));
      notify(otherId);
      res.status(204).end();
    }),
  );

  return r;
}
