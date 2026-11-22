import { MongoClient, ObjectId, type Collection, type Document } from 'mongodb';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GameDoc, UserDoc } from '../src/db/documents.js';
import { createBluffServer } from '../src/server.js';
import { createStore, type Store } from '../src/services/store.js';
import { nameWordsOf } from '../src/services/users.js';
import { REPLAY_KEEP_DAYS } from '../src/types.js';

// run with TEST_MONGODB_URI=mongodb://127.0.0.1:27099 (a throwaway database is created and dropped)
const MONGO = process.env.TEST_MONGODB_URI;
const DB = `bluff_scale_test_${Date.now()}`;

/** every stage of a query's winning plan */
const stagesOf = (plan: Document): string[] => {
  const out: string[] = [];
  const walk = (p: Document | undefined) => {
    if (!p) return;
    if (typeof p.stage === 'string') out.push(p.stage);
    walk(p.inputStage);
    (p.inputStages as Document[] | undefined)?.forEach(walk);
  };
  walk(plan.queryPlanner.winningPlan);
  return out;
};

describe('display name words', () => {
  it('keeps the whole name and each word, lower case', () => {
    expect(nameWordsOf('  Asha   Rani ')).toEqual(['asha rani', 'asha', 'rani']);
    expect(nameWordsOf('Ravi')).toEqual(['ravi']);
    expect(nameWordsOf('   ')).toEqual([]);
  });
});

describe.skipIf(!MONGO)('queries that stay fast as players and games grow (MongoDB)', () => {
  let store: Store;
  let server: ReturnType<typeof createBluffServer>;
  let raw: MongoClient;
  let users: Collection<UserDoc>;
  let games: Collection<GameDoc>;

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
    games = raw.db(DB).collection<GameDoc>('games');
  });

  afterAll(async () => {
    server.close();
    await raw.db(DB).dropDatabase();
    await raw.close();
    await store.close();
  });

  const api = () => request(server.app);
  async function register(username: string, displayName: string) {
    const res = await api().post('/api/auth/register').send({ username, password: 'secret-pass-1', displayName });
    expect(res.status).toBe(201);
    return { token: res.body.token as string, oid: new ObjectId(res.body.user.id as string) };
  }

  it('coin rank and the admin list read along indexes, never every account', async () => {
    const rank = await users.find({ coins: { $gt: 500 } }).explain();
    expect(stagesOf(rank)).not.toContain('COLLSCAN');
    const admin = await users.find({}).sort({ createdAt: -1 }).limit(20).explain();
    expect(stagesOf(admin)).not.toContain('COLLSCAN');
    expect(stagesOf(admin)).not.toContain('SORT');
  });

  it('finds players by username or by the start of their name or any word of it, along indexes', async () => {
    const me = await register('scale_me', 'Me');
    await register('scale_asha', 'Asha Rani');
    await register('scale_prak', 'Prakash');
    const search = async (q: string) =>
      ((await api().get(`/api/friends/search?q=${encodeURIComponent(q)}`).set({ Authorization: `Bearer ${me.token}` })).body.players as { username: string }[]).map(
        (p) => p.username,
      );
    expect(await search('rani')).toEqual(['scale_asha']);
    expect(await search('ASHA R')).toEqual(['scale_asha']);
    // from the start only: "ash" finds Asha, not Prakash
    expect(await search('ash')).toEqual(['scale_asha']);
    expect(await search('scale_p')).toEqual(['scale_prak']);
    const plan = await users.find({ $or: [{ username: { $regex: '^ra' } }, { nameWords: { $regex: '^ra' } }] }).explain();
    expect(stagesOf(plan)).not.toContain('COLLSCAN');

    // an account from before nameWords gets them from the backfill, then the backfill finds nothing more
    const old = await register('scale_old', 'Old Timer');
    await users.updateOne({ _id: old.oid }, { $unset: { nameWords: '' } });
    expect(await search('timer')).toEqual([]);
    expect(await store.users.backfillNameWords()).toBe(1);
    expect(await search('timer')).toEqual(['scale_old']);
    expect(await store.users.backfillNameWords()).toBe(0);
  });

  it(`drops replays older than ${REPLAY_KEEP_DAYS} days and keeps the game and newer replays`, async () => {
    const day = 86_400_000;
    const gameAt = (daysAgo: number): GameDoc => ({
      _id: new ObjectId(),
      roomCode: 'OLDR',
      config: { game: 'bluff', decks: 1, bluffRule: 'one', stake: 0, peeks: 0, bets: false, teams: false } as GameDoc['config'],
      status: 'finished',
      startedAt: new Date(Date.now() - daysAgo * day - 120_000),
      endedAt: new Date(Date.now() - daysAgo * day),
      durationSec: 120,
      stake: 0,
      pot: 0,
      players: [],
      winnerName: null,
      loserName: null,
      awards: [],
      replay: { game: 'bluff', players: [], steps: [] } as unknown as GameDoc['replay'],
    });
    const [old, fresh] = [gameAt(REPLAY_KEEP_DAYS + 1), gameAt(REPLAY_KEEP_DAYS - 1)];
    await games.insertMany([old, fresh]);
    const plan = await games.find({ replay: { $exists: true }, endedAt: { $lt: new Date() } }).explain();
    expect(stagesOf(plan)).not.toContain('COLLSCAN');
    expect(await store.games.clearOldReplays()).toBe(1);
    const [a, b] = await Promise.all([games.findOne({ _id: old._id }), games.findOne({ _id: fresh._id })]);
    expect(a).toMatchObject({ roomCode: 'OLDR', status: 'finished' });
    expect(a!.replay).toBeUndefined();
    expect(b!.replay).toBeDefined();
    expect(await store.games.clearOldReplays()).toBe(0);
  });
});
