import { MongoClient, ObjectId, type Collection } from 'mongodb';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { istWeek, nextIstWeek } from '../src/days.js';
import type { FriendDoc, LeagueDoc, UserDoc } from '../src/db/documents.js';
import type { GameRecord, GameRecordPlayer } from '../src/models.js';
import { createBluffServer } from '../src/server.js';
import { boardOf, lastIstWeek, leaguePointsOf, weekOf, type LeagueEntry } from '../src/services/league.js';
import { createStore, type Store } from '../src/services/store.js';
import { LEAGUE_POINTS, type GameConfig, type GameKind, type LeagueResponse, type LeagueStats, type PublicUser } from '../src/types.js';

// run with TEST_MONGODB_URI=mongodb://127.0.0.1:27099 (a throwaway database is created and dropped)
const MONGO = process.env.TEST_MONGODB_URI;
const DB = `bluff_league_test_${Date.now()}`;

// Thursday 19 Nov 2026, 09:30 IST (the week of Monday 16 Nov), the Thursday before, next Monday and two weeks on
const THU = new Date('2026-11-19T04:00:00Z');
const LAST_THU = new Date('2026-11-12T04:00:00Z');
const NEXT_MON = new Date('2026-11-23T04:00:00Z');
const LATER = new Date('2026-12-03T04:00:00Z');

/** a week's counters with zeros for whatever isn't given */
const stats = (s: Partial<LeagueStats> = {}): LeagueStats => ({ points: 0, games: 0, wins: 0, goodCalls: 0, cleanBluffs: 0, ...s });

/** a row before it's placed, named after its id */
const entry = (id: string, s: Partial<LeagueStats>, me = false): LeagueEntry => ({
  id,
  username: id.toLowerCase(),
  displayName: id,
  avatar: null,
  level: 1,
  me,
  ...stats(s),
});

describe('league points and weeks', () => {
  it('gives +1 a game, +10 a win, +3 a liar caught and +2 a lie nobody caught', () => {
    expect(LEAGUE_POINTS).toEqual({ game: 1, win: 10, goodCall: 3, cleanBluff: 2 });
    expect(leaguePointsOf({ won: false, goodCalls: 0, cleanBluffs: 0 })).toBe(1);
    expect(leaguePointsOf({ won: true, goodCalls: 0, cleanBluffs: 0 })).toBe(11);
    expect(leaguePointsOf({ won: true, goodCalls: 2, cleanBluffs: 3 })).toBe(1 + 10 + 6 + 6);
    // nothing odd ever takes points away
    expect(leaguePointsOf({ won: false, goodCalls: -4, cleanBluffs: Number.NaN })).toBe(1);
  });

  it('finds last week from any time this week, IST Monday to Sunday', () => {
    expect([istWeek(THU), lastIstWeek(THU)]).toEqual(['2026-11-16', '2026-11-09']);
    // Monday 00:00 IST is a new week; the second before it is still Sunday
    expect(lastIstWeek(new Date('2026-11-22T18:30:00Z'))).toBe('2026-11-16');
    expect(lastIstWeek(new Date('2026-11-22T18:29:59Z'))).toBe('2026-11-09');
    expect(lastIstWeek(new Date('2027-01-01T06:00:00Z'))).toBe('2026-12-21');
    expect(nextIstWeek(THU).toISOString()).toBe('2026-11-22T18:30:00.000Z');
  });

  it("reads a week from this week's counters or the kept last week's", () => {
    const league: LeagueDoc = { week: '2026-11-16', ...stats({ points: 7, games: 1 }), prev: { week: '2026-11-09', ...stats({ points: 19, games: 2, wins: 1 }) } };
    expect(weekOf(league, '2026-11-16')).toEqual(stats({ points: 7, games: 1 }));
    expect(weekOf(league, '2026-11-09')).toEqual(stats({ points: 19, games: 2, wins: 1 }));
    expect(weekOf(league, '2026-11-02')).toBeNull();
    expect(weekOf({ ...league, prev: null }, '2026-11-09')).toBeNull();
    expect(weekOf(undefined, '2026-11-16')).toBeNull();
  });
});

