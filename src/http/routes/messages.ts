import { Router } from 'express';
import type { Store } from '../../services/store.js';
import type { DirectMessage, DmReadEvent } from '../../types.js';
import { asPayload, parseBefore, parseDmText, parseUserId } from '../../validate.js';
import { ah, currentUser, requireUser, userRateLimit } from '../middleware.js';

/** a saved message goes live to both people's open apps */
export type DeliverDm = (msg: DirectMessage) => void;

/** someone read a thread: both people's open apps hear it */
export type DmRead = (event: DmReadEvent) => void;

/** messages a sender may send per minute */
export const DM_PER_MINUTE = 20;

/** private messages between friends, under /api/friends */
export function messageRoutes(store: Store, deliver: DeliverDm, onRead: DmRead): Router {
  const r = Router();
  r.use(requireUser(store));
  const sendLimit = userRateLimit(DM_PER_MINUTE, 60_000, "You're sending messages too fast. Wait a minute and try again");

  r.get(
    '/unread',
    ah(async (_req, res) => {
      res.json(await store.messages.unread(currentUser(res)._id.toHexString()));
    }),
  );

  r.get(
    '/:id/messages',
    ah(async (req, res) => {
      const me = currentUser(res)._id.toHexString();
      res.json(await store.messages.history(me, parseUserId(req.params.id), parseBefore(req.query.before)));
    }),
  );

  r.post(
    '/:id/messages',
    sendLimit,
    ah(async (req, res) => {
      const me = currentUser(res)._id.toHexString();
      const msg = await store.messages.send(me, parseUserId(req.params.id), parseDmText(asPayload(req.body).text));
      deliver(msg);
      res.status(201).json({ message: msg });
    }),
  );

  r.post(
    '/:id/messages/read',
    ah(async (req, res) => {
      const me = currentUser(res)._id.toHexString();
      const other = parseUserId(req.params.id);
      if ((await store.messages.markRead(me, other)) > 0) onRead({ reader: me, other });
      res.status(204).end();
    }),
  );

  return r;
}
