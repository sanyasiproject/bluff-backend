import { Router, type Request } from 'express';
import { sameSecret } from '../../auth/tokens.js';
import type { Actor } from '../../db/documents.js';
import type { Store } from '../../services/store.js';
import { asPayload, parseCoinAmount, parseQueryInt, parseReason, parseSearch, parseUsername } from '../../validate.js';
import { ApiError } from '../errors.js';
import { ah, bearerToken, currentUser, requireAdmin, type rateLimit } from '../middleware.js';

export function adminRoutes(store: Store, adminApiKey: string, limited: ReturnType<typeof rateLimit>): Router {
  const r = Router();
  const admin = requireAdmin(store);

  r.get(
    '/users',
    ...admin,
    ah(async (req, res) => {
      const limit = parseQueryInt(req.query.limit, 50, 100) || 50;
      res.json(await store.users.list({ search: parseSearch(req.query.search), limit, skip: parseQueryInt(req.query.skip, 0, 1_000_000) }));
    }),
  );

  r.post(
    '/users/:id/coins',
    ...admin,
    ah(async (req, res) => {
      const b = asPayload(req.body);
      const user = await store.users.adjustCoins(String(req.params.id), parseCoinAmount(b.amount), parseReason(b.reason), {
        userId: currentUser(res)._id,
        via: 'admin',
      });
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
