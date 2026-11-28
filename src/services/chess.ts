import { MongoServerError, ObjectId, type ClientSession, type MongoClient } from 'mongodb';
import type { ChessGameDoc, ChessRatingDoc, Collections } from '../db/documents.js';
import { agedRd, rateGame } from '../games/chess/glicko.js';
import { ApiError } from '../http/errors.js';
import {
  CHESS_GAMES_KEEP,
  CHESS_HISTORY_KEEP,
  CHESS_PROVISIONAL_RD,
  chessNewRating,
  chessProvisional,
  type ChessColor,
  type ChessEndReason,
  type ChessGamePlayer,
  type ChessGameRecord,
  type ChessGameSummary,
  type ChessLeaderboard,
  type ChessPerf,
  type ChessRating,
  type ChessRatingBadge,
  type ChessRatingsResponse,
  type ChessSpeed,
  type ChessVariant,
} from '../types.js';

/** a finished chess game as the room hands it over */
export interface ChessFinish {
  roomCode: string;
  variant: ChessVariant;
  time: string;
  speed: ChessSpeed;
  perf: ChessPerf;
  /** the table's rated flag (host's choice, two accounts, timed) */
  rated: boolean;
  players: Record<ChessColor, { userId: string | null; name: string; bot: number | null }>;
  result: { winner: ChessColor | null; reason: ChessEndReason };
  initialFen: string;
  moves: string[];
  pgn: string;
  opening: { eco: string; name: string } | null;
  startedAt: Date;
  endedAt: Date;
}

/** what the table shows once the game is stored */
export interface ChessSettlement {
  gameId: string | null;
  /** rated games: the change by colour */
  diff: { w: number; b: number } | null;
  /** ratings after the game */
  ratings: Partial<Record<ChessColor, ChessRatingBadge>>;
}

const LEADERS = 50;
/** rated game ids remembered per account, so a game never counts twice */
const APPLIED_KEEP = 50;
const badge = (r: ChessRating): ChessRatingBadge => ({ r: Math.round(r.r), rd: Math.round(r.rd), prov: chessProvisional(r.rd) });
const oid = (id: string): ObjectId | null => (ObjectId.isValid(id) && /^[0-9a-f]{24}$/i.test(id) ? new ObjectId(id) : null);

/** chess ratings (chess_ratings, one document per account) and finished games (chess_games) */
export class ChessService {
  constructor(
    private readonly cols: Collections,
    private readonly client: MongoClient | null = null,
  ) {}

  /** every perf this account has a rating in */
  async ratingsOf(userId: string): Promise<ChessRatingsResponse> {
    const id = oid(userId);
    if (!id) throw new ApiError(404, 'Player not found');
    const doc = await this.cols.chessRatings.findOne({ _id: id });
    return { userId, perfs: doc?.perfs ?? {} };
  }

  /** seat badges for one perf (accounts with no games yet show the start rating) */
  async badges(userIds: string[], perf: ChessPerf): Promise<Map<string, ChessRatingBadge>> {
    const ids = userIds.map(oid).filter((x): x is ObjectId => !!x);
    const docs = await this.cols.chessRatings.find({ _id: { $in: ids } }, { projection: { [`perfs.${perf}`]: 1 } }).toArray();
    const out = new Map<string, ChessRatingBadge>();
    const now = Date.now();
    for (const u of userIds) {
      const r = docs.find((d) => d._id.toHexString() === u)?.perfs[perf] ?? chessNewRating();
      out.set(u, badge({ ...r, rd: agedRd(r, now) }));
    }
    return out;
  }

