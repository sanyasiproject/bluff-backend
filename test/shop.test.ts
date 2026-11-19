import { MongoClient, ObjectId, type Collection } from 'mongodb';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { istDay, istWeek } from '../src/days.js';
import type { AuditDoc, UserDoc } from '../src/db/documents.js';
import type { GameRecord, GameRecordPlayer } from '../src/models.js';
import { Room } from '../src/rooms.js';
import { createBluffServer } from '../src/server.js';
import { boostOf, shopLookOf, shopWearOf } from '../src/services/shop.js';
import { createStore, type Store } from '../src/services/store.js';
import { DEFAULT_CARD_BACK, DEFAULT_TABLE_THEME, missionOf, shopItemOf, xpOf, type CoinResult, type GameConfig, type PublicUser, type ShopResponse } from '../src/types.js';

// run with TEST_MONGODB_URI=mongodb://127.0.0.1:27099 (a throwaway database is created and dropped)
const MONGO = process.env.TEST_MONGODB_URI;
const DB = `bluff_shop_test_${Date.now()}`;
const DAY = 24 * 60 * 60 * 1000;

describe('shop looks in a room', () => {
  it('shows a worn look on the seat until its rental runs out', () => {
    const now = Date.now();
    const r = new Room('SHOP');
    const m = r.addMember('Asha', {
      userId: 'u1', username: 'asha', coins: 0, level: 1, stats: null, avatar: null, back: DEFAULT_CARD_BACK, table: DEFAULT_TABLE_THEME, habits: null,
      shop: { aura: { id: 'aura-lightning', until: now + DAY }, win: { id: 'win-fireworks', until: now - 1 }, entry: null },
    });
    expect(r.view(m.id).players[0].shop).toEqual({ aura: 'aura-lightning', win: null, entry: null });
    // guests and older callers wear nothing
    const g = r.addMember('Guest');
    expect(r.view(g.id).players.find((p) => p.id === g.id)!.shop).toEqual({ aura: null, win: null, entry: null });
    expect(shopLookOf({ aura: { id: 'aura-gold', until: now + 5 }, win: null, entry: null }, now + 10).aura).toBeNull();
  });

  it('ignores worn ids whose rental ended or that left the catalogue', () => {
    const now = new Date();
    const shop = {
      rev: 1,
      rentals: [
        { id: 'aura-fire', until: new Date(now.getTime() - 1000) },
        { id: 'win-thunder', until: new Date(now.getTime() + DAY) },
        { id: 'aura-gone', until: new Date(now.getTime() + DAY) },
      ],
      wearing: { aura: 'aura-fire', win: 'win-thunder', entry: 'aura-gone' },
    };
    const wear = shopWearOf({ shop }, now);
    expect([wear.aura, wear.win?.id, wear.entry]).toEqual([null, 'win-thunder', null]);
    expect(boostOf({ shop }, 'xp', now)).toBe(1);
  });
});

