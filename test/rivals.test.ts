import { MongoClient, ObjectId, type Collection } from 'mongodb';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CatchDoc, GameDoc, UserDoc } from '../src/db/documents.js';
import { Game } from '../src/game.js';
import type { GameRecord } from '../src/models.js';
import { createBluffServer } from '../src/server.js';
import { rivalTag } from '../src/services/rivals.js';
import { createStore, type Store } from '../src/services/store.js';
import { statsOf } from '../src/services/users.js';
import {
  dostiOf,
  levelOf,
  RIVAL_MIN_GAMES,
  type Card,
  type GameConfig,
  type GameKind,
  type PublicUser,
  type Rank,
  type RivalRecord,
  type Suit,
} from '../src/types.js';

// run with TEST_MONGODB_URI=mongodb://127.0.0.1:27099 (a throwaway database is created and dropped)
const MONGO = process.env.TEST_MONGODB_URI;
const DB = `bluff_rivals_test_${Date.now()}`;

describe('rival tags', () => {
  it('waits for RIVAL_MIN_GAMES games where one of us finished ahead', () => {
    expect(RIVAL_MIN_GAMES).toBe(10);
    expect(rivalTag(0, 0)).toBeNull();
    expect(rivalTag(0, 9)).toBeNull();
    expect(rivalTag(4, 5)).toBeNull();
    expect(rivalTag(0, 10)).toBe('nemesis');
    expect(rivalTag(5, 5)).toBe('rival');
  });

  it('says nemesis from 60% behind, rival from 40% to under 60%, and nothing when I am ahead', () => {
    // exactly 60% and 40%, on 10 and on 15 decided games
    expect(rivalTag(4, 6)).toBe('nemesis');
    expect(rivalTag(6, 4)).toBe('rival');
    expect(rivalTag(6, 9)).toBe('nemesis');
    expect(rivalTag(9, 6)).toBe('rival');
    // just under each line
    expect(rivalTag(41, 59)).toBe('rival');
    expect(rivalTag(61, 39)).toBeNull();
    expect(rivalTag(7, 3)).toBeNull();
    expect(rivalTag(10, 5)).toBeNull();
    // far ahead gets no tag at all
    expect(rivalTag(100, 0)).toBeNull();
    expect(rivalTag(0, 100)).toBe('nemesis');
  });
});

const CONFIG: GameConfig = {
  game: 'bluff', decks: 1, bluffRule: 'all', stake: 0, peeks: 0, bets: false, teams: false,
  handSize: 7, maxPicks: 1, stack7: true, botLevel: 'expert', saza: false, secretLies: false, ranked: false,
};

let seq = 0;
const card = (rank: Rank, suit: Suit = 'S'): Card => ({ id: `${rank}${suit}${++seq}`, rank, suit });
const ids = (...cards: Card[]) => cards.map((c) => c.id);

/** a Bluff game with these hands, seats in key order; the first seat starts */
function deal(hands: Record<string, Card[]>, opts: { teams?: boolean; bots?: string[] } = {}): Game {
  const order = Object.keys(hands);
  const g = new Game(order, { ...CONFIG, teams: opts.teams ?? false }, undefined, opts.bots ?? []);
  for (const id of order) g.hands.set(id, hands[id]);
  g.turnId = order[0];
  return g;
}