describe('league board order, places and crowns', () => {
  it('sorts by points, wins, liars caught, then name; ties on points and wins share a place', () => {
    const board = boardOf('2026-11-16', [
      entry('Meera', { points: 12, wins: 1, games: 2 }, true),
      entry('Bina', { points: 32, wins: 2, goodCalls: 1, cleanBluffs: 3, games: 3 }),
      entry('Esha', { points: 12, wins: 1, games: 2 }),
      entry('Dev', { points: 32, wins: 1, goodCalls: 4, cleanBluffs: 3, games: 4 }),
      entry('Chetan', { points: 32, wins: 2, goodCalls: 3, games: 3 }),
      entry('Om', { points: 2, games: 2 }),
    ]);
    expect(board.week).toBe('2026-11-16');
    expect(board.rows.map((r) => `${r.place} ${r.id}`)).toEqual(['1 Chetan', '1 Bina', '3 Dev', '4 Esha', '4 Meera', '6 Om']);
    expect(board.rows.find((r) => r.me)?.id).toBe('Meera');
    expect(board.crowns).toEqual([
      { id: 'champion', userIds: ['Chetan', 'Bina', 'Dev'], value: 32 },
      { id: 'cid', userIds: ['Dev'], value: 4 },
      { id: 'jhootha', userIds: ['Bina', 'Dev'], value: 3 },
    ]);
  });

  it('leaves out a crown nobody scored for, and places a lone player first', () => {
    expect(boardOf('2026-11-16', [entry('Meera', {}, true)])).toEqual({
      week: '2026-11-16',
      rows: [{ ...entry('Meera', {}, true), place: 1 }],
      crowns: [],
    });
    const board = boardOf('2026-11-16', [entry('Meera', { points: 1, games: 1 }, true), entry('Om', { points: 11, wins: 1, games: 1 })]);
    expect(board.rows.map((r) => [r.place, r.id])).toEqual([[1, 'Om'], [2, 'Meera']]);
    expect(board.crowns).toEqual([{ id: 'champion', userIds: ['Om'], value: 11 }]);
    expect(boardOf('2026-11-16', [])).toEqual({ week: '2026-11-16', rows: [], crowns: [] });
  });
});

