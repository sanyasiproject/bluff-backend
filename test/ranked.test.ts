import { MongoClient, ObjectId, type Collection } from 'mongodb';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { istDay } from '../src/days.js';
import type { Collections, RankedDoc, UserDoc } from '../src/db/documents.js';
import type { GameRecord, GameRecordPlayer, MemberAccount } from '../src/models.js';
import { DEFAULT_RATING } from '../src/rating.js';
import { Room } from '../src/rooms.js';
import { createBluffServer } from '../src/server.js';
import { nextStanding, rankBadgeOf, ranksOf, rankViewOf } from '../src/services/ranked.js';
import { createStore, type Store } from '../src/services/store.js';
import {
  DEFAULT_CARD_BACK,
  DEFAULT_TABLE_THEME,
  RANK_DAILY_CAP,
  type AuditEntry,
  type CoinResult,
  type GameConfig,
  type GameKind,
  type PublicUser,
} from '../src/types.js';
import { parseConfig } from '../src/validate.js';

// run with TEST_MONGODB_URI=mongodb://127.0.0.1:27099 (a throwaway database is created and dropped)
const MONGO = process.env.TEST_MONGODB_URI;
const DB = `bluff_ranked_test_${Date.now()}`;
const ADMIN_KEY = 'test-admin-key-ranked';

// Thursday 19 Nov 2026, 09:30 IST, and the next day
const THU = new Date('2026-11-19T04:00:00Z');
const FRI = new Date('2026-11-20T04:00:00Z');
const DAY = istDay(THU);

/** a stored standing with these fields changed */
const standing = (over: Partial<RankedDoc> = {}): RankedDoc => ({ season: 1, ...DEFAULT_RATING, points: 0, floor: 0, games: 0, wins: 0, day: DAY, today: 0, ...over });
/** hidden skill going from 25 to 25 + gain */
const move = (gain: number) => [{ mu: 25, sigma: 6 }, { mu: 25 + gain, sigma: 5.9 }] as const;