  /** top 50 non-provisional in a perf, plus my place */
  async leaderboard(perf: ChessPerf, me: ObjectId | null): Promise<ChessLeaderboard> {
    const key = `perfs.${perf}`;
    const docs = await this.cols.chessRatings
      .find({ [`${key}.rd`]: { $lte: CHESS_PROVISIONAL_RD } }, { projection: { [key]: 1 } })
      .sort({ [`${key}.r`]: -1 })
      .limit(LEADERS)
      .toArray();
    const users = await this.cols.users
      .find({ _id: { $in: docs.map((d) => d._id) } }, { projection: { username: 1, displayName: 1, avatar: 1 } })
      .toArray();
    const top = docs.flatMap((d, i) => {
      const u = users.find((x) => x._id.equals(d._id));
      const r = d.perfs[perf]!;
      return u ? [{ rank: i + 1, userId: d._id.toHexString(), username: u.username, displayName: u.displayName, avatar: u.avatar ?? null, r: Math.round(r.r), rd: Math.round(r.rd), games: r.games }] : [];
    });
    if (!me) return { perf, top, me: null };
    const mine = (await this.cols.chessRatings.findOne({ _id: me }, { projection: { [key]: 1 } }))?.perfs[perf] ?? null;
    let rank: number | null = null;
    if (mine && !chessProvisional(mine.rd)) {
      rank = 1 + (await this.cols.chessRatings.countDocuments({ [`${key}.rd`]: { $lte: CHESS_PROVISIONAL_RD }, [`${key}.r`]: { $gt: mine.r } }));
    }
    return { perf, top, me: { rank, rating: mine } };
  }

  /** an account's newest games, newest first */
  async recentGames(userId: ObjectId, limit = 30, before?: number): Promise<ChessGameSummary[]> {
    const filter: Record<string, unknown> = { userIds: userId };
    if (before) filter.endedAt = { $lt: new Date(before) };
    const docs = await this.cols.chessGames
      .find(filter, { projection: { moves: 0, pgn: 0, initialFen: 0 } })
      .sort({ endedAt: -1 })
      .limit(Math.min(Math.max(limit, 1), CHESS_GAMES_KEEP))
      .toArray();
    return docs.map((d) => summaryOf(d));
  }

  /** one saved game in full */
  async game(id: string): Promise<ChessGameRecord> {
    const _id = oid(id);
    const d = _id ? await this.cols.chessGames.findOne({ _id }) : null;
    if (!d) throw new ApiError(404, 'Game not found');
    return { ...summaryOf(d), initialFen: d.initialFen, moves: d.moves, pgn: d.pgn };
  }

  /**
   * stores a finished game and, when rated, moves both ratings. Aborted games (before both sides moved) count for nothing.
   * Both rating writes go in one transaction where the database has them (replica sets, Atlas); a standalone server
   * falls back to two writes guarded on each document's rev and the game id (a game never counts twice).
   */
  async settle(f: ChessFinish): Promise<ChessSettlement> {
    if (f.result.reason === 'abort') return { gameId: null, diff: null, ratings: {} };
    const ids = { w: f.players.w.userId ? oid(f.players.w.userId) : null, b: f.players.b.userId ? oid(f.players.b.userId) : null };
    const rated = f.rated && !!ids.w && !!ids.b && !ids.w.equals(ids.b) && f.moves.length >= 2;
    const _id = new ObjectId();
    const gameId = _id.toHexString();
    const now = f.endedAt.getTime();
    const docs = await this.cols.chessRatings.find({ _id: { $in: [ids.w, ids.b].filter((x): x is ObjectId => !!x) } }).toArray();
    const docOf = (c: ChessColor) => (ids[c] ? (docs.find((d) => d._id.equals(ids[c]!)) ?? null) : null);
    const before = { w: this.current(docOf('w'), f.perf, now), b: this.current(docOf('b'), f.perf, now) };
    const player = (c: ChessColor, after: ChessRating | null): ChessGamePlayer => ({
      ...f.players[c],
      before: ids[c] ? Math.round(before[c].r) : null,
      after: after ? Math.round(after.r) : null,
      prov: chessProvisional(before[c].rd),
    });
    let after: Record<ChessColor, ChessRating> | null = null;
    if (rated) {
      const score = f.result.winner === 'w' ? 1 : f.result.winner === 'b' ? 0 : 0.5;
      const next = rateGame(before.w, before.b, score);
      after = { w: this.next(before.w, next.w, score, now), b: this.next(before.b, next.b, 1 - score, now) };
    }
    const game: ChessGameDoc = {
      _id,
      userIds: [ids.w, ids.b].filter((x): x is ObjectId => !!x),
      variant: f.variant,
      time: f.time,
      speed: f.speed,
      perf: f.perf,
      rated,
      players: { w: player('w', after?.w ?? null), b: player('b', after?.b ?? null) },
      result: f.result,
      plies: f.moves.length,
      opening: f.opening,
      initialFen: f.initialFen,
      moves: f.moves,
      pgn: f.pgn,
      roomCode: f.roomCode,
      startedAt: f.startedAt,
      endedAt: f.endedAt,
    };
    // guests only: nothing to keep
    if (game.userIds.length === 0) return { gameId: null, diff: null, ratings: {} };
    if (after) await this.writeRatings(game, { w: docOf('w'), b: docOf('b') }, after);
    else await this.cols.chessGames.insertOne(game);
    await Promise.all(game.userIds.map((u) => this.trim(u)));
    const ratings: Partial<Record<ChessColor, ChessRatingBadge>> = {};
    for (const c of ['w', 'b'] as const) if (ids[c]) ratings[c] = badge(after?.[c] ?? before[c]);
    return {
      gameId,
      diff: after ? { w: Math.round(after.w.r) - Math.round(before.w.r), b: Math.round(after.b.r) - Math.round(before.b.r) } : null,
      ratings,
    };
  }