describe.skipIf(!MONGO)('coin shop (MongoDB)', () => {
  let store: Store;
  let server: ReturnType<typeof createBluffServer>;
  let raw: MongoClient;
  let users: Collection<UserDoc>;
  let audit: Collection<AuditDoc>;

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
    audit = raw.db(DB).collection<AuditDoc>('audit_log');
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
  /** a new account with this many coins */
  async function account(coins = 20_000) {
    const res = await api().post('/api/auth/register').send({ username: `shop_${++made}`, password: 'secret-pass-1' });
    expect(res.status).toBe(201);
    const user = res.body.user as PublicUser;
    const oid = new ObjectId(user.id);
    await users.updateOne({ _id: oid }, { $set: { coins } });
    return { id: user.id, oid, token: res.body.token as string };
  }
  const doc = async (oid: ObjectId) => (await users.findOne({ _id: oid }))!;
  const buy = (token: string, id: string) => api().post('/api/me/shop/buy').set(bearer(token)).send({ id });

  it('rents an item: takes the coins, runs for its days, wears a look at once and writes the audit log', async () => {
    const a = await account(5_000);
    const before = Date.now();
    const res = await buy(a.token, 'aura-lightning');
    expect(res.status).toBe(200);
    const shop = res.body.shop as ShopResponse;
    expect(shop.coins).toBe(2_000);
    expect(shop.wearing).toEqual({ aura: 'aura-lightning', win: null, entry: null });
    const until = new Date(shop.active[0].until).getTime();
    expect(until - before).toBeGreaterThanOrEqual(7 * DAY - 50);
    expect(until - before).toBeLessThan(7 * DAY + 5_000);
    const log = await audit.findOne({ targetUserId: a.oid, action: 'shop' });
    expect([log?.amount, log?.balanceAfter]).toEqual([-3_000, 2_000]);
    // the public profile shows the aura
    const me = await doc(a.oid);
    const profile = await api().get(`/api/players/${me.username}`).set(bearer(a.token));
    expect(profile.body.aura ?? profile.body.profile?.aura).toBe('aura-lightning');
  });

  it('adds time when the same item is bought again, and refuses without enough coins', async () => {
    const a = await account(1_100);
    const first = (await buy(a.token, 'xp-d15')).body.shop as ShopResponse;
    const second = (await buy(a.token, 'xp-d15')).body.shop as ShopResponse;
    expect(new Date(second.active[0].until).getTime() - new Date(first.active[0].until).getTime()).toBe(DAY);
    expect(second.coins).toBe(100);
    const poor = await buy(a.token, 'xp-d15');
    expect(poor.status).toBe(400);
    expect((await doc(a.oid)).coins).toBe(100);
  });

  it('runs one XP boost and one coin boost at a time', async () => {
    const a = await account();
    expect((await buy(a.token, 'xp-d2')).status).toBe(200);
    const other = await buy(a.token, 'xp-w15');
    expect(other.status).toBe(400);
    expect(other.body.error ?? other.body.message).toMatch(/still running/);
    // a coin boost is its own slot
    expect((await buy(a.token, 'coins-w25')).status).toBe(200);
  });

  it('never rents further than 28 days ahead', async () => {
    const a = await account(100_000);
    for (let i = 0; i < 4; i++) expect((await buy(a.token, 'win-fireworks')).status).toBe(200);
    expect((await buy(a.token, 'win-fireworks')).status).toBe(400);
  });

  it('charges once when two buys race for the last coins', async () => {
    const a = await account(3_000);
    const [x, y] = await Promise.all([buy(a.token, 'aura-fire'), buy(a.token, 'aura-fire')]);
    expect([x.status, y.status].sort()).toEqual([200, 400]);
    const d = await doc(a.oid);
    expect(d.coins).toBe(0);
    expect(d.shop!.rentals).toHaveLength(1);
  });

  it('switches between running looks, takes one off, and refuses looks not rented', async () => {
    const a = await account();
    await buy(a.token, 'aura-aurora');
    await buy(a.token, 'aura-galaxy');
    const wear = (kind: string, id: string | null) => api().post('/api/me/shop/wear').set(bearer(a.token)).send({ kind, id });
    expect((await wear('aura', 'aura-aurora')).body.shop.wearing.aura).toBe('aura-aurora');
    expect((await wear('aura', null)).body.shop.wearing.aura).toBeNull();
    expect((await wear('aura', 'aura-gold')).status).toBe(400);
    expect((await wear('win', 'aura-aurora')).status).toBe(400);
    expect((await wear('hat', null)).status).toBe(400);
  });

  it('stops a rental when it runs out', async () => {
    const a = await account();
    await buy(a.token, 'entry-thunder');
    await users.updateOne({ _id: a.oid }, { $set: { 'shop.rentals.0.until': new Date(Date.now() - 1000) } });
    const shop = (await api().get('/api/me/shop').set(bearer(a.token))).body as ShopResponse;
    expect(shop.active).toEqual([]);
    expect(shop.wearing.entry).toBeNull();
  });

  const CONFIG: GameConfig = {
    game: 'bluff', decks: 1, bluffRule: 'one', stake: 0, peeks: 0, bets: false, teams: false,
    handSize: 7, maxPicks: 1, stack7: true, botLevel: 'expert', saza: false, secretLies: false,
  };
  const zero = { bluffs: 0, caught: 0, goodCalls: 0, wrongCalls: 0, pickedUp: 0, plays: 0, chances: 0 };
  async function play(seats: (Partial<GameRecordPlayer> & { memberId: string })[], seconds = 90) {
    const record: GameRecord = {
      roomCode: 'SHOP',
      config: CONFIG,
      status: 'finished',
      startedAt: new Date(Date.now() - seconds * 1000),
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
  /** a known mission set nobody finishes in one game, except a win */
  const pinMissions = (oid: ObjectId) =>
    users.updateOne({ _id: oid }, { $set: { missions: { rev: 1, day: istDay(), week: istWeek(), daily: ['d-win1', 'd-games3', 'd-friend1'].map((id) => ({ id, progress: 0, done: false })), weekly: ['w-games15', 'w-wins5', 'w-friend5'].map((id) => ({ id, progress: 0, done: false })) } } });

  it('multiplies a game\'s own XP with an XP boost, only in games that count', async () => {
    const a = await account();
    const b = await account();
    await buy(a.token, 'xp-d3');
    await pinMissions(a.oid);
    await pinMissions(b.oid);
    const stats = { goodCalls: 2, bluffs: 3, caught: 1 };
    const res = await play([
      { memberId: 'a', userId: a.id, won: true, place: 1, stats: { ...zero, ...stats } },
      { memberId: 'b', userId: b.id, loser: true, stats: { ...zero, ...stats } },
    ]);
    const gameXp = xpOf({ gamesPlayed: 1, wins: 1, losses: 0, bluffs: 3, bluffsCaught: 1, goodCalls: 2, wrongCalls: 0, cardsPickedUp: 0, plays: 0, chances: 0, crazy7Games: 0, bonusXp: 0 });
    // XP Diamond is 2x: one extra game's worth
    expect(res.get('a')!.boostXp).toBe(Math.round(gameXp * (shopItemOf('xp-d3')!.mult! - 1)));
    expect(shopItemOf('xp-d3')!.mult).toBe(2);
    expect(res.get('b')!.boostXp).toBe(0);
    // mission XP is paid as usual on top, not boosted
    const winXp = missionOf('d-win1')!.xp;
    expect((await doc(a.oid)).stats.bonusXp).toBe(gameXp + winXp);
    // a short game earns its plain XP and no boost
    const short = await play([{ memberId: 'a', userId: a.id }, { memberId: 'b', userId: b.id }], 20);
    expect(short.get('a')!.boostXp).toBe(0);
  });

  it('adds 25% to the daily ladder and mission coins with a coin boost', async () => {
    const a = await account();
    const b = await account();
    await buy(a.token, 'coins-w25');
    await pinMissions(a.oid);
    await pinMissions(b.oid);
    const before = (await doc(a.oid)).coins;
    const res = await play([
      { memberId: 'a', userId: a.id, won: true, place: 1 },
      { memberId: 'b', userId: b.id, loser: true },
    ]);
    const ra = res.get('a')!;
    // the first game of the day pays 100 on the ladder, and the win mission 200
    expect(ra.bonus).toBe(125);
    expect(ra.missionsDone).toEqual([{ id: 'd-win1', coins: 250, xp: missionOf('d-win1')!.xp }]);
    expect(ra.boostCoins).toBe(25 + 50);
    expect((await doc(a.oid)).coins - before).toBe(125 + 250);
    expect(res.get('b')!.boostCoins).toBe(0);
    expect(res.get('b')!.bonus).toBe(100);
  });

  it('sells Rank Shields as cards you hold, up to 5, and a ranked loss uses one up', async () => {
    const a = await account(5_000);
    const b = await account(5_000);
    for (let i = 1; i <= 5; i++) expect((await buy(a.token, 'shield')).body.shop.shields).toBe(i);
    const full = await buy(a.token, 'shield');
    expect(full.status).toBe(400);
    expect((await doc(a.oid)).coins).toBe(5_000 - 5 * 300);
    // a shield is not a rental
    expect((await doc(a.oid)).shop!.rentals).toEqual([]);
    const season = store.settings.rankedSeason;
    await users.updateOne({ _id: a.oid }, { $set: { ranked: { season, mu: 25, sigma: 6, points: 500, floor: 300, games: 4, wins: 2, day: istDay(), today: 0 } } });
    const res = await store.ranked.rate([
      { memberId: 'b', userId: b.oid, won: true, place: 1 },
      { memberId: 'a', userId: a.oid, won: false, place: null },
    ]);
    expect(res.get('a')).toMatchObject({ before: 500, after: 500, held: 'shield' });
    const after = await doc(a.oid);
    expect([after.shop!.shields, after.ranked!.points, after.ranked!.debt]).toEqual([4, 500, 0]);
    // the winner still gains
    expect(res.get('b')!.after).toBeGreaterThan(0);
  });

  it('lists every item with a price and a length', () => {
    for (const id of ['xp-d15', 'xp-d2', 'xp-d3', 'xp-w15', 'xp-w2', 'coins-w25']) expect(shopItemOf(id)!.mult).toBeGreaterThan(1);
  });
});