describe('rank points from a rated game', () => {
  it('turns the finishing order into ranks: winners 1, then by place, everyone who did not finish tied last', () => {
    expect(ranksOf([{ won: true, place: 1 }, { won: false, place: 2 }, { won: false, place: null }])).toEqual([1, 3, 4]);
    // 2v2: both winners share rank 1, whatever their places
    expect(ranksOf([{ won: true, place: 1 }, { won: false, place: 2 }, { won: true, place: 3 }, { won: false, place: null }])).toEqual([1, 3, 1, 5]);
    // End game or walk-outs: the ones still holding cards tie
    expect(ranksOf([{ won: true, place: 1 }, { won: false, place: null }, { won: false, place: null }])).toEqual([1, 3, 3]);
  });

  it('starts a season at 0 and moves points by 40 x the change in skill', () => {
    const [before, after] = move(2.6354);
    const { doc, result } = nextStanding(null, 3, before, after, true, DAY);
    expect(result).toEqual({ before: 0, after: 105, division: 'bronze', held: null });
    expect(doc).toEqual({ season: 3, mu: after.mu, sigma: after.sigma, points: 105, floor: 0, games: 1, wins: 1, day: DAY, today: 105, debt: 0 });
    // a loss from 0 can't go below the Bronze floor; the hidden skill still drops
    const lost = nextStanding(null, 3, before, { mu: 22, sigma: 5.9 }, false, DAY);
    expect(lost.result).toEqual({ before: 0, after: 0, division: 'bronze', held: 'floor' });
    expect(lost.doc).toMatchObject({ mu: 22, points: 0, games: 1, wins: 0, today: 0 });
  });

  it(`keeps each IST day's change within ${RANK_DAILY_CAP} either way`, () => {
    const [b, a] = move(2);
    // +80 with 120 already won today: only 30 more
    let s = nextStanding(standing({ points: 400, floor: 300, today: 120 }), 1, b, a, true, DAY);
    expect(s.result).toEqual({ before: 400, after: 430, division: 'silver', held: 'cap' });
    expect(s.doc.today).toBe(150);
    // at the cap a win moves nothing, a loss still counts
    expect(nextStanding(s.doc, 1, b, a, true, DAY).result).toMatchObject({ after: 430, held: 'cap' });
    s = nextStanding(s.doc, 1, b, { mu: 22.5, sigma: 5.9 }, false, DAY);
    expect(s.result).toEqual({ before: 430, after: 330, division: 'silver', held: null });
    expect(s.doc.today).toBe(50);
    // losses are capped too
    s = nextStanding(standing({ points: 1000, floor: 700, today: -120 }), 1, b, { mu: 23, sigma: 5.9 }, false, DAY);
    expect(s.result).toMatchObject({ after: 970, held: 'cap' });
    expect(s.doc.today).toBe(-150);
    // a new day starts at 0
    const next = istDay(FRI);
    s = nextStanding(standing({ points: 430, floor: 300, today: 150 }), 1, b, a, true, next);
    expect(s.result).toMatchObject({ after: 510, held: null });
    expect(s.doc).toMatchObject({ day: next, today: 80 });
    // past the cap (it was lowered): a win never turns into a loss
    expect(nextStanding(standing({ points: 500, floor: 300, today: 160 }), 1, b, a, true, DAY).result).toMatchObject({ after: 500, held: 'cap' });
  });

  it('never drops below the start of the best division reached this season', () => {
    const [b] = move(0);
    let s = nextStanding(standing({ points: 720, floor: 700 }), 1, b, { mu: 23, sigma: 5.9 }, false, DAY);
    expect(s.result).toEqual({ before: 720, after: 700, division: 'gold', held: 'floor' });
    expect(s.doc).toMatchObject({ points: 700, floor: 700, today: -20, mu: 23 });
    // reaching Silver makes 300 the floor
    s = nextStanding(standing({ points: 290 }), 1, b, { mu: 25.5, sigma: 5.9 }, true, DAY);
    expect(s.doc).toMatchObject({ points: 310, floor: 300 });
    expect(s.result.division).toBe('silver');
    // the floor stays where it was after a drop within the division
    s = nextStanding(standing({ points: 1250, floor: 1200 }), 1, b, { mu: 24, sigma: 5.9 }, false, DAY);
    expect(s.doc).toMatchObject({ points: 1210, floor: 1200 });
  });

  it('pays back losses the floor held off before a win adds points, so taking turns to win lifts nobody', () => {
    const lost = nextStanding(standing(), 1, DEFAULT_RATING, { mu: 22.5, sigma: 5.9 }, false, DAY);
    expect(lost.result).toEqual({ before: 0, after: 0, division: 'bronze', held: 'floor' });
    expect(lost.doc.debt).toBe(100);
    // the next win of 100 only pays it back
    const won = nextStanding(lost.doc, 1, { mu: 22.5, sigma: 5.9 }, { mu: 25, sigma: 5.8 }, true, DAY);
    expect(won.result).toEqual({ before: 0, after: 0, division: 'bronze', held: 'debt' });
    expect(won.doc).toMatchObject({ debt: 0, today: 0 });
    // after that, wins count again
    const again = nextStanding(won.doc, 1, { mu: 25, sigma: 5.8 }, { mu: 26, sigma: 5.7 }, true, DAY);
    expect(again.result).toMatchObject({ after: 40, held: null });
    // a loss the daily cap held off is owed too
    const capped = nextStanding(standing({ points: 1000, floor: 700, today: -120 }), 1, DEFAULT_RATING, { mu: 23, sigma: 5.9 }, false, DAY);
    expect(capped.doc).toMatchObject({ points: 970, debt: 50 });
  });

  it('shows a standing only in its own season', () => {
    const doc = standing({ season: 2, points: 845, floor: 700, games: 9, wins: 4, today: -30 });
    expect(rankViewOf(doc, 2, THU)).toEqual({ season: 2, points: 845, division: 'gold', floor: 700, games: 9, wins: 4, today: -30 });
    // another day: nothing moved today yet
    expect(rankViewOf(doc, 2, FRI)?.today).toBe(0);
    expect(rankViewOf(doc, 3, THU)).toBe(null);
    expect(rankViewOf(undefined, 2, THU)).toBe(null);
    expect(rankBadgeOf(doc, 2)).toEqual({ division: 'gold', points: 845 });
    expect(rankBadgeOf(doc, 1)).toBe(null);
  });
});

