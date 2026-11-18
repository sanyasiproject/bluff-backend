import { MongoClient, ObjectId, type Collection } from 'mongodb';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { istDay, istWeek, nextIstDay, nextIstWeek } from '../src/days.js';
import type { MissionDoc, UserDoc } from '../src/db/documents.js';
import type { GameRecord, GameRecordPlayer } from '../src/models.js';
import { createBluffServer } from '../src/server.js';
import { dealMissions, freshMissions } from '../src/services/missions.js';
import { createStore, type Store } from '../src/services/store.js';
import {
  levelOf,
  MISSIONS,
  MISSIONS_PER_SET,
  missionOf,
  SECRET_XP,
  xpOf,
  type CoinResult,
  type GameConfig,
  type GameKind,
  type MissionsResponse,
  type PublicUser,
} from '../src/types.js';

// run with TEST_MONGODB_URI=mongodb://127.0.0.1:27099 (a throwaway database is created and dropped)
const MONGO = process.env.TEST_MONGODB_URI;
const DB = `bluff_missions_test_${Date.now()}`;

// Thursday 19 Nov 2026, 09:30 IST, and the days after it
const THU = new Date('2026-11-19T04:00:00Z');
const FRI = new Date('2026-11-20T04:00:00Z');
const MON = new Date('2026-11-23T04:00:00Z');

const idsOf = (set: { id: string }[]) => set.map((m) => m.id);

describe('IST days and weeks', () => {
  it('starts each day at IST midnight and each week on Monday 00:00 IST', () => {
    const thu = new Date('2026-11-19T10:00:00Z');
    expect([istDay(thu), istWeek(thu)]).toEqual(['2026-11-19', '2026-11-16']);
    expect(nextIstDay(thu).toISOString()).toBe('2026-11-19T18:30:00.000Z');
    expect(nextIstWeek(thu).toISOString()).toBe('2026-11-22T18:30:00.000Z');
    // just after UTC midnight it's already morning in India
    expect(istDay(new Date('2026-11-18T23:00:00Z'))).toBe('2026-11-19');
    // the last second of Sunday in India, then Monday's first
    const sunday = new Date('2026-11-22T18:29:59Z');
    expect([istDay(sunday), istWeek(sunday)]).toEqual(['2026-11-22', '2026-11-16']);
    expect(nextIstWeek(sunday).toISOString()).toBe('2026-11-22T18:30:00.000Z');
    const monday = new Date('2026-11-22T18:30:00Z');
    expect([istDay(monday), istWeek(monday)]).toEqual(['2026-11-23', '2026-11-23']);
    expect(nextIstDay(monday).toISOString()).toBe('2026-11-23T18:30:00.000Z');
    expect(nextIstWeek(monday).toISOString()).toBe('2026-11-29T18:30:00.000Z');
    // across a new year
    const newYear = new Date('2027-01-01T06:00:00Z');
    expect([istDay(newYear), istWeek(newYear)]).toEqual(['2027-01-01', '2026-12-28']);
  });
});