  /** a perf's rating now, with RD grown since the last game */
  private current(doc: ChessRatingDoc | null, perf: ChessPerf, now: number): ChessRating {
    const r = doc?.perfs[perf] ?? chessNewRating(now);
    return { ...r, rd: agedRd(r, now) };
  }

  private next(prev: ChessRating, g: { r: number; rd: number; vol: number }, score: number, now: number): ChessRating {
    const won = score === 1;
    const streak = won ? prev.streak + 1 : 0;
    return {
      r: g.r,
      rd: g.rd,
      vol: g.vol,
      games: prev.games + 1,
      w: prev.w + (won ? 1 : 0),
      l: prev.l + (score === 0 ? 1 : 0),
      d: prev.d + (score === 0.5 ? 1 : 0),
      peak: Math.max(prev.peak, Math.round(g.r)),
      streak,
      bestStreak: Math.max(prev.bestStreak, streak),
      history: [...prev.history, [now, Math.round(g.r)] as [number, number]].slice(-CHESS_HISTORY_KEEP),
      updatedAt: now,
    };
  }

  /** the game and both new ratings: one transaction where possible, else guarded writes */
  private async writeRatings(game: ChessGameDoc, docs: Record<ChessColor, ChessRatingDoc | null>, after: Record<ChessColor, ChessRating>): Promise<void> {
    const gameId = game._id.toHexString();
    const write = async (session?: ClientSession) => {
      await this.cols.chessGames.insertOne(game, { session });
      for (const c of ['w', 'b'] as const) {
        const id = game.players[c].userId!;
        const doc = docs[c];
        const res = await this.cols.chessRatings.updateOne(
          doc ? { _id: doc._id, rev: doc.rev, applied: { $ne: gameId } } : { _id: new ObjectId(id), applied: { $ne: gameId } },
          { $set: { [`perfs.${game.perf}`]: after[c] }, $inc: { rev: 1 }, $push: { applied: { $each: [gameId], $slice: -APPLIED_KEEP } } },
          { session, upsert: !doc },
        );
        if (res.matchedCount === 0 && res.upsertedCount === 0) throw new Error('chess rating changed meanwhile');
      }
    };
    if (this.client) {
      const session = this.client.startSession();
      try {
        await session.withTransaction(() => write(session));
        return;
      } catch (err) {
        // standalone servers have no transactions: fall back to guarded writes
        if (!(err instanceof MongoServerError) || !/Transaction numbers|replica set/i.test(err.message)) throw err;
      } finally {
        await session.endSession();
      }
    }
    await write();
  }

  /** each account keeps its newest CHESS_GAMES_KEEP games; a game nobody keeps is deleted */
  private async trim(userId: ObjectId): Promise<void> {
    const old = await this.cols.chessGames.find({ userIds: userId }, { projection: { _id: 1 } }).sort({ endedAt: -1 }).skip(CHESS_GAMES_KEEP).toArray();
    if (old.length === 0) return;
    const ids = old.map((d) => d._id);
    await this.cols.chessGames.updateMany({ _id: { $in: ids } }, { $pull: { userIds: userId } });
    await this.cols.chessGames.deleteMany({ _id: { $in: ids }, userIds: { $size: 0 } });
  }
}

function summaryOf(d: ChessGameDoc): ChessGameSummary {
  return {
    id: d._id.toHexString(),
    variant: d.variant,
    time: d.time,
    speed: d.speed,
    perf: d.perf,
    rated: d.rated,
    players: d.players,
    result: d.result,
    plies: d.plies,
    opening: d.opening,
    endedAt: d.endedAt.getTime(),
  };
}