const account = (name: string): MemberAccount => ({
  userId: `user-${name}`,
  username: name.toLowerCase(),
  coins: 1000,
  level: 1,
  stats: null,
  avatar: null,
  back: DEFAULT_CARD_BACK,
  table: DEFAULT_TABLE_THEME,
  habits: null,
});
const RANKED = parseConfig({ decks: 1, bluffRule: 'one', ranked: true });

/** a lobby with these players (the first hosts); names in guests join without an account */
function lobby(names: string[], guests: string[] = []) {
  const r = new Room('RANK');
  const people = names.map((n) => r.addMember(n, guests.includes(n) ? null : account(n)));
  return { r, host: people[0], people };
}

describe('ranked rooms', () => {
  it('takes no bots: turning it on with a bot seated is refused, and so is adding one while it is on', () => {
    const { r, host } = lobby(['Asha', 'Ravi']);
    const { bot } = r.addBot(host.id, 'Tara');
    expect(() => r.setConfig(host.id, RANKED)).toThrow('Ranked tables are for people only. Remove the bots first');
    expect(r.config.ranked).toBe(false);
    r.kick(host.id, bot.id);
    r.setConfig(host.id, RANKED);
    expect(r.config.ranked).toBe(true);
    expect(() => r.addBot(host.id, 'Tara')).toThrow("Bots can't play ranked games");
    expect(r.players().some((m) => m.bot)).toBe(false);
    // older apps don't send it: off
    expect(parseConfig({ decks: 1, bluffRule: 'one' }).ranked).toBe(false);
  });

  it('makes everyone say they are ready again when Ranked is turned on or off', () => {
    const { r, host, people } = lobby(['Asha', 'Ravi']);
    const ravi = people[1];
    ravi.hasReady = true;
    r.setReady(ravi.id, true);
    expect(r.setConfig(host.id, RANKED).readyAgain).toBe(true);
    expect(ravi.ready).toBe(false);
    r.setReady(ravi.id, true);
    expect(r.setConfig(host.id, { ...RANKED, ranked: false }).readyAgain).toBe(true);
    expect(ravi.ready).toBe(false);
  });

  it('is ignored in Crazy 7 like the other Bluff extras, and kept for switching back', () => {
    const { r, host } = lobby(['Asha', 'Ravi', 'Mira'], ['Mira']);
    const c7: GameConfig = { ...RANKED, game: 'crazy7' };
    r.setConfig(host.id, c7);
    r.addBot(host.id, 'Tara');
    expect(r.config.ranked).toBe(true);
    // a guest can play Crazy 7 even with ranked kept on
    expect(() => r.assertCanStart(host.id)).not.toThrow();
    // back to Bluff with the bot still seated: not as a ranked table
    expect(() => r.setConfig(host.id, RANKED)).toThrow('Ranked tables are for people only. Remove the bots first');
    expect(r.config.game).toBe('crazy7');
    r.setConfig(host.id, { ...RANKED, ranked: false });
    expect(r.config).toMatchObject({ game: 'bluff', ranked: false });
  });

  it('starts only when everyone seated is logged in, naming the guests; watchers and teams are fine', () => {
    const { r, host, people } = lobby(['Asha', 'Ravi', 'Meena', 'Kiran'], ['Ravi', 'Meena']);
    r.setConfig(host.id, RANKED);
    expect(() => r.assertCanStart(host.id)).toThrow('Ranked games need everyone logged in: Ravi, Meena');
    expect(() => r.start(host.id)).toThrow('Ranked games need everyone logged in: Ravi, Meena');
    // the same table can play unranked
    r.setConfig(host.id, { ...RANKED, ranked: false });
    expect(() => r.assertCanStart(host.id)).not.toThrow();
    r.setConfig(host.id, RANKED);
    // guests who watch don't hold it up
    r.setWatching(host.id, people[1].id, true);
    r.setWatching(host.id, people[2].id, true);
    r.start(host.id);
    expect(r.game?.order).toEqual([people[0].id, people[3].id]);

    const teams = lobby(['Asha', 'Ravi', 'Meena', 'Kiran']);
    teams.r.setConfig(teams.host.id, { ...RANKED, teams: true });
    teams.r.start(teams.host.id);
    expect(teams.r.game?.teams).toHaveLength(2);
  });
});