describe.skipIf(!MONGO)('rivals and Dosti (MongoDB)', () => {
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
    server?.close();
    await raw?.db(DB).dropDatabase();
    await raw?.close();
    await store?.close();
  });

  const api = () => request(server.app);
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  let made = 0;
  async function account(displayName?: string) {
    const username = `riv_${++made}`;
    const res = await api().post('/api/auth/register').send({ username, password: 'secret-pass-1', displayName });
    expect(res.status).toBe(201);
    const user = res.body.user as PublicUser;
    return { id: user.id, oid: new ObjectId(user.id), token: res.body.token as string, username };
  }
  type Account = Awaited<ReturnType<typeof account>>;
  const people = (n: number) => Promise.all(Array.from({ length: n }, () => account()));
  /** a sends b a friend request; b accepts unless told not to */
  async function befriend(a: Account, b: Account, accept = true) {
    expect((await api().post('/api/friends/request').set(bearer(a.token)).send({ username: b.username })).body.result).toBe('sent');
    if (accept) expect((await api().post(`/api/friends/${a.id}/accept`).set(bearer(b.token))).status).toBe(204);
  }
  /** everyone friends with everyone */
  async function circle(...list: Account[]) {
    for (const [i, a] of list.entries()) for (const b of list.slice(i + 1)) await befriend(a, b);
  }

  /** who sits in each seat of a saved game: an account, a bot, or null for a guest */
  type Seat = Account | 'bot' | null;
  /** saves a played game the way Room.snapshot records it */
  async function save(g: Game, seats: Record<string, Seat>, status: GameRecord['status'] = 'finished') {
    const record: GameRecord = {
      roomCode: 'RIVL',
      config: { ...CONFIG, teams: g.teams !== null },
      status,
      startedAt: new Date(Date.now() - 120_000),
      endedAt: new Date(),
      players: g.order.map((id) => {
        const seat = seats[id];
        return {
          memberId: id,
          userId: seat && seat !== 'bot' ? seat.id : null,
          name: id,
          place: g.places.indexOf(id) + 1 || null,
          loser: status === 'finished' && g.losers().includes(id),
          won: status === 'finished' && g.winners().includes(id),
          kicked: g.kicked.has(id),
          bot: seat === 'bot',
          stats: { ...g.stats.get(id)! },
          secret: null,
        };
      }),
      awards: [],
      bets: [],
      catches: g.catchList(),
    };
    await store.games.save(record);
  }

  /** one seat of a game put straight into the collection */
  interface RawSeat {
    who: Account | null;
    won?: boolean;
    place?: number | null;
    kicked?: boolean;
    bot?: boolean;
  }
  /** n copies of a saved game with these seats, without going through a room (older games have no catches) */
  async function insertGames(n: number, seats: RawSeat[], opts: { status?: GameDoc['status']; game?: GameKind; catches?: CatchDoc[] } = {}) {
    const docs: GameDoc[] = Array.from({ length: n }, () => ({
      _id: new ObjectId(),
      roomCode: 'RAWG',
      config: { ...CONFIG, game: opts.game ?? 'bluff' },
      status: opts.status ?? 'finished',
      startedAt: new Date(Date.now() - 120_000),
      endedAt: new Date(),
      durationSec: 120,
      stake: 0,
      pot: 0,
      players: seats.map((s, i) => ({
        userId: s.who?.oid ?? null,
        name: s.who?.username ?? `seat${i}`,
        guest: !s.who && !s.bot,
        bot: s.bot ?? false,
        place: s.place ?? null,
        won: s.won ?? false,
        loser: !s.won,
        kicked: s.kicked ?? false,
        coinChange: 0,
        bonus: 0,
        stats: { bluffs: 0, caught: 0, goodCalls: 0, wrongCalls: 0, pickedUp: 0, plays: 0, chances: 0 },
      })),
      winnerName: null,
      loserName: null,
      awards: [],
      ...(opts.catches ? { catches: opts.catches } : {}),
    }));
    await games.insertMany(docs);
  }

  /** my record against a friend by username, from the service */
  const vs = (me: Account, them: Account) => store.rivals.withFriend(me.oid, them.username);
  /** games together, then ahead–behind, for each listed friend */
  const scoreOf = (r: RivalRecord | null) => (r ? `${r.games}: ${r.ahead}-${r.behind}` : null);
  const scores = async (me: Account, ...them: Account[]) => Promise.all(them.map(async (t) => scoreOf(await vs(me, t))));

  it('2 players: whoever goes out is ahead', async () => {
    const [a, b] = await people(2);
    await befriend(a, b);
    const q = card('Q');
    const g = deal({ a: [q], b: [card('K'), card('2')] });
    g.play('a', ids(q), 'Q');
    g.pass('b');
    expect(g.over).toBe(true);
    await save(g, { a, b });
    expect(await vs(a, b)).toMatchObject({ games: 1, ahead: 1, behind: 0, iCaught: 0, theyCaught: 0, tag: null });
    expect(await scores(b, a)).toEqual(['1: 0-1']);
  });

  it('3+ players: a win beats everyone, then the better place, and finishing beats being left with cards', async () => {
    const [a, b, c, d] = await people(4);
    await circle(a, b, c, d);
    const [q1, q2, q3] = [card('Q'), card('Q', 'H'), card('Q', 'D')];
    const g = deal({ a: [q1], b: [q2], c: [q3], d: [card('K'), card('3')] });
    g.play('a', ids(q1), 'Q');
    g.play('b', ids(q2));
    g.play('c', ids(q3));
    g.pass('d');
    expect([g.places, g.winners(), g.losers()]).toEqual([['a', 'b', 'c'], ['a'], ['d']]);
    await save(g, { a, b, c, d });
    expect(await scores(a, b, c, d)).toEqual(['1: 1-0', '1: 1-0', '1: 1-0']);
    expect(await scores(b, a, c, d)).toEqual(['1: 0-1', '1: 1-0', '1: 1-0']);
    expect(await scores(c, a, b, d)).toEqual(['1: 0-1', '1: 0-1', '1: 1-0']);
    expect(await scores(d, a, b, c)).toEqual(['1: 0-1', '1: 0-1', '1: 0-1']);
  });

  it('2v2: the winning team is ahead of both losers whatever their places; partners go by place', async () => {
    const [a, b, c, d] = await people(4);
    await circle(a, b, c, d);
    // a & c against b & d: b goes out before c, but a & c finish as a team first
    const [q1, q2, q3] = [card('Q'), card('Q', 'H'), card('Q', 'D')];
    const g = deal({ a: [q1], b: [q2], c: [q3], d: [card('K'), card('3')] }, { teams: true });
    g.play('a', ids(q1), 'Q');
    g.play('b', ids(q2));
    g.play('c', ids(q3));
    g.pass('d');
    expect([g.places, g.winners()]).toEqual([['a', 'b', 'c'], ['a', 'c']]);
    await save(g, { a, b, c, d });
    // c (3rd, won) is ahead of b (2nd, lost)
    expect(await scores(c, a, b, d)).toEqual(['1: 0-1', '1: 1-0', '1: 1-0']);
    expect(await scores(b, a, c, d)).toEqual(['1: 0-1', '1: 0-1', '1: 1-0']);
    expect(await scores(a, b, c, d)).toEqual(['1: 1-0', '1: 1-0', '1: 1-0']);
    expect(await scores(d, a, b, c)).toEqual(['1: 0-1', '1: 0-1', '1: 0-1']);
  });

  it('walk-outs: whoever walked out is behind the winner, and level with anyone else left without a place', async () => {
    const [a, b, c] = await people(3);
    await circle(a, b, c);
    // 2 players: walking out hands the win to the other
    const one = deal({ a: [card('K'), card('2')], b: [card('Q'), card('3')] });
    one.leave('a');
    expect([one.over, one.winners(), one.losers()]).toEqual([true, ['b'], ['a']]);
    await save(one, { a, b });
    expect(await scores(a, b)).toEqual(['1: 0-1']);

    // 3 players: a walks out, b goes out, c is left holding cards
    const q = card('Q');
    const two = deal({ a: [card('K'), card('2')], b: [q], c: [card('5'), card('3')] });
    two.leave('a');
    two.play('b', ids(q), 'Q');
    two.pass('c');
    expect([two.places, two.winners(), two.losers()]).toEqual([['b'], ['b'], ['a', 'c']]);
    await save(two, { a, b, c });
    expect(await scores(a, b, c)).toEqual(['2: 0-2', '1: 0-0']);
    expect(await scores(b, a, c)).toEqual(['2: 2-0', '1: 1-0']);
    expect(await scores(c, a, b)).toEqual(['1: 0-0', '1: 0-1']);
  });

  it('End game: 1st place is ahead of all, 2nd ahead of those still holding cards, who are level', async () => {
    const [a, b, c, d] = await people(4);
    await circle(a, b, c, d);
    const [q1, q2] = [card('Q'), card('Q', 'H')];
    const g = deal({ a: [q1], b: [q2], c: [card('5', 'H'), card('6', 'H')], d: [card('5'), card('6')] });
    g.play('a', ids(q1), 'Q');
    g.play('b', ids(q2));
    g.pass('c');
    g.pass('d');
    // the host ends it with c and d still holding cards
    g.endEarly();
    expect([g.places, g.winners(), g.losers()]).toEqual([['a', 'b'], ['a'], ['c', 'd']]);
    await save(g, { a, b, c, d });
    expect(await scores(a, b, c, d)).toEqual(['1: 1-0', '1: 1-0', '1: 1-0']);
    expect(await scores(b, c, d)).toEqual(['1: 1-0', '1: 1-0']);
    expect(await scores(c, d)).toEqual(['1: 0-0']);
  });

  it('counts who caught whom from the calls in new games, and older games without catches add none', async () => {
    const [a, b] = await people(2);
    await befriend(a, b);
    const [q1, q2, five, three, four, q3] = [card('Q'), card('Q', 'H'), card('5'), card('3'), card('4'), card('Q', 'D')];
    const g = deal({ a: [q1, q2, five], b: [three, four, q3] });
    // a fakes a Q and b catches it
    g.play('a', ids(five), 'Q');
    g.callBluff('b', g.lastPlay!.id);
    // b fakes a K and a catches it
    g.play('b', ids(three), 'K');
    g.callBluff('a', g.lastPlay!.id);
    // a plays a real Q, b fakes one and a catches that too
    g.play('a', ids(q1), 'Q');
    g.play('b', ids(four));
    g.callBluff('a', g.lastPlay!.id);
    // a plays out honestly
    g.play('a', ids(q2), 'Q');
    g.pass('b');
    g.play('a', ids(five), '5');
    g.pass('b');
    expect([g.over, g.winners()]).toEqual([true, ['a']]);
    expect(g.catchList()).toEqual(expect.arrayContaining([{ by: 'b', of: 'a', n: 1 }, { by: 'a', of: 'b', n: 2 }]));
    await save(g, { a, b });
    expect(await vs(a, b)).toMatchObject({ games: 1, ahead: 1, behind: 0, iCaught: 2, theyCaught: 1 });
    expect(await vs(b, a)).toMatchObject({ games: 1, ahead: 0, behind: 1, iCaught: 1, theyCaught: 2 });

    // a game saved before catches came in: one more game, no more catches
    await insertGames(1, [{ who: a }, { who: b, won: true, place: 1 }]);
    expect(await vs(a, b)).toMatchObject({ games: 2, ahead: 1, behind: 1, iCaught: 2, theyCaught: 1 });
    // catches with someone else in the same game stay with that pair
    const c = await account();
    await befriend(a, c);
    await insertGames(1, [{ who: a, won: true, place: 1 }, { who: b }, { who: c }], {
      catches: [
        { by: a.oid, of: c.oid, n: 3 },
        { by: c.oid, of: b.oid, n: 1 },
        { by: b.oid, of: a.oid, n: 2 },
      ],
    });
    expect(await vs(a, b)).toMatchObject({ games: 3, ahead: 2, behind: 1, iCaught: 2, theyCaught: 3 });
    expect(await vs(a, c)).toMatchObject({ games: 1, ahead: 1, behind: 0, iCaught: 3, theyCaught: 0 });
  });

  it('lists only accepted friends; a friend added later brings our old games with them', async () => {
    const [a, b, c, d] = await people(4);
    await befriend(a, b);
    // c hasn't accepted yet; d is no friend at all
    await befriend(a, c, false);
    await insertGames(2, [{ who: a, won: true, place: 1 }, { who: b }, { who: c }, { who: d }]);
    expect((await store.rivals.list(a.oid)).records.map((r) => r.username)).toEqual([b.username]);
    expect(await vs(a, c)).toBeNull();
    expect(await vs(a, d)).toBeNull();
    expect(await store.rivals.withFriend(a.oid, 'riv_nobody')).toBeNull();
    // not my own rival
    expect(await vs(a, a)).toBeNull();
    // b and d aren't friends either
    expect(await vs(b, d)).toBeNull();
    expect((await store.rivals.list(d.oid)).records).toEqual([]);

    expect((await api().post(`/api/friends/${a.id}/accept`).set(bearer(c.token))).status).toBe(204);
    expect(await scores(a, b, c)).toEqual(['2: 2-0', '2: 2-0']);
    expect(await scores(c, a)).toEqual(['2: 0-2']);

    // unfriended: gone again
    expect((await api().post(`/api/friends/${b.id}/remove`).set(bearer(a.token))).status).toBe(204);
    expect(await vs(a, b)).toBeNull();
    expect((await store.rivals.list(a.oid)).records.map((r) => r.username)).toEqual([c.username]);
  });

  it('never counts bots or guests, games either of us was removed from, or stopped games', async () => {
    const [a, b, c] = await people(3);
    await circle(a, b, c);
    // a bot wins and a guest comes 3rd: between a and b, a finished and b didn't
    const [q1, q2, q3] = [card('Q'), card('Q', 'H'), card('Q', 'D')];
    const g = deal({ bot: [q1], a: [q2], guest: [q3], b: [card('K'), card('3')] }, { bots: ['bot'] });
    g.play('bot', ids(q1), 'Q');
    g.play('a', ids(q2));
    g.play('guest', ids(q3));
    g.pass('b');
    expect(g.places).toEqual(['bot', 'a', 'guest']);
    await save(g, { bot: 'bot', a, guest: null, b });
    expect(await scores(a, b)).toEqual(['1: 1-0']);
    expect((await store.rivals.list(a.oid)).records.map((r) => r.username)).toEqual([b.username]);

    // the host removes b, then a goes out ahead of c
    const q = card('Q');
    const kicked = deal({ a: [q], b: [card('K'), card('2')], c: [card('5'), card('3')] });
    kicked.removePlayer('b');
    kicked.play('a', ids(q), 'Q');
    kicked.pass('c');
    expect([kicked.over, kicked.winners()]).toEqual([true, ['a']]);
    await save(kicked, { a, b, c });
    expect(await scores(a, b, c)).toEqual(['1: 1-0', '1: 1-0']);
    expect(await scores(b, c)).toEqual([null]);

    // a removed: nothing for a, but b and c still count
    await insertGames(1, [{ who: a, kicked: true }, { who: b, won: true, place: 1 }, { who: c }]);
    expect(await scores(a, b, c)).toEqual(['1: 1-0', '1: 1-0']);
    expect(await scores(b, c)).toEqual(['1: 1-0']);

    // a stopped game moves nothing, saved or put straight in
    const stopped = deal({ a: [card('K'), card('2')], b: [card('Q'), card('3')] });
    await save(stopped, { a, b }, 'ended_early');
    await insertGames(1, [{ who: a, won: true, place: 1 }, { who: b }], { status: 'ended_early' });
    expect(await scores(a, b)).toEqual(['1: 1-0']);
  });

  it('the Dosti meter counts every finished game together, Crazy 7 and games with no one ahead included', async () => {
    const [a, b, c] = await people(3);
    await circle(a, b, c);
    await insertGames(2, [{ who: a, won: true, place: 1 }, { who: b }]);
    await insertGames(1, [{ who: b, won: true, place: 1 }, { who: a }]);
    // Crazy 7: c went out first, a and b both lost
    await insertGames(1, [{ who: c, won: true, place: 1 }, { who: a }, { who: b }], { game: 'crazy7' });
    expect(await vs(a, b)).toMatchObject({ games: 4, ahead: 2, behind: 1 });
    expect(dostiOf(4)?.name).toBe('Hi-Hello');
    await insertGames(1, [{ who: a }, { who: b }]);
    const r = await vs(a, b);
    expect(r).toMatchObject({ games: 5, ahead: 2, behind: 1 });
    expect(dostiOf(r!.games)?.name).toBe('Dost');
    // the same number from both sides
    expect((await vs(b, a))?.games).toBe(5);
    expect((await vs(c, a))?.games).toBe(1);
  });

  it('tags a rival or a nemesis only after enough games with one of us ahead, from each side', async () => {
    const [a, b, c, d] = await people(4);
    await circle(a, b, c, d);
    const aWins = (n: number) => insertGames(n, [{ who: a, won: true, place: 1 }, { who: b }]);
    const bWins = (n: number) => insertGames(n, [{ who: b, won: true, place: 1 }, { who: a }]);
    const tags = async () => [(await vs(a, b))?.tag, (await vs(b, a))?.tag];
    // 9 decided and some with nobody ahead: no tags yet
    await aWins(3);
    await bWins(6);
    await insertGames(4, [{ who: a }, { who: b }]);
    expect(await vs(a, b)).toMatchObject({ games: 13, ahead: 3, behind: 6, tag: null });
    expect(await tags()).toEqual([null, null]);
    // 10th: b ahead in 6 of 10 (60%: nemesis for a), a in 4 (40%: rival for b)
    await aWins(1);
    expect(await tags()).toEqual(['nemesis', 'rival']);
    // 5-6: close from both sides
    await aWins(1);
    expect(await tags()).toEqual(['rival', 'rival']);
    // 7-6 is still close; at 9-6 a is ahead in 60% (b's nemesis), and past that a gets no tag
    await aWins(2);
    expect(await tags()).toEqual(['rival', 'rival']);
    await aWins(2);
    expect(await vs(a, b)).toMatchObject({ ahead: 9, behind: 6 });
    expect(await tags()).toEqual(['rival', 'nemesis']);
    await aWins(1);
    expect(await tags()).toEqual([null, 'nemesis']);

    // only decided games count towards the 10, however many games there were
    await insertGames(9, [{ who: c }, { who: d, won: true, place: 1 }]);
    await insertGames(20, [{ who: c }, { who: d }]);
    expect(await vs(c, d)).toMatchObject({ games: 29, ahead: 0, behind: 9, tag: null });
  });

  it('lists most games together first, then by name, with each friend\'s public card', async () => {
    const me = await account('Mona');
    const [zed, amy, bob] = [await account('Zed'), await account('Amy'), await account('Bob')];
    const lone = await account('Lone');
    await circle(me, zed, amy, bob, lone);
    await insertGames(2, [{ who: me, won: true, place: 1 }, { who: zed }]);
    await insertGames(3, [{ who: me }, { who: amy, won: true, place: 1 }]);
    await insertGames(2, [{ who: me }, { who: bob }]);
    const { records } = await store.rivals.list(me.oid);
    // lone is a friend with no games together
    expect(records.map((r) => `${r.displayName} ${r.games}`)).toEqual(['Amy 3', 'Bob 2', 'Zed 2']);
    const doc = (await users.findOne({ _id: amy.oid }))!;
    expect(records[0]).toEqual({
      id: amy.id,
      username: amy.username,
      displayName: 'Amy',
      avatar: null,
      level: levelOf(statsOf(doc)),
      games: 3,
      ahead: 0,
      behind: 3,
      iCaught: 0,
      theyCaught: 0,
      tag: null,
    });
    // a blocked account is hidden, as on profiles
    await users.updateOne({ _id: bob.oid }, { $set: { blocked: true } });
    expect((await store.rivals.list(me.oid)).records.map((r) => r.displayName)).toEqual(['Amy', 'Zed']);
    expect(await vs(me, bob)).toBeNull();
    await users.updateOne({ _id: bob.oid }, { $unset: { blocked: '' } });
  });

  it('answers both routes for logged-in players only', async () => {
    const [a, b, c] = await people(3);
    await befriend(a, b);
    await befriend(a, c);
    await insertGames(1, [{ who: a, won: true, place: 1 }, { who: b }], { catches: [{ by: a.oid, of: b.oid, n: 2 }] });

    expect((await api().get('/api/me/rivals')).status).toBe(401);
    expect((await api().get(`/api/players/${b.username}/rival`)).status).toBe(401);

    const list = await api().get('/api/me/rivals').set(bearer(a.token));
    expect(list.status).toBe(200);
    expect(list.body.records).toHaveLength(1);
    const [rec] = list.body.records as RivalRecord[];
    expect(rec).toMatchObject({ id: b.id, username: b.username, games: 1, ahead: 1, behind: 0, iCaught: 2, theyCaught: 0, tag: null });
    // a friend's public card only: no coins, stats or login times
    expect(Object.keys(rec).sort()).toEqual(
      ['ahead', 'avatar', 'behind', 'displayName', 'games', 'iCaught', 'id', 'level', 'tag', 'theyCaught', 'username'].sort(),
    );
    expect((await api().get('/api/me/rivals').set(bearer(c.token))).body).toEqual({ records: [] });

    const one = await api().get(`/api/players/${b.username}/rival`).set(bearer(a.token));
    expect(one.status).toBe(200);
    expect(one.body.record).toEqual(rec);
    // from b's side, usernames in any case
    const back = await api().get(`/api/players/${a.username.toUpperCase()}/rival`).set(bearer(b.token));
    expect(back.body.record).toMatchObject({ id: a.id, ahead: 0, behind: 1, iCaught: 0, theyCaught: 2 });
    // a friend with no games together, someone who isn't a friend, nobody at all
    expect((await api().get(`/api/players/${c.username}/rival`).set(bearer(a.token))).body).toEqual({ record: null });
    expect((await api().get(`/api/players/${c.username}/rival`).set(bearer(b.token))).body).toEqual({ record: null });
    expect((await api().get('/api/players/riv_nobody/rival').set(bearer(a.token))).body).toEqual({ record: null });
    expect((await api().get('/api/players/no!/rival').set(bearer(a.token))).status).toBe(400);
  });
});
