import { MongoClient, ObjectId, type Collection } from 'mongodb';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { istDay, istWeek } from '../src/days.js';
import type { UserDoc } from '../src/db/documents.js';
import type { GameRecord, GameRecordPlayer } from '../src/models.js';
import { createBluffServer } from '../src/server.js';
import { createStore, type Store } from '../src/services/store.js';
import type { GameKind, PublicUser } from '../src/types.js';
import { parseConfig } from '../src/validate.js';

// run with TEST_MONGODB_URI=mongodb://127.0.0.1:27099 (a throwaway database is created and dropped)
const MONGO = process.env.TEST_MONGODB_URI;
const DB = `bluff_ludo_stats_test_${Date.now()}`;

describe.skipIf(!MONGO)('Ludo stats and missions (MongoDB)', () => {
  let store: Store;
  let server: ReturnType<typeof createBluffServer>;
  let raw: MongoClient;
  let users: Collection<UserDoc>;

  beforeAll(async () => {
    store = await createStore(
      MONGO!,
      { db: DB, users: 'users', sessions: 'sessions', games: 'games', audit: 'audit_log', friends: 'friends', settings: 'settings' },
      { defaultCoins: 1000, sessionTtlDays: 30 },
    );
    server = createBluffServer({ store, authAttempts: 1000 });
    raw = new MongoClient(MONGO!);
    await raw.connect();
    users = raw.db(DB).collection<UserDoc>('users');
  });

  afterAll(async () => {
    server.close();
    await raw.db(DB).dropDatabase();
    await raw.close();
    await store.close();
  });

  let made = 0;
  async function account() {
    const res = await request(server.app).post('/api/auth/register').send({ username: `ludo_${++made}`, password: 'secret-pass-1' });
    expect(res.status).toBe(201);
    const user = res.body.user as PublicUser;
    return { id: user.id, oid: new ObjectId(user.id) };
  }

  const zero = { bluffs: 0, caught: 0, goodCalls: 0, wrongCalls: 0, pickedUp: 0, plays: 0, chances: 0 };
  async function save(game: GameKind, seats: (Partial<GameRecordPlayer> & { memberId: string })[]) {
    const record: GameRecord = {
      roomCode: 'LUDO',
      config: parseConfig({ decks: 1, bluffRule: 'one', game }),
      status: 'finished',
      startedAt: new Date(Date.now() - 120_000),
      endedAt: new Date(),
      players: seats.map((s) => ({ userId: null, name: s.memberId, place: null, loser: false, kicked: false, won: false, bot: false, secret: null, ...s, stats: { ...zero, ...s.stats } })),
      awards: [],
      bets: [],
    };
    return store.games.save(record);
  }

  it('adds played, wins and Ludo counters to stats.perGame for every game kind, and moves the Ludo missions', async () => {
    const a = await account();
    const b = await account();
    const now = new Date();
    const fresh = (ids: string[]) => ids.map((id) => ({ id, progress: 0, done: false }));
    await users.updateOne(
      { _id: a.oid },
      { $set: { missions: { rev: 1, day: istDay(now), week: istWeek(now), daily: fresh(['d-ludokills3', 'd-ludosixes8', 'd-ludogames2', 'd-games3']), weekly: fresh(['w-ludowins3', 'w-ludohome20', 'w-games15', 'w-wins5']) } } },
    );
    await save('ludo', [
      { memberId: 'a', userId: a.id, won: true, place: 1, stats: { ...zero, tallies: { kills: 3, killed: 1, home: 4, sixes: 5 } } },
      { memberId: 'b', userId: b.id, loser: true, place: 2, stats: { ...zero, tallies: { kills: 1, killed: 3, home: 2, sixes: 2 } } },
    ]);
    await save('bluff', [
      { memberId: 'a', userId: a.id, loser: true },
      { memberId: 'b', userId: b.id, won: true },
    ]);
    const ua = (await users.findOne({ _id: a.oid }))!;
    const ub = (await users.findOne({ _id: b.oid }))!;
    expect(ua.stats.perGame).toEqual({ ludo: { played: 1, wins: 1, kills: 3, killed: 1, home: 4, sixes: 5 }, bluff: { played: 1, wins: 0 } });
    expect(ub.stats.perGame).toEqual({ ludo: { played: 1, wins: 0, kills: 1, killed: 3, home: 2, sixes: 2 }, bluff: { played: 1, wins: 1 } });
    expect(ua.stats.gamesPlayed).toBe(2);
    const m = ua.missions!;
    const p = (id: string) => [...m.daily, ...m.weekly].find((x) => x.id === id);
    expect(p('d-ludokills3')).toMatchObject({ progress: 3, done: true });
    expect(p('d-ludosixes8')).toMatchObject({ progress: 5, done: false });
    expect(p('d-ludogames2')).toMatchObject({ progress: 1 });
    expect(p('w-ludowins3')).toMatchObject({ progress: 1 });
    expect(p('w-ludohome20')).toMatchObject({ progress: 4 });
  });
});