describe.skipIf(!MONGO)('ranked (MongoDB)', () => {
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
    server = createBluffServer({ store, adminApiKey: ADMIN_KEY, authAttempts: 1000 });
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
  async function account(username = `rk_${++made}`) {
    const res = await api().post('/api/auth/register').send({ username, password: 'secret-pass-1' });
    expect(res.status).toBe(201);
    const user = res.body.user as PublicUser;
    expect(user.rank).toBe(null);
    return { id: user.id, oid: new ObjectId(user.id), token: res.body.token as string, username };
  }
  type Account = Awaited<ReturnType<typeof account>>;
  const rankDoc = async (a: Account) => (await users.findOne({ _id: a.oid }))!.ranked;
  const myRank = async (a: Account) => ((await api().get('/api/me').set(bearer(a.token))).body.user as PublicUser).rank;
  const cardRank = async (viewer: Account, of: Account) => (await api().get(`/api/players/${of.username}`).set(bearer(viewer.token))).body.profile.rank;
  /** a standing for the season now on */
  const setRank = (a: Account, over: Partial<RankedDoc>) =>
    users.updateOne({ _id: a.oid }, { $set: { ranked: standing({ season: store.settings.rankedSeason, day: istDay(), ...over }) } });

  const CONFIG: GameConfig = { ...RANKED, botLevel: 'expert' };
  const zero = { bluffs: 0, caught: 0, goodCalls: 0, wrongCalls: 0, pickedUp: 0, plays: 0, chances: 0 };
  type Seat = Partial<GameRecordPlayer> & { memberId: string };
  /** a saved game's results by member id */
  async function play(seats: Seat[], opts: { seconds?: number; status?: GameRecord['status']; game?: GameKind; ranked?: boolean; teams?: boolean } = {}) {
    const record: GameRecord = {
      roomCode: 'RANK',
      config: { ...CONFIG, game: opts.game ?? 'bluff', ranked: opts.ranked ?? true, teams: opts.teams ?? false },
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
    };
    return new Map((await store.games.save(record)).map((r) => [r.playerId, r] as [string, CoinResult]));
  }
  /** a two-player game: a wins, b loses */
  const duel = (a: Account, b: Account) =>
    play([
      { memberId: 'a', userId: a.id, won: true, place: 1 },
      { memberId: 'b', userId: b.id, loser: true },
    ]);

  it('rates a finished ranked game and shows the new rank in the results, PublicUser and player cards', async () => {
    const [ana, bo, cy] = [await account(), await account(), await account()];
    const res = await duel(ana, bo);
    expect(res.get('a')!.rank).toEqual({ before: 0, after: 105, division: 'bronze', held: null });
    // a loss from 0 is held by the Bronze floor
    expect(res.get('b')!.rank).toEqual({ before: 0, after: 0, division: 'bronze', held: 'floor' });
    const doc = (await rankDoc(ana))!;
    expect(doc).toMatchObject({ season: 1, points: 105, floor: 0, games: 1, wins: 1, day: istDay(), today: 105 });
    expect(doc.mu).toBeGreaterThan(27.6);
    expect(doc.sigma).toBeLessThan(DEFAULT_RATING.sigma);
    expect(await rankDoc(bo)).toMatchObject({ points: 0, games: 1, wins: 0, today: 0 });
    expect(doc.mu + (await rankDoc(bo))!.mu).toBeCloseTo(50, 9);

    expect(await myRank(ana)).toEqual({ season: 1, points: 105, division: 'bronze', floor: 0, games: 1, wins: 1, today: 105 });
    expect(await cardRank(cy, ana)).toEqual({ division: 'bronze', points: 105 });
    expect(await cardRank(ana, bo)).toEqual({ division: 'bronze', points: 0 });
    // never played ranked: none
    expect(await myRank(cy)).toBe(null);
    expect(await cardRank(ana, cy)).toBe(null);
  });

  it('orders players by where they finished; kicked players and guests are not rated', async () => {
    const [cy, di, ed, fa] = [await account(), await account(), await account(), await account()];
    const res = await play([
      { memberId: 'cy', userId: cy.id, won: true, place: 1 },
      { memberId: 'di', userId: di.id, place: 2 },
      { memberId: 'ed', userId: ed.id, loser: true },
      { memberId: 'fa', userId: fa.id, kicked: true },
      { memberId: 'guest' },
    ]);
    const [c, d, e] = ['cy', 'di', 'ed'].map((m) => res.get(m)!.rank!);
    expect(c.after).toBeGreaterThan(d.after);
    expect(d.after).toBeGreaterThan(0);
    expect(e).toMatchObject({ after: 0, held: 'floor' });
    expect(res.get('fa')!.rank).toBe(null);
    expect(res.get('guest')!.rank).toBe(null);
    expect(await rankDoc(fa)).toBeUndefined();
  });

  it('rates 2v2 as the winning pair against the losing pair', async () => {
    const [ga, gb, gc, gd] = [await account(), await account(), await account(), await account()];
    for (const a of [ga, gb, gc, gd]) await setRank(a, { points: 500, floor: 300 });
    const res = await play(
      [
        { memberId: 'ga', userId: ga.id, won: true },
        { memberId: 'gc', userId: gc.id, loser: true },
        { memberId: 'gb', userId: gb.id, won: true, place: 1 },
        { memberId: 'gd', userId: gd.id },
      ],
      { teams: true },
    );
    const [a, b, c, d] = ['ga', 'gb', 'gc', 'gd'].map((m) => res.get(m)!.rank!);
    // partners move together, whoever went out first
    expect(a.after).toBeGreaterThan(500);
    expect(b.after).toBe(a.after);
    expect(c.after).toBeLessThan(500);
    expect(d.after).toBe(c.after);
  });

  it('rates only finished ranked Bluff games of a minute or more with 2+ people', async () => {
    const [gi, ha] = [await account(), await account()];
    const pair: Seat[] = [
      { memberId: 'gi', userId: gi.id, won: true, place: 1 },
      { memberId: 'ha', userId: ha.id, loser: true },
    ];
    for (const res of [
      await play(pair, { ranked: false }),
      await play(pair, { seconds: 30 }),
      await play(pair, { status: 'ended_early' }),
      await play(pair, { game: 'crazy7' }),
      await play([{ memberId: 'gi', userId: gi.id, won: true, place: 1 }, { memberId: 'bot', bot: true, loser: true }]),
    ]) {
      expect(res.get('gi')!.rank).toBe(null);
    }
    expect(await rankDoc(gi)).toBeUndefined();
    expect(await rankDoc(ha)).toBeUndefined();
  });

  /** seats for store.ranked.rate: the first wins, the second doesn't finish */
  const seats = (winner: Account, loser: Account) => [
    { memberId: winner.username, userId: winner.oid, won: true, place: 1 },
    { memberId: loser.username, userId: loser.oid, won: false, place: null },
  ];

  it('caps each IST day either way, keeps moving the hidden skill, and starts again the next day', async () => {
    const [ia, jo] = [await account(), await account()];
    await setRank(jo, { points: 1000, floor: 700, day: istDay(THU) });
    let res = await store.ranked.rate(seats(ia, jo), THU);
    expect(res.get(ia.username)).toEqual({ before: 0, after: 105, division: 'bronze', held: null });
    expect(res.get(jo.username)).toEqual({ before: 1000, after: 895, division: 'gold', held: null });
    res = await store.ranked.rate(seats(ia, jo), THU);
    expect(res.get(ia.username)).toMatchObject({ after: RANK_DAILY_CAP, held: 'cap' });
    expect(res.get(jo.username)).toMatchObject({ after: 1000 - RANK_DAILY_CAP, held: 'cap' });
    const mu = (await rankDoc(ia))!.mu;
    res = await store.ranked.rate(seats(ia, jo), THU);
    expect(res.get(ia.username)).toMatchObject({ before: 150, after: 150, held: 'cap' });
    expect(res.get(jo.username)).toMatchObject({ before: 850, after: 850, held: 'cap' });
    expect((await rankDoc(ia))!.mu).toBeGreaterThan(mu);
    expect(rankViewOf(await rankDoc(ia), store.settings.rankedSeason, THU)).toMatchObject({ points: 150, today: 150, games: 3, wins: 3 });
    expect(rankViewOf(await rankDoc(jo), store.settings.rankedSeason, THU)).toMatchObject({ points: 850, today: -150, games: 3, wins: 0 });
    // Friday: a fresh day
    res = await store.ranked.rate(seats(ia, jo), FRI);
    const fri = res.get(ia.username)!;
    expect(fri.held).toBe(null);
    expect(fri.after).toBeGreaterThan(150);
    expect(await rankDoc(ia)).toMatchObject({ day: istDay(FRI), today: fri.after - 150, games: 4 });
    expect(res.get(jo.username)!.after).toBeLessThan(850);
  });

  it('holds a player at the start of the best division reached this season', async () => {
    const [ka, lu] = [await account(), await account()];
    await setRank(ka, { points: 705, floor: 700, games: 12, wins: 6 });
    const res = await duel(lu, ka);
    expect(res.get('b')!.rank).toEqual({ before: 705, after: 700, division: 'gold', held: 'floor' });
    expect(await rankDoc(ka)).toMatchObject({ points: 700, floor: 700, games: 13, wins: 6 });
    expect(await myRank(ka)).toMatchObject({ points: 700, division: 'gold', floor: 700, today: -5 });
  });

  /** runs fn the first time the ranked service writes a user, just before that write */
  async function beforeFirstWrite<T>(fn: () => Promise<unknown>, run: () => Promise<T>): Promise<T> {
    const col = (store.ranked as unknown as { cols: Collections }).cols.users as unknown as { updateOne: (...args: unknown[]) => Promise<unknown> };
    const original = col.updateOne;
    let done = false;
    col.updateOne = async (...args: unknown[]) => {
      if (!done) {
        done = true;
        await fn();
      }
      return original.apply(col, args);
    };
    try {
      return await run();
    } finally {
      col.updateOne = original;
    }
  }

  it('keeps every write when games land together, and builds on a standing that changed since it was read', async () => {
    const [ma, ne] = [await account(), await account()];
    await Promise.all([store.ranked.rate(seats(ma, ne)), store.ranked.rate(seats(ma, ne))]);
    expect(await rankDoc(ma)).toMatchObject({ games: 2, wins: 2 });
    expect(await rankDoc(ne)).toMatchObject({ games: 2, wins: 0 });
    // another game lands between the read and the write: the write loses, reads again and builds on it
    const res = await beforeFirstWrite(
      () => users.updateOne({ _id: ma.oid }, { $set: { 'ranked.games': 7, 'ranked.points': 500, 'ranked.floor': 300, 'ranked.today': 0 } }),
      () => store.ranked.rate(seats(ma, ne)),
    );
    expect(res.get(ma.username)).toMatchObject({ before: 500, held: null });
    expect(await rankDoc(ma)).toMatchObject({ games: 8, wins: 3 });
    expect((await rankDoc(ma))!.points).toBeGreaterThan(500);
  });

  it('lets an admin start a new season: everyone starts again, it is logged, and a new standing is never written over', async () => {
    const [boss, oli, pia] = [await account('rk_boss'), await account(), await account()];
    await duel(oli, pia);
    expect(await myRank(oli)).toMatchObject({ points: 105 });
    const season = store.settings.rankedSeason;
    // admins only
    expect((await api().post('/api/admin/ranked/season')).status).toBe(401);
    expect((await api().post('/api/admin/ranked/season').set(bearer(boss.token))).status).toBe(403);
    expect(store.settings.rankedSeason).toBe(season);
    await api().post('/api/admin/make-admin').set('X-Admin-Key', ADMIN_KEY).send({ username: boss.username });
    const started = await api().post('/api/admin/ranked/season').set(bearer(boss.token));
    expect(started.status).toBe(200);
    expect(started.body).toEqual({ season: season + 1 });
    expect(store.settings.rankedSeason).toBe(season + 1);
    expect((await api().get('/api/admin/settings').set(bearer(boss.token))).body.settings).toMatchObject({ rankedSeason: season + 1, updatedBy: boss.username });
    const history = (await api().get(`/api/admin/users/${boss.id}/history`).set(bearer(boss.token))).body.history as AuditEntry[];
    expect(history[0]).toMatchObject({ action: 'settings', by: boss.username, detail: `Ranked season ${season + 1} started` });

    // last season's standing no longer shows, and the next game starts from scratch
    expect(await myRank(oli)).toBe(null);
    expect(await cardRank(pia, oli)).toBe(null);
    const res = await duel(oli, pia);
    expect(res.get('a')!.rank).toEqual({ before: 0, after: 105, division: 'bronze', held: null });
    expect(await rankDoc(oli)).toMatchObject({ season: season + 1, games: 1, wins: 1, points: 105, today: 105 });
    expect(await myRank(oli)).toMatchObject({ season: season + 1, points: 105, games: 1 });

    // another season starts and Pia's first game of it lands between this game's read and write:
    // the game belongs to the season that ended, so it's rated there and the new standing is never written over
    const res2 = await beforeFirstWrite(async () => {
      await store.ranked.newSeason({ userId: boss.oid, via: 'admin' });
      await users.updateOne({ _id: pia.oid }, { $set: { ranked: standing({ season: season + 2, points: 40, games: 1, wins: 1, day: istDay(), today: 40 }) } });
    }, () => store.ranked.rate(seats(pia, oli)));
    expect(res2.get(pia.username)).toBeUndefined();
    expect(await rankDoc(pia)).toMatchObject({ season: season + 2, points: 40, games: 1, wins: 1 });
    expect(await rankDoc(oli)).toMatchObject({ season: season + 1, games: 2 });
    expect(await myRank(oli)).toBe(null);
    expect(await myRank(pia)).toMatchObject({ season: season + 2, games: 1 });
    // a stale admin screen can't start an extra season
    const stale = await api().post('/api/admin/ranked/season').set(bearer(boss.token)).send({ from: season + 1 });
    expect(stale.status).toBe(409);
    expect(store.settings.rankedSeason).toBe(season + 2);
    const settings = await raw.db(DB).collection('settings').findOne({ _id: 'app' as never });
    expect(settings).toMatchObject({ rankedSeason: season + 2, guestsAllowed: true });
  });
});