describe('dealing missions', () => {
  it('deals each set as one social mission and two others of its period, no repeats, the same every time', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 60; i++) {
      const userId = new ObjectId().toHexString();
      for (const [period, key] of [['daily', '2026-11-19'], ['weekly', '2026-11-16']] as const) {
        const set = dealMissions(userId, period, key);
        const defs = set.map((m) => missionOf(m.id)!);
        expect(set).toHaveLength(MISSIONS_PER_SET);
        expect(new Set(idsOf(set)).size).toBe(MISSIONS_PER_SET);
        expect(defs.every((d) => d.period === period)).toBe(true);
        expect(defs.filter((d) => d.social)).toHaveLength(1);
        expect(set.every((m) => m.progress === 0 && !m.done)).toBe(true);
        expect(dealMissions(userId, period, key)).toEqual(set);
        idsOf(set).forEach((id) => seen.add(id));
      }
    }
    // every mission comes up for someone
    expect([...seen].sort()).toEqual(MISSIONS.map((m) => m.id).sort());
  });

  it('gives different accounts and different days different sets', () => {
    const me = new ObjectId().toHexString();
    const days = Array.from({ length: 30 }, (_, i) => idsOf(dealMissions(me, 'daily', `2026-12-${String(i + 1).padStart(2, '0')}`)).join());
    expect(new Set(days).size).toBeGreaterThan(5);
    const people = Array.from({ length: 30 }, () => idsOf(dealMissions(new ObjectId().toHexString(), 'weekly', '2026-11-16')).join());
    expect(new Set(people).size).toBeGreaterThan(3);
  });

  it('replaces only a set whose day or week has passed', () => {
    const me = new ObjectId().toHexString();
    const m = freshMissions(undefined, me, THU);
    expect(m).toMatchObject({ rev: 0, day: '2026-11-19', week: '2026-11-16' });
    expect(m.daily).toEqual(dealMissions(me, 'daily', '2026-11-19'));
    expect(m.weekly).toEqual(dealMissions(me, 'weekly', '2026-11-16'));
    // 23:59 IST the same day: nothing new
    expect(freshMissions(m, me, new Date('2026-11-19T18:29:00Z'))).toBe(m);
    const fri = freshMissions(m, me, FRI);
    expect(fri.day).toBe('2026-11-20');
    expect(fri.daily).toEqual(dealMissions(me, 'daily', '2026-11-20'));
    expect(fri.weekly).toBe(m.weekly);
    const mon = freshMissions(fri, me, MON);
    expect(mon).toMatchObject({ day: '2026-11-23', week: '2026-11-23' });
    expect(mon.weekly).toEqual(dealMissions(me, 'weekly', '2026-11-23'));
  });
});

