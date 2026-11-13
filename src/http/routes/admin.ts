import { Router, type Request, type Response } from 'express';
import { ObjectId } from 'mongodb';
import { sameSecret } from '../../auth/tokens.js';
import type { Actor } from '../../db/documents.js';
import type { Store } from '../../services/store.js';
import type { SettingsChange } from '../../services/settings.js';
import type { UserChanges } from '../../services/users.js';
import type { AdminUserDetail, AppSettings } from '../../types.js';
import {
  asPayload,
  parseCoinAmount,
  parseFlag,
  parseName,
  parsePassword,
  parseQueryInt,
  parseReason,
  parseRole,
  parseSearch,
  parseUsername,
} from '../../validate.js';
import { ApiError } from '../errors.js';
import { ah, bearerToken, currentUser, requireAdmin, type rateLimit } from '../middleware.js';

const actorOf = (res: Response): Actor => ({ userId: currentUser(res)._id, via: 'admin' });

export function adminRoutes(
  store: Store,
  adminApiKey: string,
  limited: ReturnType<typeof rateLimit>,
  onSettingsChanged: (settings: AppSettings) => void,
): Router {
  const r = Router();
  const admin = requireAdmin(store);

  r.get(
    '/settings',
    ...admin,
    ah(async (_req, res) => {
      res.json({ settings: await store.settings.view() });
    }),
  );

  // guest play and invite notifications, on or off for the whole app; open apps update at once
  r.post(
    '/settings',
    ...admin,
    ah(async (req, res) => {
      const b = asPayload(req.body);
      const change: SettingsChange = {};
      if (b.guestsAllowed !== undefined) change.guestsAllowed = parseFlag(b.guestsAllowed, 'Guest play');
      if (b.pushInvites !== undefined) change.pushInvites = parseFlag(b.pushInvites, 'Invite notifications');
      if (Object.keys(change).length === 0) throw new ApiError(400, 'Nothing to change');
      const by = actorOf(res);
      const settings = await store.settings.update(change, by.userId);
      if (change.guestsAllowed !== undefined) await store.users.logSetting(by, change.guestsAllowed ? 'Guest play turned on' : 'Guest play turned off');
      if (change.pushInvites !== undefined) {
        await store.users.logSetting(by, change.pushInvites ? 'Invite notifications turned on' : 'Invite notifications turned off');
      }
      onSettingsChanged(settings);
      res.json({ settings });
    }),
  );

  r.get(
    '/users',
    ...admin,
    ah(async (req, res) => {
      const limit = parseQueryInt(req.query.limit, 50, 100) || 50;
      res.json(await store.users.list({ search: parseSearch(req.query.search), limit, skip: parseQueryInt(req.query.skip, 0, 1_000_000) }));
    }),
  );

  r.get(
    '/users/:id',
    ...admin,
    ah(async (req, res) => {
      const { user, history, historyTotal, activeSessions } = await store.users.adminView(String(req.params.id));
      const id = new ObjectId(user.id);
      const [games, friends] = await Promise.all([store.games.recentFor(id, 10), store.friends.countFor(id)]);
      const detail: AdminUserDetail = { user, games, history, historyTotal, friends, activeSessions };
      res.json(detail);
    }),
  );

  r.get(
    '/users/:id/history',
    ...admin,
    ah(async (req, res) => {
      const page = parseQueryInt(req.query.page, 1, 100_000) || 1;
      res.json(await store.users.history(String(req.params.id), page));
    }),
  );

  // only the fields sent are changed
  r.post(
    '/users/:id',
    ...admin,
    ah(async (req, res) => {
      const b = asPayload(req.body);
      const changes: UserChanges = {};
      if (b.displayName !== undefined) changes.displayName = parseName(b.displayName);
      if (b.role !== undefined) changes.role = parseRole(b.role);
      if (b.blocked !== undefined) changes.blocked = parseFlag(b.blocked, 'Blocked');
      if (Object.keys(changes).length === 0) throw new ApiError(400, 'Nothing to change');
      res.json({ user: await store.users.update(String(req.params.id), changes, actorOf(res)) });
    }),
  );

  r.post(
    '/users/:id/password',
    ...admin,
    ah(async (req, res) => {
      await store.users.setPassword(String(req.params.id), parsePassword(asPayload(req.body).password), actorOf(res));
      res.status(204).end();
    }),
  );

  r.post(
    '/users/:id/coins',
    ...admin,
    ah(async (req, res) => {
      const b = asPayload(req.body);
      const user = await store.users.adjustCoins(String(req.params.id), parseCoinAmount(b.amount), parseReason(b.reason), actorOf(res));
      res.json({ user });
    }),
  );

  // an admin can promote anyone; the very first admin is made with the X-Admin-Key header
  r.post(
    '/make-admin',
    limited,
    ah(async (req, res) => {
      const actor = await adminActor(req);
      const user = await store.users.makeAdmin(parseUsername(asPayload(req.body).username), actor);
      res.json({ user });
    }),
  );

  async function adminActor(req: Request): Promise<Actor> {
    const key = req.header('x-admin-key');
    if (key !== undefined) {
      if (!adminApiKey || !sameSecret(key, adminApiKey)) throw new ApiError(403, 'Wrong admin key');
      return { userId: null, via: 'api_key' };
    }
    const token = bearerToken(req);
    if (!token) throw new ApiError(401, 'Log in first');
    const user = await store.users.userForToken(token);
    if (!user) throw new ApiError(401, 'Session expired, log in again');
    if (user.role !== 'admin') throw new ApiError(403, 'Admins only');
    return { userId: user._id, via: 'admin' };
  }

  return r;
}
