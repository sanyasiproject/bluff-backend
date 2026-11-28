import { Router } from 'express';
import { ObjectId } from 'mongodb';
import type { Store } from '../../services/store.js';
import { isChessPerf } from '../../types.js';
import { ApiError } from '../errors.js';
import { ah, currentUser, requireUser, userRateLimit } from '../middleware.js';

const userIdOf = (raw: string, me: ObjectId): ObjectId => {
  if (raw === 'me') return me;
  if (!/^[0-9a-f]{24}$/i.test(raw)) throw new ApiError(404, 'Player not found');
  return new ObjectId(raw);
};

/** chess ratings, leaderboards and saved games, for logged-in players */
export function chessRoutes(store: Store): Router {
  const r = Router();
  r.use(requireUser(store));
  // profile pages open several of these at once
  r.use(userRateLimit(60, 60_000));

  // every perf's rating: mine (me) or a player's (their account id, from the seat or player sheet)
  r.get(
    '/ratings/:userId',
    ah(async (req, res) => {
      const id = userIdOf(String(req.params.userId), currentUser(res)._id);
      res.json(await store.chess.ratingsOf(id.toHexString()));
    }),
  );

  // top 50 non-provisional in a perf, plus my place
  r.get(
    '/leaderboard/:perf',
    ah(async (req, res) => {
      const perf = req.params.perf;
      if (!isChessPerf(perf)) throw new ApiError(400, 'Unknown rating type');
      res.json(await store.chess.leaderboard(perf, currentUser(res)._id));
    }),
  );

  // recent games, newest first: ?user=me|<id>&limit=30&before=<endedAt ms> for the next page
  r.get(
    '/games',
    ah(async (req, res) => {
      const id = userIdOf(typeof req.query.user === 'string' ? req.query.user : 'me', currentUser(res)._id);
      const limit = Number(req.query.limit) || 30;
      const before = Number(req.query.before) || undefined;
      res.json({ games: await store.chess.recentGames(id, limit, before) });
    }),
  );

  // one game in full (moves, PGN) for replay and analysis
  r.get(
    '/games/:id',
    ah(async (req, res) => {
      res.json({ game: await store.chess.game(String(req.params.id)) });
    }),
  );

  return r;
}
