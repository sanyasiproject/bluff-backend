import { Router, type RequestHandler } from 'express';
import type { Store } from '../../services/store.js';
import { asPayload, parsePushEndpoint, parsePushSubscription } from '../../validate.js';
import { ApiError } from '../errors.js';
import { ah, currentUser, requireUser } from '../middleware.js';

/** friend-invite notifications: the app asks for the key, then saves or removes this phone */
export function pushRoutes(store: Store, limited: RequestHandler): Router {
  const r = Router();

  // publicKey null: not set up on this server; enabled false: an admin switched invites off
  r.get('/key', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ publicKey: store.push.publicKey, enabled: store.push.ready && store.settings.pushInvites });
  });

  r.post(
    '/subscribe',
    requireUser(store),
    limited,
    ah(async (req, res) => {
      if (!store.push.ready) throw new ApiError(503, 'Notifications are not set up on this server');
      if (!store.settings.pushInvites) throw new ApiError(503, 'Invite notifications are turned off right now');
      await store.push.subscribe(currentUser(res)._id, parsePushSubscription(asPayload(req.body)));
      res.status(204).end();
    }),
  );

  // always allowed, so a phone can stop getting them even while invites are off
  r.post(
    '/unsubscribe',
    requireUser(store),
    ah(async (req, res) => {
      await store.push.unsubscribe(currentUser(res)._id, parsePushEndpoint(asPayload(req.body).endpoint));
      res.status(204).end();
    }),
  );

  return r;
}
