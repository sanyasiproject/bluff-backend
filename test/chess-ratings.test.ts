import type { AddressInfo } from 'node:net';
import { MongoClient, ObjectId } from 'mongodb';
import { io as connect, type Socket } from 'socket.io-client';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChessRatingDoc } from '../src/db/documents.js';
import { createBluffServer } from '../src/server.js';
import type { ChessFinish } from '../src/services/chess.js';
import { createStore, type Store } from '../src/services/store.js';
import { CHESS_GAMES_KEEP, chessNewRating, type ChessGameRecord, type ChessLeaderboard, type ChessRatingsResponse, type ChessView, type PublicUser, type RoomView } from '../src/types.js';

// run with TEST_MONGODB_URI=mongodb://127.0.0.1:27099 (a throwaway database is created and dropped)
const MONGO = process.env.TEST_MONGODB_URI;
const DB = `bluff_chess_test_${Date.now()}`;

describe.skipIf(!MONGO)('Chess ratings, leaderboard and saved games (MongoDB)', () => {
  let store: Store;
  let server: ReturnType<typeof createBluffServer>;
  let raw: MongoClient;
  let url = '';
  const sockets: Socket[] = [];

  beforeAll(async () => {
    store = await createStore(
      MONGO!,
      { db: DB, users: 'users', sessions: 'sessions', games: 'games', audit: 'audit_log', friends: 'friends', settings: 'settings' },
      { defaultCoins: 1000, sessionTtlDays: 30 },
    );
    server = createBluffServer({ store, authAttempts: 1000, limits: { createsPerIp: 10_000, liveRoomsPerIp: 10_000 }, botSpeed: 0.05 });
    await new Promise<void>((resolve) => server.httpServer.listen(0, resolve));
    url = `http://localhost:${(server.httpServer.address() as AddressInfo).port}`;
    raw = new MongoClient(MONGO!);
    await raw.connect();
  });

  afterAll(async () => {
    sockets.forEach((s) => s.disconnect());
    server.close();
    await raw.db(DB).dropDatabase();
    await raw.close();
    await store.close();
  });

  let made = 0;
  async function account() {
    const res = await request(server.app).post('/api/auth/register').send({ username: `chess_${++made}`, password: 'secret-pass-1' });
    expect(res.status).toBe(201);
    return { id: (res.body.user as PublicUser).id, token: res.body.token as string };
  }

  const finish = (over: Partial<ChessFinish> = {}): ChessFinish => ({
    roomCode: 'CHESS',
    variant: 'standard',
    time: '5+0',
    speed: 'blitz',
    perf: 'blitz',
    rated: true,
    players: { w: { userId: null, name: 'W', bot: null }, b: { userId: null, name: 'B', bot: null } },
    result: { winner: 'w', reason: 'resign' },
    initialFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    moves: ['e2e4', 'e7e5'],
    pgn: '1. e4 e5 1-0',
    opening: null,
    startedAt: new Date(Date.now() - 60_000),
    endedAt: new Date(),
    ...over,
  });

  it('a rated socket game moves both ratings from 800 and shows the change at the end', async () => {
    const a = await account();
    const b = await account();
    const client = async (token: string) => {
      const s = connect(url, { transports: ['websocket'], forceNew: true, auth: { token, rang: true, games: ['chess'] } });
      sockets.push(s);
      const c = { s, state: null as RoomView | null };
      s.on('state', (v: RoomView) => (c.state = v));
      await new Promise<void>((r) => s.once('connect', () => r()));
      return c;
    };
    const ca = await client(a.token);
    const cb = await client(b.token);
    const created = (await ca.s.timeout(3000).emitWithAck('room:create', { name: 'A' })) as { code: string };
    expect(await cb.s.timeout(3000).emitWithAck('room:join', { code: created.code, name: 'B' })).toMatchObject({ ok: true });
    expect(await ca.s.timeout(3000).emitWithAck('room:config', { game: 'chess', decks: 1, bluffRule: 'one', stake: 0, opts: { rated: 'yes', time: '3+2', color: 'white' } })).toEqual({ ok: true });
    expect(await ca.s.timeout(3000).emitWithAck('room:start', {})).toEqual({ ok: true });
    const view = (c: { state: RoomView | null }) => (c.state?.plugged as { chess?: ChessView } | undefined)?.chess;
    const until = async (f: () => boolean) => {
      for (let i = 0; i < 1000 && !f(); i++) await new Promise((r) => setTimeout(r, 10));
      expect(f()).toBe(true);
    };
    await until(() => !!view(ca)?.ratings?.w && !!view(cb)?.ratings?.b);
    expect(view(ca)).toMatchObject({ rated: true, perf: 'blitz', ratings: { w: { r: 800, rd: 500, prov: true }, b: { r: 800, prov: true } } });
    for (const [i, uci] of ['f2f3', 'e7e5', 'g2g4', 'd8h4'].entries()) {
      const c = i % 2 === 0 ? ca : cb;
      expect(await c.s.timeout(3000).emitWithAck('game:move', { kind: 'chess', move: { type: 'move', uci, ply: i } })).toEqual({ ok: true });
    }
    await until(() => !!view(ca)?.ratingDiff && !!view(ca)?.gameId);
    const end = view(ca)!;
    expect(end.ratingDiff!.b).toBeGreaterThan(100);
    expect(end.ratingDiff!.w).toBe(-end.ratingDiff!.b);
    expect(end.ratings!.b!.r).toBe(800 + end.ratingDiff!.b);

    const mine = await request(server.app).get('/api/chess/ratings/me').set('Authorization', `Bearer ${b.token}`);
    expect(mine.status).toBe(200);
    const perfs = (mine.body as ChessRatingsResponse).perfs;
    expect(perfs.blitz).toMatchObject({ games: 1, w: 1, l: 0, d: 0, streak: 1, bestStreak: 1, peak: 800 + end.ratingDiff!.b });
    expect(perfs.blitz!.history).toHaveLength(1);
    const theirs = await request(server.app).get(`/api/chess/ratings/${a.id}`).set('Authorization', `Bearer ${b.token}`);
    expect((theirs.body as ChessRatingsResponse).perfs.blitz).toMatchObject({ games: 1, l: 1, streak: 0 });

    const list = await request(server.app).get('/api/chess/games').set('Authorization', `Bearer ${a.token}`);
    expect(list.body.games).toHaveLength(1);
    expect(list.body.games[0]).toMatchObject({ id: end.gameId, rated: true, result: { winner: 'b', reason: 'checkmate' }, plies: 4, perf: 'blitz' });
    expect(list.body.games[0].players.w).toMatchObject({ userId: a.id, before: 800, after: 800 + end.ratingDiff!.w });
    const one = await request(server.app).get(`/api/chess/games/${end.gameId}`).set('Authorization', `Bearer ${a.token}`);
    const rec = one.body.game as ChessGameRecord;
    expect(rec.moves).toEqual(['f2f3', 'e7e5', 'g2g4', 'd8h4']);
    expect(rec.pgn).toContain('Qh4# 0-1');
    expect((await request(server.app).get('/api/chess/games/zzz').set('Authorization', `Bearer ${a.token}`)).status).toBe(404);
  }, 30_000);

  it('casual, guest and bot games never move ratings; aborts are not kept', async () => {
    const a = await account();
    const b = await account();
    const casual = await store.chess.settle(finish({ rated: false, players: { w: { userId: a.id, name: 'A', bot: null }, b: { userId: b.id, name: 'B', bot: null } } }));
    expect(casual.diff).toBeNull();
    expect(casual.gameId).not.toBeNull();
    const guest = await store.chess.settle(finish({ players: { w: { userId: a.id, name: 'A', bot: null }, b: { userId: null, name: 'G', bot: null } } }));
    expect(guest.diff).toBeNull();
    const bot = await store.chess.settle(finish({ players: { w: { userId: a.id, name: 'A', bot: null }, b: { userId: null, name: 'Bot', bot: 3 } } }));
    expect(bot.diff).toBeNull();
    const aborted = await store.chess.settle(finish({ result: { winner: null, reason: 'abort' }, players: { w: { userId: a.id, name: 'A', bot: null }, b: { userId: b.id, name: 'B', bot: null } } }));
    expect(aborted.gameId).toBeNull();
    expect((await store.chess.ratingsOf(a.id)).perfs).toEqual({});
    expect(await store.chess.recentGames(new ObjectId(a.id))).toHaveLength(3);
    // a rated draw between equals moves nothing but counts the game
    const draw = await store.chess.settle(finish({ result: { winner: null, reason: 'agreement' }, players: { w: { userId: a.id, name: 'A', bot: null }, b: { userId: b.id, name: 'B', bot: null } } }));
    expect(draw.diff).toEqual({ w: 0, b: 0 });
    expect((await store.chess.ratingsOf(a.id)).perfs.blitz).toMatchObject({ games: 1, d: 1 });
  });

  it('keeps each account its newest games only', async () => {
    const a = await account();
    for (let i = 0; i <= CHESS_GAMES_KEEP; i++) {
      await store.chess.settle(finish({ rated: false, endedAt: new Date(Date.now() + i), players: { w: { userId: a.id, name: 'A', bot: null }, b: { userId: null, name: 'Bot', bot: 1 } } }));
    }
    const games = await raw.db(DB).collection('chess_games').countDocuments({ userIds: new ObjectId(a.id) });
    expect(games).toBe(CHESS_GAMES_KEEP);
  }, 60_000);

  it('the leaderboard lists the top non-provisional ratings and where I stand', async () => {
    const col = raw.db(DB).collection<ChessRatingDoc>('chess_ratings');
    const people = await Promise.all([1, 2, 3, 4].map(() => account()));
    const set = (i: number, r: number, rd: number) =>
      col.updateOne({ _id: new ObjectId(people[i].id) }, { $set: { 'perfs.bullet': { ...chessNewRating(Date.now()), r, rd, games: 30 } }, $setOnInsert: { applied: [], rev: 1 } }, { upsert: true });
    await set(0, 1500, 60);
    await set(1, 1700, 80);
    await set(2, 2000, 200);
    await set(3, 1200, 50);
    const res = await request(server.app).get('/api/chess/leaderboard/bullet').set('Authorization', `Bearer ${people[0].token}`);
    const board = res.body as ChessLeaderboard;
    expect(board.top.map((r) => r.r)).toEqual([1700, 1500, 1200]);
    expect(board.top[0]).toMatchObject({ rank: 1, username: 'chess_' + (made - 2) });
    expect(board.me).toMatchObject({ rank: 2, rating: { r: 1500 } });
    const prov = await request(server.app).get('/api/chess/leaderboard/bullet').set('Authorization', `Bearer ${people[2].token}`);
    expect((prov.body as ChessLeaderboard).me).toMatchObject({ rank: null, rating: { r: 2000 } });
    expect((await request(server.app).get('/api/chess/leaderboard/nope').set('Authorization', `Bearer ${people[0].token}`)).status).toBe(400);
  });
});
