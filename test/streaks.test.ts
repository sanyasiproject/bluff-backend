import { MongoClient, ObjectId, type Collection } from 'mongodb';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { UserDoc } from '../src/db/documents.js';
import { istDay } from '../src/days.js';
import type { GameRecord } from '../src/models.js';
import { createBluffServer } from '../src/server.js';
import { SPIN_WEIGHTS, spinSlice } from '../src/services/spin.js';
import { createStore, type Store } from '../src/services/store.js';
import { LOGIN_STREAK_REWARDS, loginRewardOf, SPIN_PRIZES, type GameConfig } from '../src/types.js';

describe('streak and spin rules', () => {
  it('grows the login reward over 7 days, then starts the week again', () => {
    expect([1, 2, 3, 4, 5, 6, 7].map(loginRewardOf)).toEqual([...LOGIN_STREAK_REWARDS]);
    expect(loginRewardOf(8)).toBe(LOGIN_STREAK_REWARDS[0]);
    expect(loginRewardOf(14)).toBe(LOGIN_STREAK_REWARDS[6]);
    expect(loginRewardOf(0)).toBe(LOGIN_STREAK_REWARDS[0]);
  });

  it('has a chance for every slice of the wheel, adding up to 100', () => {
    expect(SPIN_WEIGHTS).toHaveLength(SPIN_PRIZES.length);
    expect(SPIN_WEIGHTS.reduce((a, b) => a + b, 0)).toBe(100);
    expect(spinSlice(0)).toBe(0);
    expect(spinSlice(27)).toBe(0);
    expect(spinSlice(28)).toBe(1);
    // the rarest slice is the biggest prize
    expect(SPIN_PRIZES[spinSlice(99)]).toEqual({ kind: 'coins', amount: 10_000 });
    const coins = SPIN_PRIZES.map((p, i) => ({ ...p, w: SPIN_WEIGHTS[i] })).filter((p) => p.kind === 'coins');
    for (let i = 1; i < coins.length; i++) if (coins[i].amount > coins[i - 1].amount) expect(coins[i].w).toBeLessThanOrEqual(coins[i - 1].w);
  });
});

// run with TEST_MONGODB_URI=mongodb://127.0.0.1:27099 (a throwaway database is created and dropped)
const MONGO = process.env.TEST_MONGODB_URI;
const DB = `bluff_streaks_test_${Date.now()}`;

describe.skipIf(!MONGO)('streaks and the daily spin (MongoDB)', () => {
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

  const api = () => request(server.app);
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const daysAgo = (n: number) => istDay(new Date(Date.now() - n * 86_400_000));
  async function account(username: string) {
    const res = await api().post('/api/auth/register').send({ username, password: 'secret-pass-1' });
    expect(res.status).toBe(201);
    return { token: res.body.token as string, id: res.body.user.id as string, oid: new ObjectId(res.body.user.id as string) };
  }

  it('starts a login streak at sign-up, grows it day after day and starts again after a missed day', async () => {
    const me = await account('streak_asha');
    expect((await api().get('/api/me').set(bearer(me.token))).body).toMatchObject({ bonus: 0, user: { loginStreak: 1 } });
    // came yesterday too: day 2 pays more
    await users.updateOne({ _id: me.oid }, { $set: { lastLoginBonusDay: daysAgo(1), loginStreak: 1, coins: 0 } });
    expect((await api().get('/api/me').set(bearer(me.token))).body).toMatchObject({ bonus: LOGIN_STREAK_REWARDS[1], user: { loginStreak: 2, coins: LOGIN_STREAK_REWARDS[1] } });
    // the same day again pays nothing
    expect((await api().get('/api/me').set(bearer(me.token))).body).toMatchObject({ bonus: 0, user: { loginStreak: 2 } });
    // day 7, then day 8 starts the week's rewards again
    await users.updateOne({ _id: me.oid }, { $set: { lastLoginBonusDay: daysAgo(1), loginStreak: 7 } });
    expect((await api().get('/api/me').set(bearer(me.token))).body).toMatchObject({ bonus: LOGIN_STREAK_REWARDS[0], user: { loginStreak: 8 } });
    // a missed day: back to day 1
    await users.updateOne({ _id: me.oid }, { $set: { lastLoginBonusDay: daysAgo(2), loginStreak: 5 } });
    expect((await api().get('/api/me').set(bearer(me.token))).body).toMatchObject({ bonus: LOGIN_STREAK_REWARDS[0], user: { loginStreak: 1 } });
  });

  it('spins the wheel once a day and pays what it lands on', async () => {
    const me = await account('streak_spin');
    const before = (await api().get('/api/me').set(bearer(me.token))).body.user;
    expect(before.spunToday).toBe(false);
    const res = await api().post('/api/me/spin').set(bearer(me.token));
    expect(res.status).toBe(200);
    const { index, prize, user } = res.body;
    expect(SPIN_PRIZES[index]).toEqual(prize);
    expect(user.spunToday).toBe(true);
    if (prize.kind === 'coins') expect(user.coins).toBe(before.coins + prize.amount);
    else expect(user.stats.bonusXp).toBe(before.stats.bonusXp + prize.amount);
    // a second spin the same day is refused, even two at once
    const again = await Promise.all([api().post('/api/me/spin').set(bearer(me.token)), api().post('/api/me/spin').set(bearer(me.token))]);
    expect(again.map((r) => r.status)).toEqual([409, 409]);
    // a new day: one more spin
    await users.updateOne({ _id: me.oid }, { $set: { lastSpinDay: daysAgo(1) } });
    expect((await api().post('/api/me/spin').set(bearer(me.token))).status).toBe(200);
    expect((await api().post('/api/me/spin')).status).toBe(401);
  });

  it('counts wins in a row and starts again after a finished game not won', async () => {
    const [a, b] = [await account('streak_win_a'), await account('streak_win_b')];
    const config = { game: 'bluff', decks: 1, bluffRule: 'one', stake: 0, peeks: 0, bets: false, teams: false, handSize: 7, maxPicks: 1, stack7: true, botLevel: 'expert' } as GameConfig;
    const zero = { bluffs: 0, caught: 0, goodCalls: 0, wrongCalls: 0, pickedUp: 0, plays: 0, chances: 0 };
    const play = async (winner: string, status: GameRecord['status'] = 'finished') => {
      const record: GameRecord = {
        roomCode: 'WINS',
        config,
        status,
        startedAt: new Date(Date.now() - 90_000),
        endedAt: new Date(),
        players: [a, b].map((p) => ({
          memberId: p.id, userId: p.id, name: p.id, place: p.id === winner ? 1 : null, loser: p.id !== winner, kicked: false, won: p.id === winner, bot: false, secret: null, stats: zero,
        })),
        awards: [],
        bets: [],
      };
      return new Map((await store.games.save(record)).map((r) => [r.playerId, r.winStreak]));
    };
    await play(a.id);
    await play(a.id);
    expect(await play(a.id)).toEqual(new Map([[a.id, 3], [b.id, 0]]));
    // a stopped game changes nothing
    expect(await play(b.id, 'ended_early')).toEqual(new Map([[a.id, null], [b.id, null]]));
    expect(await play(b.id)).toEqual(new Map([[a.id, 0], [b.id, 1]]));
    // rooms read it when someone joins
    expect((await store.users.getAccounts([b.id])).get(b.id)!.streak).toBe(1);
  });
});
