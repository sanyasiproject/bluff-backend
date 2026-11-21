import { MongoClient, ObjectId, type Collection } from 'mongodb';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { istDay } from '../src/days.js';
import type { Collections, RankedDoc, UserDoc } from '../src/db/documents.js';
import type { GameRecord, GameRecordPlayer, MemberAccount } from '../src/models.js';
import { DEFAULT_RATING } from '../src/rating.js';
import { Room } from '../src/rooms.js';
import { createBluffServer } from '../src/server.js';
import { nextStanding, rankBadgeOf, ranksOf, rankViewOf, seasonsPlayed, seasonStartPoints, standingIn } from '../src/services/ranked.js';
import { createStore, type Store } from '../src/services/store.js';
import {
  DEFAULT_CARD_BACK,
  nextRankStep,
  rankName,
  rankTier,
  tierStarts,
  DEFAULT_TABLE_THEME,
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

  it('has no daily limit: every win and loss counts in full, and today just adds them up', () => {
    const [b, a] = move(2);
    // +80 in skill is +72 in Silver, even with 400 already won today
    let s = nextStanding(standing({ points: 400, floor: 300, today: 400 }), 1, b, a, true, DAY);
    expect(s.result).toEqual({ before: 400, after: 472, division: 'silver', held: null });
    expect(s.doc.today).toBe(472);
    // in Silver a loss weighs 30% of a full win: -100 in skill is -30 points
    s = nextStanding(s.doc, 1, b, { mu: 22.5, sigma: 5.9 }, false, DAY);
    expect(s.result).toEqual({ before: 472, after: 442, division: 'silver', held: null });
    expect(s.doc.today).toBe(442);
    // a big loss is taken in full: -400 in skill is -132 in Gold (868 is still Gold: Gold starts at 700)
    s = nextStanding(standing({ points: 1000, floor: 700, today: -300 }), 1, b, { mu: 15, sigma: 5.9 }, false, DAY);
    expect(s.result).toEqual({ before: 1000, after: 868, division: 'gold', held: null });
    expect(s.doc.today).toBe(-432);
    // a new day starts today at 0
    const next = istDay(FRI);
    s = nextStanding(standing({ points: 430, floor: 300, today: 150 }), 1, b, a, true, next);
    expect(s.doc).toMatchObject({ points: 502, day: next, today: 72 });
  });

  it('keeps the division shown until points are 50 below its start; points themselves always move', () => {
    const [b] = move(0);
    // Gold 720 loses 26 (-80 in skill at 33%): 694 is under Gold's 700 but within the 50-point protection
    let s = nextStanding(standing({ points: 720, floor: 700 }), 1, b, { mu: 23, sigma: 5.9 }, false, DAY);
    expect(s.result).toEqual({ before: 720, after: 694, division: 'gold', held: 'grace' });
    expect(s.doc).toMatchObject({ points: 694, floor: 700, today: -26, mu: 23 });
    // 650 is the last point of the protection; one more loss drops to Silver
    s = nextStanding(standing({ points: 690, floor: 700 }), 1, b, { mu: 22, sigma: 5.9 }, false, DAY);
    expect(s.result).toEqual({ before: 690, after: 650, division: 'gold', held: 'grace' });
    s = nextStanding(s.doc, 1, b, { mu: 22, sigma: 5.9 }, false, DAY);
    expect(s.result).toEqual({ before: 650, after: 610, division: 'silver', held: null });
    expect(s.doc).toMatchObject({ points: 610, floor: 300, today: -80 });
    // a win inside the protection climbs back with Gold's rates (80% of +80)
    s = nextStanding(standing({ points: 650, floor: 700 }), 1, b, { mu: 27, sigma: 5.9 }, true, DAY);
    expect(s.result).toEqual({ before: 650, after: 714, division: 'gold', held: null });
    // reaching Silver shows Silver
    s = nextStanding(standing({ points: 290 }), 1, b, { mu: 25.5, sigma: 5.9 }, true, DAY);
    expect(s.doc).toMatchObject({ points: 310, floor: 300 });
    expect(s.result.division).toBe('silver');
  });

  it('stops a loss at 0 with nothing owed, so the next win counts in full', () => {
    const lost = nextStanding(standing(), 1, DEFAULT_RATING, { mu: 22.5, sigma: 5.9 }, false, DAY);
    expect(lost.result).toEqual({ before: 0, after: 0, division: 'bronze', held: 'floor' });
    expect(lost.doc.debt).toBe(0);
    const won = nextStanding(lost.doc, 1, { mu: 22.5, sigma: 5.8 }, { mu: 25, sigma: 5.8 }, true, DAY);
    expect(won.result).toEqual({ before: 0, after: 100, division: 'bronze', held: null });
    // a loss that only partly fits above 0 takes what's there
    const part = nextStanding(standing({ points: 10 }), 1, DEFAULT_RATING, { mu: 22.5, sigma: 5.9 }, false, DAY);
    expect(part.result).toEqual({ before: 10, after: 0, division: 'bronze', held: 'floor' });
    // owed points from older games are dropped, never taken from a win
    const old = nextStanding(standing({ points: 200, debt: 80 }), 1, DEFAULT_RATING, { mu: 26, sigma: 5.9 }, true, DAY);
    expect(old.result).toMatchObject({ after: 240, held: null });
    expect(old.doc.debt).toBe(0);
  });

  it('weighs a loss 1:4 against a win in Bronze, rising step by step to 1:1.5 at the top, while wins shrink', () => {
    const win = { mu: 27.5, sigma: 5.9 };
    const loss = { mu: 22.5, sigma: 5.9 };
    // the same +100 / -100 in skill, from early in each division
    const moves = [100, 300, 700, 1200, 1800, 2500].map((points) => {
      const from = standing({ points, floor: points });
      return [nextStanding(from, 1, DEFAULT_RATING, win, true, DAY).result.after - points, nextStanding({ ...from, floor: 0 }, 1, DEFAULT_RATING, loss, false, DAY).result.after - points];
    });
    expect(moves).toEqual([
      [100, -25],
      [90, -30],
      [80, -33],
      [70, -35],
      [60, -35],
      [50, -33],
    ]);
  });

  it('a Rank Shield stops a loss that would cost points, and only then', () => {
    const [b] = move(0);
    const s = nextStanding(standing({ points: 500, floor: 300 }), 1, b, { mu: 23, sigma: 5.9 }, false, DAY, true);
    expect(s.shielded).toBe(true);
    expect(s.result).toEqual({ before: 500, after: 500, division: 'silver', held: 'shield' });
    // nothing is owed for it, the skill still drops
    expect(s.doc).toMatchObject({ points: 500, debt: 0, today: 0, mu: 23, games: 1 });
    // a win, or a loss at 0 points that costs nothing anyway, keeps the shield
    expect(nextStanding(standing({ points: 500, floor: 300 }), 1, b, { mu: 26, sigma: 5.9 }, true, DAY, true).shielded).toBe(false);
    const floor = nextStanding(standing({ points: 0 }), 1, b, { mu: 23, sigma: 5.9 }, false, DAY, true);
    expect([floor.shielded, floor.result.held]).toEqual([false, 'floor']);
  });

  it('starts everyone at Bronze 0 and carries a standing into later seasons 1.5 divisions lower', () => {
    const doc = standing({ season: 2, points: 845, floor: 700, games: 9, wins: 4, today: -30 });
    expect(rankViewOf(doc, 2, THU)).toMatchObject({ season: 2, points: 845, division: 'gold', floor: 700, games: 9, wins: 4, today: -30 });
    // another day: nothing moved today yet
    expect(rankViewOf(doc, 2, FRI).today).toBe(0);
    // never played: Bronze 0
    expect(rankViewOf(undefined, 2, THU)).toMatchObject({ season: 2, points: 0, division: 'bronze', floor: 0, games: 0, wins: 0, today: 0 });
    expect(rankBadgeOf(undefined, 2)).toEqual({ division: 'bronze', points: 0 });
    // the next season: Gold 845 (2.29 divisions up the scale) starts at 0.79, Bronze 237; games count again
    expect(rankViewOf(doc, 3, THU)).toMatchObject({ season: 3, points: 237, division: 'bronze', floor: 0, games: 0, wins: 0, today: 0 });
    expect(rankBadgeOf(doc, 3)).toEqual({ division: 'bronze', points: 237 });
    // two seasons on, it dropped twice
    expect(standingIn(doc, 4)).toMatchObject({ season: 4, points: 0, mu: doc.mu });
    // a standing from a later season (a game read before a new season) is none
    expect(rankBadgeOf(doc, 1)).toEqual({ division: 'bronze', points: 0 });
    expect(rankBadgeOf(doc, 2)).toEqual({ division: 'gold', points: 845 });
  });

  it('splits divisions into tiers climbing from 1, for display only', () => {
    expect(tierStarts('bronze')).toEqual([0, 100, 200]);
    expect(tierStarts('silver')).toEqual([300, 434, 567]);
    expect(tierStarts('gold')).toEqual([700, 825, 950, 1075]);
    expect(tierStarts('platinum')).toEqual([1200, 1350, 1500, 1650]);
    expect(tierStarts('diamond')).toEqual([1800, 1940, 2080, 2220, 2360]);
    expect(tierStarts('badshah')).toEqual([2500]);
    expect([0, 99, 100, 299].map((p) => rankName(p, 'bronze'))).toEqual(['Bronze 1', 'Bronze 1', 'Bronze 2', 'Bronze 3']);
    expect([700, 824, 825, 1199].map((p) => rankName(p, 'gold'))).toEqual(['Gold 1', 'Gold 1', 'Gold 2', 'Gold 4']);
    // inside Gold's protection, under 700: still Gold 1
    expect(rankName(680, 'gold')).toBe('Gold 1');
    expect(rankName(3000, 'badshah')).toBe('Bluff Badshah');
    expect(rankTier(3000, 'badshah')).toBe(null);
    // the next step: a tier in the same division, then the next division's first tier, then nothing
    expect(nextRankStep(760, 'gold')).toEqual({ name: 'Gold 2', emoji: '🥇', at: 825 });
    expect(nextRankStep(1100, 'gold')).toEqual({ name: 'Platinum 1', emoji: '💠', at: 1200 });
    expect(nextRankStep(2400, 'diamond')).toEqual({ name: 'Bluff Badshah', emoji: '👑', at: 2500 });
    expect(nextRankStep(2600, 'badshah')).toBe(null);
  });

  it('drops 1.5 divisions at a new season, never below 0', () => {
    expect([200, 750, 1500, 1900, 2600, 5000].map(seasonStartPoints)).toEqual([0, 180, 700, 1021, 1586, 3950]);
    // a carried Gold standing keeps Gold's floor
    expect(standingIn(standing({ season: 1, points: 2600, floor: 2500, games: 30 }), 2)).toMatchObject({ points: 1586, floor: 1200, games: 0 });
  });

  it('lists earlier seasons newest first, with one not yet moved into the season now on', () => {
    const saved = [{ season: 1, division: 'silver' as const, points: 420, games: 8, wins: 5 }];
    const u = { ranked: standing({ season: 2, points: 750, games: 6, wins: 4 }), rankHistory: saved };
    expect(seasonsPlayed(u, 3)).toEqual([{ season: 2, division: 'gold', points: 750, games: 6, wins: 4 }, ...saved]);
    // in its own season it isn't history yet; a season with no games isn't listed
    expect(seasonsPlayed(u, 2)).toEqual(saved);
    expect(seasonsPlayed({ ranked: standing({ season: 2, games: 0 }) }, 3)).toEqual([]);
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
  it("shows each person's division on their seat; guests and bots have none; says when the table is ranked", () => {
    const r = new Room('RANK');
    const asha = r.addMember('Asha', { ...account('Asha'), rank: { division: 'gold', points: 980 } });
    const ravi = r.addMember('Ravi', account('Ravi'));
    const guest = r.addMember('Guest');
    const players = r.view(asha.id).players;
    expect(players.find((p) => p.id === asha.id)!.rank).toEqual({ division: 'gold', points: 980 });
    // a logged-in player the server knows no rank for starts at Bronze 0
    expect(players.find((p) => p.id === ravi.id)!.rank).toEqual({ division: 'bronze', points: 0 });
    expect(players.find((p) => p.id === guest.id)!.rank).toBe(null);
    expect(r.isRanked).toBe(false);
    r.setConfig(asha.id, { ...r.config, ranked: true });
    expect(r.isRanked).toBe(true);
    // Crazy 7 keeps the switch but is never ranked
    r.setConfig(asha.id, { ...r.config, game: 'crazy7' });
    expect(r.isRanked).toBe(false);
  });

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
    // everyone starts at Bronze 0
    expect(user.rank).toMatchObject({ points: 0, division: 'bronze', games: 0 });
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

    expect(await myRank(ana)).toMatchObject({ season: 1, points: 105, division: 'bronze', floor: 0, games: 1, wins: 1, today: 105, history: [] });
    expect(await cardRank(cy, ana)).toEqual({ division: 'bronze', points: 105 });
    expect(await cardRank(ana, bo)).toEqual({ division: 'bronze', points: 0 });
    // never played ranked: Bronze 0
    expect(await myRank(cy)).toMatchObject({ points: 0, division: 'bronze', games: 0 });
    expect(await cardRank(ana, cy)).toEqual({ division: 'bronze', points: 0 });
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

  it('has no daily limit: a long night of wins keeps climbing, and losses keep counting', async () => {
    const [ia, jo] = [await account(), await account()];
    await setRank(jo, { points: 1000, floor: 700, day: istDay(THU) });
    let res = await store.ranked.rate(seats(ia, jo), THU);
    expect(res.get(ia.username)).toEqual({ before: 0, after: 105, division: 'bronze', held: null });
    const jo1 = res.get(jo.username)!;
    expect(jo1).toMatchObject({ before: 1000, division: 'gold', held: null });
    expect(jo1.after).toBeLessThan(1000);
    for (let i = 0; i < 4; i++) res = await store.ranked.rate(seats(ia, jo), THU);
    // well past the old 150 a day, nothing held
    const ia5 = res.get(ia.username)!;
    expect(ia5.held).toBe(null);
    expect(ia5.after).toBeGreaterThan(300);
    expect(res.get(jo.username)!.after).toBeLessThan(jo1.after);
    expect(rankViewOf(await rankDoc(ia), store.settings.rankedSeason, THU)).toMatchObject({ points: ia5.after, today: ia5.after, games: 5, wins: 5 });
    // Friday: today starts again at 0
    res = await store.ranked.rate(seats(ia, jo), FRI);
    expect(await rankDoc(ia)).toMatchObject({ day: istDay(FRI), today: res.get(ia.username)!.after - ia5.after, games: 6 });
  });

  it('keeps showing a division within 50 points of its start, then drops it', async () => {
    const [ka, lu] = [await account(), await account()];
    await setRank(ka, { points: 705, floor: 700, games: 12, wins: 6 });
    let res = await duel(lu, ka);
    // the points really drop under 700; Gold stays on show
    expect(res.get('b')!.rank).toEqual({ before: 705, after: 670, division: 'gold', held: 'grace' });
    expect(await rankDoc(ka)).toMatchObject({ points: 670, floor: 700, games: 13, wins: 6 });
    expect(await myRank(ka)).toMatchObject({ points: 670, division: 'gold', floor: 700, today: -35 });
    expect(await cardRank(lu, ka)).toEqual({ division: 'gold', points: 670 });
    // under 650: Silver
    res = await duel(lu, ka);
    expect(res.get('b')!.rank).toMatchObject({ before: 670, division: 'silver', held: null });
    expect(res.get('b')!.rank!.after).toBeLessThan(650);
    expect(await myRank(ka)).toMatchObject({ division: 'silver', floor: 300 });
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

  it('lets an admin book a new season 7 days out; it starts by itself and each player moves into it 1.5 divisions lower', async () => {
    const [boss, oli, pia, qi] = [await account('rk_boss'), await account(), await account(), await account()];
    const season = store.settings.rankedSeason;
    // admins only
    expect((await api().post('/api/admin/ranked/season')).status).toBe(401);
    expect((await api().post('/api/admin/ranked/season').set(bearer(boss.token))).status).toBe(403);
    await api().post('/api/admin/make-admin').set('X-Admin-Key', ADMIN_KEY).send({ username: boss.username });

    // booked, not started: the season now on carries on for 7 days
    const asked = Date.now();
    const booked = await api().post('/api/admin/ranked/season').set(bearer(boss.token)).send({ from: season });
    expect(booked.status).toBe(200);
    expect(booked.body.season).toBe(season);
    const at = new Date(booked.body.nextSeasonAt as string);
    expect(at.getTime() - asked).toBeGreaterThan(7 * 86_400_000 - 60_000);
    expect(at.getTime() - asked).toBeLessThan(7 * 86_400_000 + 60_000);
    expect(store.settings.rankedSeason).toBe(season);
    expect((await api().get('/api/admin/settings').set(bearer(boss.token))).body.settings).toMatchObject({ rankedSeason: season, nextSeasonAt: at.toISOString() });
    expect(await myRank(oli)).toMatchObject({ season, nextAt: at.toISOString() });
    const seasons = raw.db(DB).collection('ranked_seasons');
    expect(await seasons.findOne({ _id: (season + 1) as never })).toMatchObject({ startsAt: at, endsAt: null, scheduledBy: boss.oid });
    let history = (await api().get(`/api/admin/users/${boss.id}/history`).set(bearer(boss.token))).body.history as AuditEntry[];
    expect(history[0]).toMatchObject({ action: 'settings', by: boss.username, detail: `Ranked season ${season + 1} booked to start on ${at.toISOString().slice(0, 10)}` });
    // one booking at a time; a stale screen can't book one either
    expect((await api().post('/api/admin/ranked/season').set(bearer(boss.token))).status).toBe(409);
    expect((await api().post('/api/admin/ranked/season').set(bearer(boss.token)).send({ from: season - 1 })).status).toBe(409);

    // called off, then booked again
    expect((await api().post('/api/admin/ranked/season/cancel').set(bearer(boss.token))).status).toBe(204);
    expect(store.settings.nextSeasonAt).toBe(null);
    expect(await seasons.findOne({ _id: (season + 1) as never })).toBe(null);
    history = (await api().get(`/api/admin/users/${boss.id}/history`).set(bearer(boss.token))).body.history as AuditEntry[];
    expect(history[0]).toMatchObject({ detail: `Ranked season ${season + 1} called off` });
    expect((await api().post('/api/admin/ranked/season/cancel').set(bearer(boss.token))).status).toBe(409);
    const again = await api().post('/api/admin/ranked/season').set(bearer(boss.token));
    const start = new Date(again.body.nextSeasonAt as string);

    // standings in the season now on
    await duel(oli, pia);
    await setRank(pia, { points: 750, floor: 700, games: 6, wins: 4 });
    await setRank(qi, { points: 1900, floor: 1800, games: 20, wins: 12 });

    // nothing happens before its time; then it starts in one go
    expect(await store.ranked.startDueSeason(new Date(start.getTime() - 1000))).toBe(null);
    expect(await store.ranked.startDueSeason(start)).toBe(season + 1);
    expect(store.settings.rankedSeason).toBe(season + 1);
    expect(store.settings.nextSeasonAt).toBe(null);
    expect(await store.ranked.startDueSeason(new Date(start.getTime() + 1000))).toBe(null);
    expect(await seasons.findOne({ _id: season as never })).toMatchObject({ endsAt: start });
    expect(await seasons.findOne({ _id: (season + 1) as never })).toMatchObject({ startsAt: start, endsAt: null });

    // opening the app moves Pia into the new season: Gold 750 drops to Bronze 180, and last season goes into the history
    const piaRank = await myRank(pia);
    expect(piaRank).toMatchObject({ season: season + 1, points: 180, division: 'bronze', games: 0, wins: 0 });
    expect(piaRank!.history).toEqual([{ season, division: 'gold', points: 750, games: 6, wins: 4 }]);
    expect(await rankDoc(pia)).toMatchObject({ season: season + 1, points: 180, games: 0 });
    expect((await users.findOne({ _id: pia.oid }))!.rankHistory).toEqual([{ season, division: 'gold', points: 750, games: 6, wins: 4 }]);
    // opening it again changes nothing
    expect((await myRank(pia))!.history).toHaveLength(1);
    // Qi hasn't opened the app: their card already shows where the new season puts them, and last season
    expect(await cardRank(pia, qi)).toEqual({ division: 'gold', points: 1021 });
    const card = (await api().get(`/api/players/${qi.username}`).set(bearer(pia.token))).body.profile;
    expect(card.seasons).toEqual([{ season, division: 'diamond', points: 1900, games: 20, wins: 12 }]);
    // Qi's first game of the new season moves them in too, from 1021
    const res = await duel(qi, oli);
    expect(res.get('a')!.rank).toMatchObject({ before: 1021, division: 'gold' });
    expect(await rankDoc(qi)).toMatchObject({ season: season + 1, games: 1, wins: 1 });
    expect((await users.findOne({ _id: qi.oid }))!.rankHistory).toEqual([{ season, division: 'diamond', points: 1900, games: 20, wins: 12 }]);
    expect((await myRank(oli))!.history).toEqual([{ season, division: 'bronze', points: 105, games: 1, wins: 1 }]);

    // a game read before the next season starts belongs to the old one: it never writes over a standing of the new season
    await api().post('/api/admin/ranked/season').set(bearer(boss.token));
    const res2 = await beforeFirstWrite(async () => {
      await store.ranked.startDueSeason(new Date(Date.now() + 8 * 86_400_000));
      await users.updateOne({ _id: pia.oid }, { $set: { ranked: standing({ season: season + 2, points: 40, games: 1, wins: 1, day: istDay(), today: 40 }) } });
    }, () => store.ranked.rate(seats(pia, oli)));
    expect(res2.get(pia.username)).toBeUndefined();
    expect(await rankDoc(pia)).toMatchObject({ season: season + 2, points: 40, games: 1, wins: 1 });
    const settings = await raw.db(DB).collection('settings').findOne({ _id: 'app' as never });
    expect(settings).toMatchObject({ rankedSeason: season + 2, guestsAllowed: true, nextSeasonAt: null });
  });
});