describe.skipIf(!MONGO)('weekly friends league (MongoDB)', () => {
  let store: Store;
  let server: ReturnType<typeof createBluffServer>;
  let raw: MongoClient;
  let users: Collection<UserDoc>;
  let friends: Collection<FriendDoc>;

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
    friends = raw.db(DB).collection<FriendDoc>('friends');
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
  /** a new account; the display name decides ties on the board */
  async function account(displayName?: string) {
    const username = `lg_${++made}`;
    const res = await api().post('/api/auth/register').send({ username, password: 'secret-pass-1', displayName: displayName ?? username });
    expect(res.status).toBe(201);
    const user = res.body.user as PublicUser;
    return { id: user.id, oid: new ObjectId(user.id), token: res.body.token as string, username };
  }
  type Account = Awaited<ReturnType<typeof account>>;
  /** a friendship (or a request still waiting) straight into the database */
  const befriend = (a: Account, b: Account, status: FriendDoc['status'] = 'accepted') =>
    friends.insertOne({ _id: new ObjectId(), pair: [a.id, b.id].sort().join('_'), requester: a.oid, recipient: b.oid, status, createdAt: new Date() });
  const leagueOf = async (a: Account) => (await users.findOne({ _id: a.oid }))!.league;
  /** sets an account's league counters for one week, and the week kept before it */
  const setLeague = (a: Account, week: string, s: Partial<LeagueStats>, prev: LeagueDoc['prev'] = null) =>
    users.updateOne({ _id: a.oid }, { $set: { league: { week, ...stats(s), prev } } });
  /** one game's numbers for one account */
  const game = (a: Account, won = false, goodCalls = 0, cleanBluffs = 0) => ({ userId: a.oid, won, goodCalls, cleanBluffs });

  it('adds games to the week, starts a new one each IST Monday and keeps only last week as prev', async () => {
    const a = await account();
    expect(await leagueOf(a)).toBeUndefined();
    await store.league.count([game(a, true, 1, 2)], LAST_THU);
    await store.league.count([game(a)], LAST_THU);
    const lastWeek = stats({ points: 18 + 1, games: 2, wins: 1, goodCalls: 1, cleanBluffs: 2 });
    expect(await leagueOf(a)).toEqual({ week: '2026-11-09', ...lastWeek, prev: null });

    // a new week starts from its first game and keeps last week's for the final board
    await store.league.count([game(a, false, 2)], THU);
    const kept = { week: '2026-11-09', ...lastWeek };
    expect(await leagueOf(a)).toEqual({ week: '2026-11-16', points: 7, games: 1, wins: 0, goodCalls: 2, cleanBluffs: 0, prev: kept });
    await store.league.count([game(a, true, 0, 1)], THU);
    const thisWeek = stats({ points: 7 + 13, games: 2, wins: 1, goodCalls: 2, cleanBluffs: 1 });
    expect(await leagueOf(a)).toEqual({ week: '2026-11-16', ...thisWeek, prev: kept });

    // a game from an earlier week can't overwrite a later one (the clock went back)
    await store.league.count([game(a, true, 5, 5)], LAST_THU);
    expect(await leagueOf(a)).toEqual({ week: '2026-11-16', ...thisWeek, prev: kept });

    // the boards read this week from the counters and last week from prev
    const thu = await store.league.board(a.oid, THU);
    expect(thu.thisWeek).toMatchObject({ week: '2026-11-16', rows: [{ id: a.id, me: true, place: 1, ...thisWeek }] });
    expect(thu.lastWeek).toMatchObject({ week: '2026-11-09', rows: [{ id: a.id, me: true, place: 1, ...lastWeek }] });
    expect(thu.resetAt).toBe('2026-11-22T18:30:00.000Z');
    // next Monday, before any game: this week is empty and last week is the one just ended
    const mon = await store.league.board(a.oid, NEXT_MON);
    expect(mon.thisWeek).toEqual({ week: '2026-11-23', rows: [expect.objectContaining({ id: a.id, place: 1, ...stats() })], crowns: [] });
    expect(mon.lastWeek).toMatchObject({ week: '2026-11-16', rows: [{ id: a.id, ...thisWeek }] });
    expect(mon.resetAt).toBe('2026-11-29T18:30:00.000Z');
    // a week with no games in between: last week's board is gone, and so is prev once a game comes
    expect((await store.league.board(a.oid, LATER)).lastWeek).toBeNull();
    await store.league.count([game(a)], LATER);
    expect(await leagueOf(a)).toEqual({ week: '2026-11-30', points: 1, games: 1, wins: 0, goodCalls: 0, cleanBluffs: 0, prev: null });
  });

  it('counts games saved at the same time, and every player of a game', async () => {
    const [a, b] = [await account(), await account()];
    await Promise.all(Array.from({ length: 6 }, (_, i) => store.league.count([game(a, i === 0), game(b, false, 1)], THU)));
    expect(await leagueOf(a)).toEqual({ week: '2026-11-16', points: 6 + 10, games: 6, wins: 1, goodCalls: 0, cleanBluffs: 0, prev: null });
    expect(await leagueOf(b)).toEqual({ week: '2026-11-16', points: 6 * 4, games: 6, wins: 0, goodCalls: 6, cleanBluffs: 0, prev: null });
    // an empty game list writes nothing, and the league never moves coins
    await store.league.count([], THU);
    expect((await users.find({ _id: { $in: [a.oid, b.oid] } }).toArray()).map((u) => u.coins)).toEqual([1200, 1200]);
  });

  it('shows me and my accepted friends who played this week, leaves hidden and blocked friends off, and keeps last week', async () => {
    const meera = await account('Meera');
    const [bina, chetan, dev, esha, om] = [await account('Bina'), await account('Chetan'), await account('Dev'), await account('Esha'), await account('Om')];
    // a hidden friend, a request still waiting, a stranger, a friend who only played last week, a blocked friend
    const [farah, gopal, hari, ira, jai] = [await account('Farah'), await account('Gopal'), await account('Hari'), await account('Ira'), await account('Jai')];
    // friends either way round: I asked Bina, the others asked me
    await befriend(meera, bina);
    for (const f of [chetan, dev, esha, om, farah, ira, jai]) await befriend(f, meera);
    await befriend(meera, gopal, 'pending');
    await befriend(bina, hari);

    const week = '2026-11-16';
    const last = '2026-11-09';
    await setLeague(meera, week, { points: 12, games: 2, wins: 1 }, { week: '2026-11-02', ...stats({ points: 99, games: 9 }) });
    await setLeague(bina, week, { points: 32, games: 3, wins: 2, goodCalls: 1, cleanBluffs: 3 }, { week: last, ...stats({ points: 22, games: 2, wins: 2 }) });
    await setLeague(chetan, week, { points: 32, games: 3, wins: 2, goodCalls: 3 });
    await setLeague(dev, week, { points: 32, games: 4, wins: 1, goodCalls: 4, cleanBluffs: 3 });
    await setLeague(esha, week, { points: 12, games: 2, wins: 1 });
    await setLeague(farah, week, { points: 45, games: 5, wins: 4 }, { week: last, ...stats({ points: 50, games: 4, wins: 4 }) });
    await setLeague(gopal, week, { points: 40, games: 4, wins: 3 });
    await setLeague(hari, week, { points: 60, games: 5, wins: 5 });
    await setLeague(ira, last, { points: 11, games: 1, wins: 1 });
    await setLeague(jai, week, { points: 45, games: 5, wins: 4 });
    // Om is a friend with no games this week
    await users.updateOne({ _id: farah.oid }, { $set: { leagueHidden: true } });
    await users.updateOne({ _id: jai.oid }, { $set: { blocked: true } });

    const board = await store.league.board(meera.oid, THU);
    expect(board.hidden).toBe(false);
    expect(board.thisWeek.week).toBe(week);
    expect(board.thisWeek.rows.map((r) => `${r.place} ${r.displayName}${r.me ? ' (me)' : ''} ${r.points}`)).toEqual([
      '1 Chetan 32',
      '1 Bina 32',
      '3 Dev 32',
      '4 Esha 12',
      '4 Meera (me) 12',
    ]);
    const row = board.thisWeek.rows[1];
    expect(row).toEqual({ id: bina.id, username: bina.username, displayName: 'Bina', avatar: null, level: 1, place: 1, me: false, ...stats({ points: 32, games: 3, wins: 2, goodCalls: 1, cleanBluffs: 3 }) });
    expect(board.thisWeek.crowns).toEqual([
      { id: 'champion', userIds: [chetan.id, bina.id, dev.id], value: 32 },
      { id: 'cid', userIds: [dev.id], value: 4 },
      { id: 'jhootha', userIds: [bina.id, dev.id], value: 3 },
    ]);
    // last week: Bina from her kept week, Ira from her counters; my week from two weeks ago and hidden Farah aren't on it
    expect(board.lastWeek).toEqual({
      week: last,
      rows: [expect.objectContaining({ id: bina.id, place: 1, points: 22 }), expect.objectContaining({ id: ira.id, place: 2, points: 11, me: false })],
      crowns: [{ id: 'champion', userIds: [bina.id], value: 22 }],
    });

    // a hidden player still sees herself on her own board, with her friends
    const own = await store.league.board(farah.oid, THU);
    expect(own.hidden).toBe(true);
    expect(own.thisWeek.rows.map((r) => [r.place, r.displayName, r.me])).toEqual([[1, 'Farah', true], [2, 'Meera', false]]);
    expect(own.lastWeek?.rows.map((r) => r.displayName)).toEqual(['Farah']);
    // Bina's board has her own friends: Meera, and Hari who isn't my friend
    expect((await store.league.board(bina.oid, THU)).thisWeek.rows.map((r) => r.displayName)).toEqual(['Hari', 'Bina', 'Meera']);
  });

  it("always has me on this week's board, even before my first game, and no last week when nobody played", async () => {
    const [me, pal] = [await account('Zoya'), await account('Pal')];
    expect(await store.league.board(me.oid, THU)).toEqual({
      thisWeek: { week: '2026-11-16', rows: [{ id: me.id, username: me.username, displayName: 'Zoya', avatar: null, level: 1, place: 1, me: true, ...stats() }], crowns: [] },
      lastWeek: null,
      resetAt: '2026-11-22T18:30:00.000Z',
      hidden: false,
    });
    await befriend(pal, me);
    await store.league.count([game(pal, true)], THU);
    const board = await store.league.board(me.oid, THU);
    expect(board.thisWeek.rows.map((r) => [r.place, r.displayName, r.points])).toEqual([[1, 'Pal', 11], [2, 'Zoya', 0]]);
    expect(board.thisWeek.crowns).toEqual([{ id: 'champion', userIds: [pal.id], value: 11 }]);
    expect(board.lastWeek).toBeNull();
    // an unknown account
    await expect(store.league.board(new ObjectId(), THU)).rejects.toMatchObject({ status: 404 });
  });

  it('serves the board and the hide switch over HTTP, logged in only', async () => {
    expect((await api().get('/api/me/league')).status).toBe(401);
    expect((await api().post('/api/me/league/hide').send({ hidden: true })).status).toBe(401);
    const [a, b] = [await account('Anu'), await account('Babu')];
    await befriend(a, b);
    await store.league.count([game(a, true, 1), game(b, false, 0, 1)]);
    const res = await api().get('/api/me/league').set(bearer(a.token));
    expect(res.status).toBe(200);
    const body = res.body as LeagueResponse;
    expect([body.thisWeek.week, body.resetAt, body.hidden, body.lastWeek]).toEqual([istWeek(), nextIstWeek().toISOString(), false, null]);
    expect(body.thisWeek.rows.map((r) => [r.place, r.displayName, r.points, r.me])).toEqual([[1, 'Anu', 14, true], [2, 'Babu', 3, false]]);

    for (const bad of [{}, { hidden: 'yes' }, { hidden: 1 }, { hidden: null }]) {
      const r = await api().post('/api/me/league/hide').set(bearer(a.token)).send(bad);
      expect([r.status, r.body.error]).toEqual([400, 'Say whether to hide you']);
    }
    // hidden: off my friend's board, still on mine
    const hide = await api().post('/api/me/league/hide').set(bearer(a.token)).send({ hidden: true });
    expect(hide.status).toBe(200);
    expect((hide.body as LeagueResponse).hidden).toBe(true);
    expect((hide.body as LeagueResponse).thisWeek.rows.map((r) => r.displayName)).toEqual(['Anu', 'Babu']);
    const theirs = (await api().get('/api/me/league').set(bearer(b.token))).body as LeagueResponse;
    expect(theirs.thisWeek.rows.map((r) => [r.place, r.displayName])).toEqual([[1, 'Babu']]);
    expect(theirs.thisWeek.crowns.map((c) => c.id)).toEqual(['champion', 'jhootha']);
    // and back on
    const show = await api().post('/api/me/league/hide').set(bearer(a.token)).send({ hidden: false });
    expect([show.status, (show.body as LeagueResponse).hidden]).toEqual([200, false]);
    const again = (await api().get('/api/me/league').set(bearer(b.token))).body as LeagueResponse;
    expect(again.thisWeek.rows.map((r) => r.displayName)).toEqual(['Anu', 'Babu']);
  });

  const CONFIG: GameConfig = {
    game: 'bluff', decks: 1, bluffRule: 'one', stake: 0, peeks: 0, bets: false, teams: false,
    handSize: 7, maxPicks: 1, stack7: true, botLevel: 'expert', saza: false, secretLies: false, ranked: false,
  };
  const zero = { bluffs: 0, caught: 0, goodCalls: 0, wrongCalls: 0, pickedUp: 0, plays: 0, chances: 0 };
  type Seat = Partial<GameRecordPlayer> & { memberId: string };
  /** saves a game through the recorder, as the socket server does */
  async function play(seats: Seat[], opts: { seconds?: number; status?: GameRecord['status']; game?: GameKind } = {}) {
    await store.games.save({
      roomCode: 'LEAG',
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
      catches: [],
    });
  }
  const thisWeekOf = async (a: Account) => weekOf(await leagueOf(a), istWeek());

  it('counts saved games of 2+ logged-in people that count; never bots, guests, removed players, short or stopped games', async () => {
    const [ana, bo, cy, di] = [await account('Ana'), await account('Bo'), await account('Cy'), await account('Di')];
    // two people, a bot, a guest and a removed player
    await play([
      { memberId: 'ana', userId: ana.id, won: true, place: 1, stats: { ...zero, goodCalls: 2, bluffs: 3, caught: 1 } },
      { memberId: 'bo', userId: bo.id, loser: true, stats: { ...zero, goodCalls: 1, bluffs: 1, caught: 1 } },
      { memberId: 'bot', bot: true, stats: { ...zero, goodCalls: 4 } },
      { memberId: 'guest' },
      { memberId: 'cy', userId: cy.id, kicked: true, stats: { ...zero, goodCalls: 3 } },
    ]);
    expect(await thisWeekOf(ana)).toEqual(stats({ points: 1 + 10 + 6 + 4, games: 1, wins: 1, goodCalls: 2, cleanBluffs: 2 }));
    expect(await thisWeekOf(bo)).toEqual(stats({ points: 1 + 3, games: 1, goodCalls: 1 }));
    expect(await leagueOf(cy)).toBeUndefined();

    // one person with bots, with a guest, or with a removed player: not a league game
    await play([{ memberId: 'di', userId: di.id, won: true, place: 1 }, { memberId: 'bot', bot: true }]);
    await play([{ memberId: 'di', userId: di.id, won: true, place: 1 }, { memberId: 'guest' }]);
    await play([{ memberId: 'di', userId: di.id, won: true, place: 1 }, { memberId: 'cy', userId: cy.id, kicked: true }]);
    expect(await leagueOf(di)).toBeUndefined();
    expect(await leagueOf(cy)).toBeUndefined();

    // under a minute, or stopped before the end: nothing
    await play([{ memberId: 'ana', userId: ana.id, won: true, place: 1 }, { memberId: 'bo', userId: bo.id }], { seconds: 30 });
    await play([{ memberId: 'ana', userId: ana.id }, { memberId: 'bo', userId: bo.id }], { status: 'ended_early' });
    expect([(await thisWeekOf(ana))?.games, (await thisWeekOf(bo))?.games]).toEqual([1, 1]);

    // Crazy 7: the game and the win count; there are no calls or lies to count
    await play(
      [
        { memberId: 'bo', userId: bo.id, won: true, place: 1, stats: { ...zero, goodCalls: 2, bluffs: 2 } },
        { memberId: 'ana', userId: ana.id, stats: { ...zero, goodCalls: 1, bluffs: 1 } },
      ],
      { game: 'crazy7' },
    );
    expect(await thisWeekOf(bo)).toEqual(stats({ points: 4 + 11, games: 2, wins: 1, goodCalls: 1 }));
    expect(await thisWeekOf(ana)).toEqual(stats({ points: 21 + 1, games: 2, wins: 1, goodCalls: 2, cleanBluffs: 2 }));

    // friends see it on the board straight away
    await befriend(ana, bo);
    const board = await store.league.board(bo.oid);
    expect(board.thisWeek.rows.map((r) => [r.place, r.displayName, r.points, r.me])).toEqual([[1, 'Ana', 22, false], [2, 'Bo', 15, true]]);
    expect(board.thisWeek.crowns).toEqual([
      { id: 'champion', userIds: [ana.id], value: 22 },
      { id: 'cid', userIds: [ana.id], value: 2 },
      { id: 'jhootha', userIds: [ana.id], value: 2 },
    ]);
  });
});