describe.skipIf(!MONGO)('missions (MongoDB)', () => {
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
  /** a new account with 1,200 coins (sign-up bonus included) */
  async function account(username = `mis_${++made}`) {
    const res = await api().post('/api/auth/register').send({ username, password: 'secret-pass-1' });
    expect(res.status).toBe(201);
    const user = res.body.user as PublicUser;
    return { id: user.id, oid: new ObjectId(user.id), token: res.body.token as string, username };
  }
  const fresh = (ids: string[]): MissionDoc[] => ids.map((id) => ({ id, progress: 0, done: false }));
  /** gives an account a known set for that day and week */
  const setMissions = (oid: ObjectId, daily: string[], weekly: string[], now = new Date()) =>
    users.updateOne({ _id: oid }, { $set: { missions: { rev: 1, day: istDay(now), week: istWeek(now), daily: fresh(daily), weekly: fresh(weekly) } } });
  const doc = async (oid: ObjectId) => (await users.findOne({ _id: oid }))!;

  it('keeps the same sets all day, deals new daily ones each IST day and new weekly ones each Monday', async () => {
    const a = await account();
    const first = await store.missions.get(a.oid, THU);
    expect(first).toEqual({
      daily: dealMissions(a.id, 'daily', '2026-11-19'),
      weekly: dealMissions(a.id, 'weekly', '2026-11-16'),
      rerollLeft: true,
      dailyResetAt: '2026-11-19T18:30:00.000Z',
      weeklyResetAt: '2026-11-22T18:30:00.000Z',
    });
    // later that day: the same set, and nothing written
    const rev = (await doc(a.oid)).missions!.rev;
    const later = await store.missions.get(a.oid, new Date('2026-11-19T18:00:00Z'));
    expect([later.daily, later.weekly]).toEqual([first.daily, first.weekly]);
    expect((await doc(a.oid)).missions!.rev).toBe(rev);

    // a game on Thursday moves one weekly mission (and maybe a daily one with the same counter)
    const weeklyId = first.weekly[0].id;
    const thursday = await store.missions.count(a.oid, { [missionOf(weeklyId)!.counter]: 1 }, THU);
    expect(thursday.every((d) => missionOf(d.id)!.period === 'daily')).toBe(true);

    // Friday: a fresh daily set, the same weekly one with its progress
    const fri = await store.missions.get(a.oid, FRI);
    expect(fri.daily).toEqual(dealMissions(a.id, 'daily', '2026-11-20'));
    expect(fri.weekly).toEqual(first.weekly.map((m) => (m.id === weeklyId ? { ...m, progress: 1 } : m)));
    expect(fri.dailyResetAt).toBe('2026-11-20T18:30:00.000Z');
    expect(fri.weeklyResetAt).toBe('2026-11-22T18:30:00.000Z');

    // Monday: both start again
    const mon = await store.missions.get(a.oid, MON);
    expect(mon.daily).toEqual(dealMissions(a.id, 'daily', '2026-11-23'));
    expect(mon.weekly).toEqual(dealMissions(a.id, 'weekly', '2026-11-23'));
    expect(mon.weeklyResetAt).toBe('2026-11-29T18:30:00.000Z');
  });

  it('counts progress up to the goal and pays coins and XP once, in the same write', async () => {
    const a = await account();
    await setMissions(a.oid, ['d-games3', 'd-win1', 'd-friend1'], ['w-games15', 'w-wins5', 'w-friend5']);
    const before = await doc(a.oid);
    expect(await store.missions.count(a.oid, { games: 2 })).toEqual([]);
    expect(await store.missions.count(a.oid, { games: 5, wins: 1, goodCalls: 4 })).toEqual([
      { id: 'd-games3', coins: 150, xp: 30 },
      { id: 'd-win1', coins: 200, xp: 40 },
    ]);
    // done ones stay done and never pay again
    expect(await store.missions.count(a.oid, { games: 1, wins: 1 })).toEqual([]);
    const now = await store.missions.get(a.oid);
    expect(now.daily).toEqual([
      { id: 'd-games3', progress: 3, done: true },
      { id: 'd-win1', progress: 1, done: true },
      { id: 'd-friend1', progress: 0, done: false },
    ]);
    expect(now.weekly).toEqual([
      { id: 'w-games15', progress: 8, done: false },
      { id: 'w-wins5', progress: 2, done: false },
      { id: 'w-friend5', progress: 0, done: false },
    ]);
    const after = await doc(a.oid);
    expect(after.coins - before.coins).toBe(350);
    expect(after.stats.bonusXp - before.stats.bonusXp).toBe(70);

    // writes racing each other all land, and a mission is paid by exactly one of them
    const raced = await Promise.all([1, 2, 3, 4].map(() => store.missions.count(a.oid, { friendGames: 1 })));
    expect(raced.flat()).toEqual([{ id: 'd-friend1', coins: 200, xp: 40 }]);
    expect((await store.missions.get(a.oid)).weekly[2]).toEqual({ id: 'w-friend5', progress: 4, done: false });
    expect((await doc(a.oid)).coins - before.coins).toBe(550);

    // a swap and a game at the same time: neither overwrites the other
    await Promise.all([store.missions.swap(a.oid, 'w-wins5'), store.missions.count(a.oid, { games: 1 })]);
    const both = await store.missions.get(a.oid);
    expect(both.rerollLeft).toBe(false);
    expect(idsOf(both.weekly)).not.toContain('w-wins5');
    expect(both.weekly[0]).toEqual({ id: 'w-games15', progress: 9, done: false });
    expect(both.weekly[1]).toMatchObject({ progress: 0, done: false });
  });

  it('swaps one unfinished mission a day, daily or weekly, for another of the same period starting at 0', async () => {
    const a = await account();
    await setMissions(a.oid, ['d-games3', 'd-win1', 'd-friend1'], ['w-games15', 'w-wins5', 'w-friend5'], THU);
    await store.missions.count(a.oid, { games: 1, wins: 1 }, THU);
    await expect(store.missions.swap(a.oid, 'd-win1', THU)).rejects.toMatchObject({ status: 400, message: 'That mission is done' });
    await expect(store.missions.swap(a.oid, 'w-catch10', THU)).rejects.toMatchObject({ status: 400, message: "That isn't one of your missions" });
    await expect(store.missions.swap(a.oid, 'made-up', THU)).rejects.toMatchObject({ status: 400, message: "That isn't one of your missions" });

    const swapped = await store.missions.swap(a.oid, 'd-games3', THU);
    expect(swapped.rerollLeft).toBe(false);
    expect(swapped.daily[0]).toMatchObject({ progress: 0, done: false });
    expect(missionOf(swapped.daily[0].id)!.period).toBe('daily');
    expect(['d-games3', 'd-win1', 'd-friend1']).not.toContain(swapped.daily[0].id);
    expect(swapped.daily.slice(1)).toEqual([
      { id: 'd-win1', progress: 1, done: true },
      { id: 'd-friend1', progress: 0, done: false },
    ]);
    expect(swapped.weekly).toEqual([
      { id: 'w-games15', progress: 1, done: false },
      { id: 'w-wins5', progress: 1, done: false },
      { id: 'w-friend5', progress: 0, done: false },
    ]);
    // one a day across both sets, and the swap sticks for the rest of the day
    await expect(store.missions.swap(a.oid, 'w-games15', THU)).rejects.toMatchObject({ status: 400, message: 'You already swapped a mission today' });
    expect((await store.missions.get(a.oid, new Date('2026-11-19T18:00:00Z'))).daily).toEqual(swapped.daily);

    // the next day brings a new swap, here for a weekly mission
    expect((await store.missions.get(a.oid, FRI)).rerollLeft).toBe(true);
    const weekly = await store.missions.swap(a.oid, 'w-games15', FRI);
    expect(weekly.rerollLeft).toBe(false);
    expect(weekly.weekly[0]).toMatchObject({ progress: 0, done: false });
    expect(missionOf(weekly.weekly[0].id)!.period).toBe('weekly');
    expect(['w-games15', 'w-wins5', 'w-friend5']).not.toContain(weekly.weekly[0].id);
    expect(weekly.weekly.slice(1)).toEqual(swapped.weekly.slice(1));
    expect(weekly.daily).toEqual(dealMissions(a.id, 'daily', '2026-11-20'));
  });

  it('swaps the social mission for one you can do alone, and never swaps one in', async () => {
    const away = new Set<string>();
    for (let i = 0; i < 12; i++) {
      const a = await account();
      await setMissions(a.oid, ['d-games3', 'd-win1', 'd-friend1'], ['w-games15', 'w-wins5', 'w-friend5'], THU);
      // the friends mission goes, and what comes in is never social
      const s = await store.missions.swap(a.oid, i % 2 === 0 ? 'd-friend1' : 'd-games3', THU);
      for (const m of s.daily) away.add(m.id);
      expect(s.daily.filter((m) => missionOf(m.id)!.social).map((m) => m.id)).toEqual(i % 2 === 0 ? [] : ['d-friend1']);
    }
    expect(away.has('d-friend2')).toBe(false);
  });

  const CONFIG: GameConfig = {
    game: 'bluff', decks: 1, bluffRule: 'one', stake: 0, peeks: 0, bets: false, teams: false,
    handSize: 7, maxPicks: 1, stack7: true, botLevel: 'expert', saza: false, secretLies: false,
  };
  const zero = { bluffs: 0, caught: 0, goodCalls: 0, wrongCalls: 0, pickedUp: 0, plays: 0, chances: 0 };
  type Seat = Partial<GameRecordPlayer> & { memberId: string };
  /** a saved game's coin results by member id */
  async function play(seats: Seat[], opts: { seconds?: number; status?: GameRecord['status']; game?: GameKind } = {}) {
    const record: GameRecord = {
      roomCode: 'MISN',
      config: { ...CONFIG, game: opts.game ?? 'bluff' },
      status: opts.status ?? 'finished',
      startedAt: new Date(Date.now() - (opts.seconds ?? 90) * 1000),
      endedAt: new Date(),
      players: seats.map((s) => ({
        userId: null, name: s.memberId, place: null, loser: false, kicked: false, won: false, bot: false, secret: null, ...s,
        stats: { ...zero, ...s.stats },
      })),
      awards: [],
      bets: [],
    };
    return new Map((await store.games.save(record)).map((r) => [r.playerId, r] as [string, CoinResult]));
  }
  const missionsOf = async (oid: ObjectId) => {
    const m = (await doc(oid)).missions!;
    return [...m.daily, ...m.weekly].map((x) => `${x.id} ${x.progress}${x.done ? ' done' : ''}`);
  };
  type Account = Awaited<ReturnType<typeof account>>;
  /** a sends b a friend request; b accepts unless told not to */
  async function befriend(a: Account, b: Account, accept = true) {
    expect((await api().post('/api/friends/request').set(bearer(a.token)).send({ username: b.username })).body.result).toBe('sent');
    if (accept) expect((await api().post(`/api/friends/${a.id}/accept`).set(bearer(b.token))).status).toBe(204);
  }

  it('still saves a game and counts its other missions when the friends lookup fails', async () => {
    const [ed, flo] = [await account('mis_ed'), await account('mis_flo')];
    await befriend(ed, flo);
    await setMissions(ed.oid, ['d-games3', 'd-win1', 'd-friend1'], ['w-games15', 'w-wins5', 'w-friend5']);
    const friends = (store.games as unknown as { cols: { friends: { find: (...args: unknown[]) => unknown } } }).cols.friends;
    const find = friends.find;
    friends.find = () => {
      throw new Error('friends lookup failed');
    };
    try {
      const res = await play([
        { memberId: 'ed', userId: ed.id, won: true, place: 1 },
        { memberId: 'flo', userId: flo.id, loser: true },
      ]);
      // the game's results still arrive; only the friends mission misses this game
      expect(res.get('ed')).toMatchObject({ counted: true, missionsDone: [{ id: 'd-win1', coins: 200, xp: 40 }] });
    } finally {
      friends.find = find;
    }
    expect(await missionsOf(ed.oid)).toEqual(['d-games3 1', 'd-win1 1 done', 'd-friend1 0', 'w-games15 1', 'w-wins5 1', 'w-friend5 0']);
  });

  it('moves missions only with games that count, with friends at the table and secret cards, and says so in the results', async () => {
    const [ana, bo, cy, di] = [await account('mis_ana'), await account('mis_bo'), await account('mis_cy'), await account('mis_di')];
    await befriend(ana, bo);
    await befriend(ana, cy, false);
    await befriend(ana, di);
    await setMissions(ana.oid, ['d-win1', 'd-secret1', 'd-friend1'], ['w-sneak12', 'w-secret5', 'w-friend5']);
    await setMissions(bo.oid, ['d-catch2', 'd-games3', 'd-friend2'], ['w-catch10', 'w-games15', 'w-friend5']);
    await setMissions(cy.oid, ['d-games3', 'd-sneak3', 'd-friend1'], ['w-games15', 'w-wins5', 'w-friend5']);
    await setMissions(di.oid, ['d-games3', 'd-win1', 'd-friend1'], ['w-games15', 'w-wins5', 'w-friend5']);

    // a counted game: Ana wins with her secret card done, Bo is her friend, Cy only asked, Di was removed
    const first = await play([
      { memberId: 'ana', userId: ana.id, won: true, place: 1, stats: { ...zero, goodCalls: 1, bluffs: 3, caught: 1 }, secret: { id: 'catch2', done: true } },
      { memberId: 'bo', userId: bo.id, loser: true, stats: { ...zero, goodCalls: 2 }, secret: { id: 'sneak2', done: false } },
      { memberId: 'cy', userId: cy.id, secret: { id: 'bait', done: false } },
      { memberId: 'di', userId: di.id, kicked: true, secret: { id: 'bigDrop', done: true } },
      { memberId: 'bot', bot: true },
    ]);
    // 20 + 50 for the win + 5 for the call + 3 for each of 2 clean bluffs
    expect(first.get('ana')).toMatchObject({
      counted: true, xp: 81, secretXp: SECRET_XP, bonus: 100, coins: 1200 + 100 + 550, level: 2,
      missionsDone: [{ id: 'd-win1', coins: 200, xp: 40 }, { id: 'd-secret1', coins: 150, xp: 30 }, { id: 'd-friend1', coins: 200, xp: 40 }],
    });
    expect(first.get('bo')).toMatchObject({ counted: true, xp: 30, secretXp: 0, coins: 1200 + 100 + 150, missionsDone: [{ id: 'd-catch2', coins: 150, xp: 30 }] });
    expect(first.get('cy')).toMatchObject({ counted: true, secretXp: 0, coins: 1300, missionsDone: [] });
    expect(first.get('di')).toMatchObject({ counted: false, xp: 0, secretXp: 0, coins: 1200, missionsDone: [] });
    expect(first.get('bot')).toMatchObject({ counted: false, secretXp: 0, coins: null, missionsDone: [] });
    expect(await missionsOf(ana.oid)).toEqual(['d-win1 1 done', 'd-secret1 1 done', 'd-friend1 1 done', 'w-sneak12 2', 'w-secret5 1', 'w-friend5 1']);
    expect(await missionsOf(bo.oid)).toEqual(['d-catch2 2 done', 'd-games3 1', 'd-friend2 1', 'w-catch10 2', 'w-games15 1', 'w-friend5 1']);
    expect(await missionsOf(cy.oid)).toEqual(['d-games3 1', 'd-sneak3 0', 'd-friend1 0', 'w-games15 1', 'w-wins5 0', 'w-friend5 0']);
    expect(await missionsOf(di.oid)).toEqual(['d-games3 0', 'd-win1 0', 'd-friend1 0', 'w-games15 0', 'w-wins5 0', 'w-friend5 0']);
    // the bonus XP is in the account's stats and level
    const me = (await api().get('/api/me').set(bearer(ana.token))).body.user as PublicUser;
    expect(me.stats.bonusXp).toBe(SECRET_XP + 110);
    expect(xpOf(me.stats)).toBe(81 + 135);
    expect(levelOf(me.stats)).toBe(2);

    // under a minute, or stopped: nothing moves and the card pays nothing
    const short = await play([
      { memberId: 'ana', userId: ana.id, won: true, place: 1, secret: { id: 'catch2', done: true } },
      { memberId: 'bo', userId: bo.id, loser: true },
    ], { seconds: 30 });
    expect(short.get('ana')).toMatchObject({ counted: false, xp: 70, secretXp: 0, missionsDone: [] });
    const stopped = await play([
      { memberId: 'ana', userId: ana.id, secret: { id: 'catch2', done: true } },
      { memberId: 'bo', userId: bo.id },
    ], { status: 'ended_early' });
    expect(stopped.get('ana')).toMatchObject({ counted: false, xp: 0, secretXp: 0, missionsDone: [] });
    expect(await missionsOf(ana.oid)).toEqual(['d-win1 1 done', 'd-secret1 1 done', 'd-friend1 1 done', 'w-sneak12 2', 'w-secret5 1', 'w-friend5 1']);
    expect((await doc(ana.oid)).stats.bonusXp).toBe(135);

    // a removed friend doesn't count as a friend at the table
    const removed = await play([
      { memberId: 'ana', userId: ana.id, secret: { id: 'sneak2', done: true } },
      { memberId: 'di', userId: di.id, kicked: true },
      { memberId: 'cy', userId: cy.id, won: true, place: 1 },
    ]);
    expect(removed.get('ana')).toMatchObject({ counted: true, secretXp: SECRET_XP, missionsDone: [] });
    expect(await missionsOf(ana.oid)).toEqual(['d-win1 1 done', 'd-secret1 1 done', 'd-friend1 1 done', 'w-sneak12 2', 'w-secret5 2', 'w-friend5 1']);
    expect((await doc(ana.oid)).stats.bonusXp).toBe(135 + SECRET_XP);
  });

  it('counts Crazy 7 games, wins and sevens, and Bluff calls and clean lies only in Bluff', async () => {
    const eve = await account('mis_eve');
    await setMissions(eve.oid, ['d-c7games2', 'd-sevens3', 'd-sneak3'], ['w-c7wins3', 'w-catch10', 'w-friend5']);
    const c7 = await play(
      [{ memberId: 'eve', userId: eve.id, won: true, place: 1, stats: { ...zero, sevens: 3, goodCalls: 5, bluffs: 4 } }, { memberId: 'bot', bot: true }],
      { game: 'crazy7' },
    );
    expect(c7.get('eve')).toMatchObject({ counted: true, missionsDone: [{ id: 'd-sevens3', coins: 150, xp: 30 }] });
    expect(await missionsOf(eve.oid)).toEqual(['d-c7games2 1', 'd-sevens3 3 done', 'd-sneak3 0', 'w-c7wins3 1', 'w-catch10 0', 'w-friend5 0']);
    await play([{ memberId: 'eve', userId: eve.id, won: true, place: 1, stats: { ...zero, sevens: 2, goodCalls: 1, bluffs: 2 } }, { memberId: 'bot', bot: true }]);
    expect(await missionsOf(eve.oid)).toEqual(['d-c7games2 1', 'd-sevens3 3 done', 'd-sneak3 2', 'w-c7wins3 1', 'w-catch10 1', 'w-friend5 0']);
  });

  it('adds a done secret card to bonus XP, so the level counts it', async () => {
    const fay = await account('mis_fay');
    await setMissions(fay.oid, ['d-c7games2', 'd-sevens3', 'd-friend2'], ['w-c7wins3', 'w-catch10', 'w-friend5']);
    await users.updateOne({ _id: fay.oid }, { $set: { 'stats.bonusXp': 10 } });
    const won = await play([
      { memberId: 'fay', userId: fay.id, won: true, place: 1, secret: { id: 'bigDrop', done: true } },
      { memberId: 'bot', bot: true },
    ]);
    // 70 for the game + 10 earlier + 25 for the card: 105, just past level 2's 100
    expect(won.get('fay')).toMatchObject({ counted: true, xp: 70, secretXp: SECRET_XP, missionsDone: [], level: 2 });
    const stats = (await doc(fay.oid)).stats;
    expect(stats.bonusXp).toBe(10 + SECRET_XP);
    expect(levelOf({ ...stats, bonusXp: 10 })).toBe(1);
  });

  it('serves the missions and the daily swap over HTTP', async () => {
    const a = await account();
    expect((await api().get('/api/me/missions')).status).toBe(401);
    expect((await api().post('/api/me/missions/swap').send({ id: 'd-win1' })).status).toBe(401);

    const res = await api().get('/api/me/missions').set(bearer(a.token));
    expect(res.status).toBe(200);
    const body = res.body as MissionsResponse;
    expect(body.daily).toEqual(dealMissions(a.id, 'daily', istDay()));
    expect(body.weekly).toEqual(dealMissions(a.id, 'weekly', istWeek()));
    expect(body.rerollLeft).toBe(true);
    expect(Date.parse(body.dailyResetAt)).toBeGreaterThan(Date.now());
    expect(Date.parse(body.dailyResetAt) - Date.now()).toBeLessThanOrEqual(86_400_000);
    expect(Date.parse(body.weeklyResetAt)).toBeGreaterThanOrEqual(Date.parse(body.dailyResetAt));
    expect((await api().get('/api/me/missions').set(bearer(a.token))).body).toEqual(body);

    for (const bad of [{}, { id: 7 }, { id: 'x'.repeat(41) }, { id: 'w-nope' }]) {
      const r = await api().post('/api/me/missions/swap').set(bearer(a.token)).send(bad);
      expect([r.status, r.body.error]).toEqual([400, "That isn't one of your missions"]);
    }
    const swap = await api().post('/api/me/missions/swap').set(bearer(a.token)).send({ id: body.daily[1].id });
    expect(swap.status).toBe(200);
    const swapped = swap.body as MissionsResponse;
    expect(swapped.rerollLeft).toBe(false);
    expect([swapped.daily[0], swapped.daily[2]]).toEqual([body.daily[0], body.daily[2]]);
    expect(idsOf(body.daily)).not.toContain(swapped.daily[1].id);
    expect(missionOf(swapped.daily[1].id)).toMatchObject({ period: 'daily' });
    expect(swapped.weekly).toEqual(body.weekly);
    const again = await api().post('/api/me/missions/swap').set(bearer(a.token)).send({ id: body.weekly[0].id });
    expect([again.status, again.body.error]).toEqual([400, 'You already swapped a mission today']);
    expect((await api().get('/api/me/missions').set(bearer(a.token))).body).toEqual(swapped);

    // a finished mission can't be swapped
    const b = await account();
    await setMissions(b.oid, ['d-games3', 'd-win1', 'd-friend1'], ['w-games15', 'w-wins5', 'w-friend5']);
    await store.missions.count(b.oid, { wins: 1 });
    const done = await api().post('/api/me/missions/swap').set(bearer(b.token)).send({ id: 'd-win1' });
    expect([done.status, done.body.error]).toEqual([400, 'That mission is done']);
    expect((await api().get('/api/me/missions').set(bearer(b.token))).body.rerollLeft).toBe(true);
  });
});
