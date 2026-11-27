import { MongoClient, ObjectId, type Collection } from 'mongodb';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { UserDoc } from '../src/db/documents.js';
import type { GameRecord, GameRecordPlayer } from '../src/models.js';
import { createBluffServer } from '../src/server.js';
import { createStore, type Store } from '../src/services/store.js';
import type { GameKind, PublicUser } from '../src/types.js';
import { parseConfig } from '../src/validate.js';

// run with TEST_MONGODB_URI=mongodb://127.0.0.1:27099 (a throwaway database is created and dropped)
const MONGO = process.env.TEST_MONGODB_URI;
const DB = `bluff_arcade_stats_test_${Date.now()}`;

describe.skipIf(!MONGO)('Fruit and Spikes stats (MongoDB)', () => {
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
    const res = await request(server.app).post('/api/auth/register').send({ username: `arcade_${++made}`, password: 'secret-pass-1' });
    expect(res.status).toBe(201);
    const user = res.body.user as PublicUser;
    return { id: user.id, oid: new ObjectId(user.id) };
  }

  const zero = { bluffs: 0, caught: 0, goodCalls: 0, wrongCalls: 0, pickedUp: 0, plays: 0, chances: 0 };
  async function save(game: GameKind, seats: (Partial<GameRecordPlayer> & { memberId: string })[]) {
    const record: GameRecord = {
      roomCode: 'ARCD',
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

  it('Fruit counters add up, but bestCombo keeps the best game; Spikes counters add up', async () => {
    const a = await account();
    const b = await account();
    const fruit = (combo: number, sliced: number) => [
      { memberId: 'a', userId: a.id, won: true, place: 1, stats: { ...zero, tallies: { sliced, bombs: 1, bestCombo: combo } } },
      { memberId: 'b', userId: b.id, loser: true, place: 2, stats: { ...zero, tallies: { sliced: 2, bombs: 0, bestCombo: 1 } } },
    ];
    await save('fruit', fruit(6, 20));
    await save('fruit', fruit(3, 15));
    await save('spikes', [
      { memberId: 'a', userId: a.id, loser: true, place: 2, stats: { ...zero, tallies: { dodges: 4, hits: 3 } } },
      { memberId: 'b', userId: b.id, won: true, place: 1, stats: { ...zero, tallies: { dodges: 7, hits: 1 } } },
    ]);
    const ua = (await users.findOne({ _id: a.oid }))!;
    expect(ua.stats.perGame).toEqual({ fruit: { played: 2, wins: 2, sliced: 35, bombs: 2, bestCombo: 6 }, spikes: { played: 1, wins: 0, dodges: 4, hits: 3 } });
    const ub = (await users.findOne({ _id: b.oid }))!;
    expect(ub.stats.perGame?.fruit).toEqual({ played: 2, wins: 0, sliced: 4, bombs: 0, bestCombo: 1 });
  });
});
