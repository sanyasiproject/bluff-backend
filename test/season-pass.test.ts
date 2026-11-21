import { MongoClient, ObjectId, type Collection } from 'mongodb';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { istDay, istWeek } from '../src/days.js';
import type { UserDoc } from '../src/db/documents.js';
import type { GameRecord, GameRecordPlayer } from '../src/models.js';
import { createBluffServer } from '../src/server.js';
import { passViewOf } from '../src/services/seasonPass.js';
import { createStore, type Store } from '../src/services/store.js';
import {
  MAX_SHIELDS,
  missionOf,
  PASS_SHIELD_COINS,
  PASS_TIER_XP,
  PASS_TIERS,
  PASS_XP,
  passTierOf,
  type CoinResult,
  type GameConfig,
  type GameKind,
  type PassClaimResponse,
  type PassResponse,
  type PublicUser,
} from '../src/types.js';

// run with TEST_MONGODB_URI=mongodb://127.0.0.1:27099 (a throwaway database is created and dropped)
const MONGO = process.env.TEST_MONGODB_URI;
const DB = `bluff_pass_test_${Date.now()}`;

describe('season pass track', () => {
  it('has 30 tiers: a shield every 5th tier apart from the big coin prizes at 10, 20 and 30', () => {
    expect(PASS_TIERS).toHaveLength(30);
    expect(PASS_TIERS.flatMap((t, i) => (t.kind === 'shield' ? [i + 1] : []))).toEqual([5, 15, 25]);
    const coins = PASS_TIERS.filter((t) => t.kind === 'coins').map((t) => t.amount);
    const big = [10, 20, 30].map((n) => PASS_TIERS[n - 1].amount);
    expect(Math.min(...big)).toBeGreaterThan(Math.max(...coins.filter((c) => !big.includes(c))));
    expect(PASS_TIERS.some((t) => t.kind === 'xp')).toBe(true);
  });

  it('works out tiers from pass XP, capped at the last tier', () => {
    expect([0, 99, 100, 250, 2_999, 3_000, 9_999, -5].map(passTierOf)).toEqual([0, 0, 1, 2, 29, 30, 30, 0]);
    const view = passViewOf({ season: 3, xp: 420, claimed: [1, 2] }, 3);
    expect(view).toMatchObject({ season: 3, xp: 420, tier: 4, claimable: 2 });
    expect(view.tiers.slice(0, 5).map((t) => [t.tier, t.reached, t.claimed])).toEqual([
      [1, true, true],
      [2, true, true],
      [3, true, false],
      [4, true, false],
      [5, false, false],
    ]);
    // a pass from another season counts as a fresh one
    expect(passViewOf({ season: 2, xp: 900, claimed: [1] }, 3)).toMatchObject({ xp: 0, tier: 0, claimable: 0 });
  });
});

describe.skipIf(!MONGO)('season pass (MongoDB)', () => {
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
  let made = 0;
  async function account(username = `pass_${++made}`) {
    const res = await api().post('/api/auth/register').send({ username, password: 'secret-pass-1' });
    expect(res.status).toBe(201);
    const user = res.body.user as PublicUser;
    return { id: user.id, oid: new ObjectId(user.id), token: res.body.token as string };
  }
  const doc = async (oid: ObjectId) => (await users.findOne({ _id: oid }))!;
  /** missions with nothing a plain game can finish, so pass XP is only the game's own */
  const quietMissions = (oid: ObjectId, daily = ['d-friend1', 'd-games5', 'd-games3']) =>
    users.updateOne(
      { _id: oid },
      {
        $set: {
          missions: {
            rev: 1,
            day: istDay(),
            week: istWeek(),
            daily: daily.map((id) => ({ id, progress: 0, done: false })),
            weekly: ['w-friend5', 'w-games15', 'w-wins5'].map((id) => ({ id, progress: 0, done: false })),
          },
        },
      },
    );
  const setPass = (oid: ObjectId, xp: number, claimed: number[] = []) =>
    users.updateOne({ _id: oid }, { $set: { pass: { season: store.settings.rankedSeason, xp, claimed } } });

  const CONFIG = {
    game: 'bluff', decks: 1, bluffRule: 'one', stake: 0, peeks: 0, bets: false, teams: false,
    handSize: 7, maxPicks: 1, stack7: true, botLevel: 'expert', saza: false, secretLies: false,
  } as GameConfig;
  const zero = { bluffs: 0, caught: 0, goodCalls: 0, wrongCalls: 0, pickedUp: 0, plays: 0, chances: 0 };
  type Seat = Partial<GameRecordPlayer> & { memberId: string };
  /** a saved game's coin results by member id */
  async function play(seats: Seat[], opts: { seconds?: number; status?: GameRecord['status']; game?: GameKind } = {}) {
    const record = {
      roomCode: 'PASS',
      config: { ...CONFIG, game: opts.game ?? 'bluff', ranked: false },
      status: opts.status ?? 'finished',
      startedAt: new Date(Date.now() - (opts.seconds ?? 90) * 1000),
      endedAt: new Date(),
      players: seats.map((s) => ({
        userId: null, name: s.memberId, place: null, loser: false, kicked: false, won: false, bot: false, secret: null, ...s,
        stats: { ...zero, ...s.stats },
      })),
      awards: [],
      bets: [],
      catches: [],
    } as GameRecord;
    return new Map((await store.games.save(record)).map((r) => [r.playerId, r] as [string, CoinResult]));
  }

  it('gives pass XP only for games that count: finished, long enough, logged in, not removed; wins add more; both games', async () => {
    const a = await account();
    const b = await account();
    const c = await account();
    for (const u of [a, b, c]) await quietMissions(u.oid);

    // a finished Bluff game: the winner gets game + win, the other only the game; a removed player and a guest nothing
    const r1 = await play([
      { memberId: 'a', userId: a.id, won: true, place: 1 },
      { memberId: 'b', userId: b.id, loser: true },
      { memberId: 'c', userId: c.id, kicked: true },
      { memberId: 'g' },
    ]);
    expect(r1.get('a')!.passXp).toBe(PASS_XP.game + PASS_XP.win);
    expect(r1.get('b')!.passXp).toBe(PASS_XP.game);
    expect(r1.get('c')!.passXp).toBe(0);
    expect(r1.get('g')!.passXp).toBe(0);

    // too short, or stopped: nothing
    await play([{ memberId: 'a', userId: a.id, won: true, place: 1 }, { memberId: 'b', userId: b.id }], { seconds: 5 });
    await play([{ memberId: 'a', userId: a.id }, { memberId: 'b', userId: b.id }], { status: 'ended_early' });
    // Crazy 7 counts too
    const r2 = await play([{ memberId: 'a', userId: a.id }, { memberId: 'b', userId: b.id, won: true, place: 1 }], { game: 'crazy7' });
    expect(r2.get('b')!.passXp).toBe(PASS_XP.game + PASS_XP.win);

    const pa = await store.pass.get(a.oid);
    const pb = await store.pass.get(b.oid);
    expect(pa.xp).toBe(PASS_XP.game * 2 + PASS_XP.win);
    expect(pb.xp).toBe(PASS_XP.game * 2 + PASS_XP.win);
    expect((await store.pass.get(c.oid)).xp).toBe(0);
    expect(pa.season).toBe(store.settings.rankedSeason);
  });

  it('adds pass XP for each daily or weekly mission a game finished', async () => {
    const a = await account();
    // only "win a game" can finish from one win
    await quietMissions(a.oid, ['d-win1', 'd-games5', 'd-friend1']);
    const r = await play([{ memberId: 'a', userId: a.id, won: true, place: 1 }, { memberId: 'x' }]);
    const done = r.get('a')!.missionsDone.map((d) => d.id);
    expect(done).toEqual(['d-win1']);
    expect(missionOf('d-win1')!.goal).toBe(1);
    expect(r.get('a')!.passXp).toBe(PASS_XP.game + PASS_XP.win + PASS_XP.mission);
    expect((await store.pass.get(a.oid)).xp).toBe(PASS_XP.game + PASS_XP.win + PASS_XP.mission);
  });

  it('pays a tier only once it is reached, once, even with taps at the same time', async () => {
    const a = await account();
    await setPass(a.oid, 150);
    const before = await doc(a.oid);
    await expect(store.pass.claim(a.oid, 2)).rejects.toMatchObject({ status: 400, message: 'Reach tier 2 first' });
    await expect(store.pass.claim(a.oid, 0)).rejects.toMatchObject({ status: 400 });
    await expect(store.pass.claim(a.oid, 31)).rejects.toMatchObject({ status: 400 });

    // four taps at once: exactly one pays
    const taps = await Promise.allSettled([1, 2, 3, 4].map(() => store.pass.claim(a.oid, 1)));
    const ok = taps.filter((t): t is PromiseFulfilledResult<PassClaimResponse> => t.status === 'fulfilled');
    expect(ok).toHaveLength(1);
    expect(taps.filter((t) => t.status === 'rejected').map((t) => (t as PromiseRejectedResult).reason.status)).toEqual([409, 409, 409]);
    expect(ok[0].value.got).toEqual(PASS_TIERS[0]);
    expect(ok[0].value.pass.tiers[0]).toMatchObject({ reached: true, claimed: true });
    expect(ok[0].value.pass.claimable).toBe(0);
    const after = await doc(a.oid);
    expect(after.coins - before.coins).toBe(PASS_TIERS[0].amount);
    expect(after.pass!.claimed).toEqual([1]);
    await expect(store.pass.claim(a.oid, 1)).rejects.toMatchObject({ status: 409, message: 'You already claimed that tier' });

    // a bonus XP tier adds level XP, not coins
    const xpTier = PASS_TIERS.findIndex((t) => t.kind === 'xp') + 1;
    await setPass(a.oid, xpTier * PASS_TIER_XP, [1]);
    const mid = await doc(a.oid);
    const res = await store.pass.claim(a.oid, xpTier);
    expect(res.got).toEqual({ kind: 'xp', amount: PASS_TIERS[xpTier - 1].amount });
    const end = await doc(a.oid);
    expect(end.stats.bonusXp - mid.stats.bonusXp).toBe(PASS_TIERS[xpTier - 1].amount);
    expect(end.coins).toBe(mid.coins);
  });

  it('gives a Rank Shield, or coins instead when they already hold the most', async () => {
    const a = await account();
    await setPass(a.oid, 30 * PASS_TIER_XP);
    const got = await store.pass.claim(a.oid, 5);
    expect(got).toMatchObject({ got: { kind: 'shield', amount: 1 }, shieldSwapped: false });
    expect((await doc(a.oid)).shop?.shields).toBe(1);
    // a shop write afterwards still works on top of it
    expect((await store.shop.get(a.oid)).shields).toBe(1);

    await users.updateOne({ _id: a.oid }, { $set: { 'shop.shields': MAX_SHIELDS } });
    const before = await doc(a.oid);
    const swapped = await store.pass.claim(a.oid, 15);
    expect(swapped).toMatchObject({ got: { kind: 'coins', amount: PASS_SHIELD_COINS }, shieldSwapped: true });
    const after = await doc(a.oid);
    expect(after.shop?.shields).toBe(MAX_SHIELDS);
    expect(after.coins - before.coins).toBe(PASS_SHIELD_COINS);
    expect(swapped.pass.tiers[14].claimed).toBe(true);
  });

  it('serves the pass and claims over the API', async () => {
    const a = await account();
    const empty = await api().get('/api/me/pass').set(bearer(a.token));
    expect(empty.status).toBe(200);
    const body = empty.body as PassResponse;
    expect(body).toMatchObject({ season: store.settings.rankedSeason, xp: 0, tier: 0, claimable: 0 });
    expect(body.tiers).toHaveLength(PASS_TIERS.length);
    expect(typeof body.startedAt).toBe('string');

    expect((await api().post('/api/me/pass/claim').set(bearer(a.token)).send({ tier: 'one' })).status).toBe(400);
    expect((await api().post('/api/me/pass/claim').set(bearer(a.token)).send({ tier: 1 })).status).toBe(400);
    await setPass(a.oid, 210);
    const res = await api().post('/api/me/pass/claim').set(bearer(a.token)).send({ tier: 2 });
    expect(res.status).toBe(200);
    expect(res.body.pass).toMatchObject({ tier: 2, claimable: 1 });
    expect((res.body.user as PublicUser).coins).toBe((await doc(a.oid)).coins);
    expect((await api().get('/api/me/pass')).status).toBe(401);
  });

  it('starts again when a new ranked season starts', async () => {
    const a = await account();
    await setPass(a.oid, 640, [1, 2]);
    const season = store.settings.rankedSeason;
    const at = new Date(Date.now() - 1000);
    expect(await store.settings.scheduleNextSeason(null, at)).toBe(true);
    expect(await store.ranked.startDueSeason(new Date())).toBe(season + 1);

    // read: a fresh pass for the new season, nothing claimable from the old one
    const fresh = await store.pass.get(a.oid);
    expect(fresh).toMatchObject({ season: season + 1, xp: 0, tier: 0, claimable: 0 });
    expect(fresh.tiers.every((t) => !t.claimed)).toBe(true);
    await expect(store.pass.claim(a.oid, 3)).rejects.toMatchObject({ status: 400, message: 'Reach tier 3 first' });

    // the first game of the new season starts the count from its own XP
    await store.pass.addXp(a.oid, 60);
    expect((await doc(a.oid)).pass).toEqual({ season: season + 1, xp: 60, claimed: [] });
    await store.pass.addXp(a.oid, 50);
    expect((await store.pass.get(a.oid))).toMatchObject({ xp: 110, tier: 1, claimable: 1 });
  });
});
