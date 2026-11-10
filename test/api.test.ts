import type { AddressInfo } from 'node:net';
import { MongoClient } from 'mongodb';
import { io as connect, type Socket } from 'socket.io-client';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBluffServer } from '../src/server.js';
import type { GameRecord } from '../src/models.js';
import { createStore, type Store } from '../src/services/store.js';
import type { AuditEntry, FriendsResponse, GameSummary, InviteEvent, PlayerSearchResult, PublicUser, RoomView } from '../src/types.js';

// run with TEST_MONGODB_URI=mongodb://127.0.0.1:27017 (a throwaway database is created and dropped)
const MONGO = process.env.TEST_MONGODB_URI;
const DB = `bluff_test_${Date.now()}`;
const ADMIN_KEY = 'test-admin-key-123';

type Client = { socket: Socket; state: RoomView | null };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await wait(10);
  }
}

describe('guest-only server', () => {
  it('answers 503 on account routes when no database is configured', async () => {
    const server = createBluffServer();
    const res = await request(server.app).post('/api/auth/login').send({ username: 'a', password: 'b' });
    expect(res.status).toBe(503);
    expect((await request(server.app).get('/health')).body).toEqual({ ok: true, accounts: 'off' });
    server.close();
  });
});

describe.skipIf(!MONGO)('accounts API (MongoDB)', () => {
  let store: Store;
  let server: ReturnType<typeof createBluffServer>;
  let url = '';

  beforeAll(async () => {
    store = await createStore(
      MONGO!,
      { db: DB, users: 'users', sessions: 'sessions', games: 'games', audit: 'audit_log', friends: 'friends' },
      { defaultCoins: 1000, sessionTtlDays: 30 },
    );
    server = createBluffServer({ store, adminApiKey: ADMIN_KEY, authAttempts: 1000 });
    await new Promise<void>((resolve) => server.httpServer.listen(0, resolve));
    url = `http://localhost:${(server.httpServer.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.close();
    const client = new MongoClient(MONGO!);
    await client.connect();
    await client.db(DB).dropDatabase();
    await client.close();
    await store.close();
  });

  const api = () => request(server.app);
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const register = (username: string, password = 'secret-pass-1', displayName?: string) =>
    api().post('/api/auth/register').send({ username, password, displayName });

  async function socketClient(token?: string): Promise<Client> {
    const c: Client = {
      socket: connect(url, { transports: ['websocket'], forceNew: true, auth: token ? { token } : {} }),
      state: null,
    };
    c.socket.on('state', (s: RoomView) => (c.state = s));
    await new Promise<void>((resolve) => c.socket.once('connect', () => resolve()));
    return c;
  }
  const send = (c: Client, event: string, payload: object = {}) =>
    c.socket.timeout(3000).emitWithAck(event, payload) as Promise<{ ok: boolean; code?: string; error?: string }>;

  it('registers with default coins and rejects bad or duplicate input', async () => {
    const res = await register('ravi_01', 'secret-pass-1', 'Ravi');
    expect(res.status).toBe(201);
    expect(res.body.token).toMatch(/^[\w-]{40,}$/);
    expect(res.body.user).toMatchObject({ username: 'ravi_01', displayName: 'Ravi', role: 'user', coins: 1200 });
    expect(res.body.bonus).toBe(200);
    expect(res.body.user.passwordHash).toBeUndefined();
    expect((await register('RAVI_01')).status).toBe(409);
    expect((await register('x')).body.error).toMatch(/Username/);
    expect((await register('shortpw', '123')).body.error).toMatch(/Password/);
  });

  it('logs in, reads the profile with the bearer token, and logs out', async () => {
    await register('meena');
    expect((await api().post('/api/auth/login').send({ username: 'meena', password: 'wrong-pass-1' })).status).toBe(401);
    const unknown = await api().post('/api/auth/login').send({ username: 'nobody', password: 'wrong-pass-1' });
    expect(unknown.body.error).toBe('Wrong username or password');

    const login = await api().post('/api/auth/login').send({ username: 'MEENA', password: 'secret-pass-1' });
    expect(login.status).toBe(200);
    expect((await api().get('/api/me').set(bearer(login.body.token))).body.user.username).toBe('meena');
    expect((await api().get('/api/me')).status).toBe(401);
    expect((await api().post('/api/auth/logout').set(bearer(login.body.token))).status).toBe(204);
    expect((await api().get('/api/me').set(bearer(login.body.token))).status).toBe(401);
  });

  it('lets only admins (or the admin key) manage users and coins, and audits every change', async () => {
    const boss = await register('boss');
    const kid = await register('kiran');
    const bossAuth = bearer(boss.body.token);
    const kidId = kid.body.user.id as string;

    expect((await api().get('/api/admin/users').set(bossAuth)).status).toBe(403);
    expect((await api().post('/api/admin/make-admin').set('X-Admin-Key', 'nope').send({ username: 'boss' })).status).toBe(403);
    const promoted = await api().post('/api/admin/make-admin').set('X-Admin-Key', ADMIN_KEY).send({ username: 'boss' });
    expect(promoted.body.user.role).toBe('admin');

    const list = await api().get('/api/admin/users?search=kir').set(bossAuth);
    expect(list.body.users.map((u: PublicUser) => u.username)).toEqual(['kiran']);
    expect(list.body.users[0].passwordHash).toBeUndefined();

    const give = await api().post(`/api/admin/users/${kidId}/coins`).set(bossAuth).send({ amount: 500, reason: 'Diwali bonus' });
    expect(give.body.user.coins).toBe(1700);
    const tooMuch = await api().post(`/api/admin/users/${kidId}/coins`).set(bossAuth).send({ amount: -5000 });
    expect(tooMuch.status).toBe(400);
    const take = await api().post(`/api/admin/users/${kidId}/coins`).set(bossAuth).send({ amount: -200 });
    expect(take.body.user.coins).toBe(1500);
    expect((await api().post('/api/admin/users/abc/coins').set(bossAuth).send({ amount: 5 })).status).toBe(404);
    expect((await api().post('/api/admin/make-admin').set(bossAuth).send({ username: 'kiran' })).body.user.role).toBe('admin');

    const client = new MongoClient(MONGO!);
    await client.connect();
    const audit = await client.db(DB).collection('audit_log').find().sort({ createdAt: 1 }).toArray();
    await client.close();
    expect(audit.map((a) => [a.action, a.via, a.amount ?? null])).toEqual([
      ['make_admin', 'api_key', null],
      ['coins', 'admin', 500],
      ['coins', 'admin', -200],
      ['make_admin', 'admin', null],
    ]);
  });

  it('gives admins a full user page and lets them rename, block and reset passwords', async () => {
    const chief = await register('chief_1');
    const meena = await register('meena_1', 'secret-pass-1', 'Meena');
    const chiefAuth = bearer(chief.body.token);
    const [chiefId, meenaId] = [chief.body.user.id as string, meena.body.user.id as string];
    await api().post('/api/admin/make-admin').set('X-Admin-Key', ADMIN_KEY).send({ username: 'chief_1' });
    expect((await api().get(`/api/admin/users/${chiefId}`).set(bearer(meena.body.token))).status).toBe(403);

    await api().post(`/api/admin/users/${meenaId}/coins`).set(chiefAuth).send({ amount: 300, reason: 'Won the bet' });
    const renamed = await api().post(`/api/admin/users/${meenaId}`).set(chiefAuth).send({ displayName: 'Meena K', role: 'admin' });
    expect(renamed.body.user).toMatchObject({ displayName: 'Meena K', role: 'admin', blocked: false });
    expect((await api().post(`/api/admin/users/${meenaId}`).set(chiefAuth).send({})).status).toBe(400);
    expect((await api().post(`/api/admin/users/${meenaId}`).set(chiefAuth).send({ role: 'king' })).status).toBe(400);
    expect((await api().post(`/api/admin/users/${chiefId}`).set(chiefAuth).send({ blocked: true })).status).toBe(400);
    expect((await api().post(`/api/admin/users/${chiefId}`).set(chiefAuth).send({ displayName: 'Chief' })).body.user.displayName).toBe('Chief');

    // blocking logs them out everywhere and stops new logins
    expect((await api().post(`/api/admin/users/${meenaId}`).set(chiefAuth).send({ blocked: true })).body.user.blocked).toBe(true);
    expect((await api().get('/api/me').set(bearer(meena.body.token))).status).toBe(401);
    expect((await api().post('/api/auth/login').send({ username: 'meena_1', password: 'secret-pass-1' })).status).toBe(403);
    await api().post(`/api/admin/users/${meenaId}`).set(chiefAuth).send({ blocked: false });

    // a reset password works at once and the old one stops working
    expect((await api().post(`/api/admin/users/${meenaId}/password`).set(chiefAuth).send({ password: 'short' })).status).toBe(400);
    expect((await api().post(`/api/admin/users/${meenaId}/password`).set(chiefAuth).send({ password: 'fresh-pass-22' })).status).toBe(204);
    expect((await api().post('/api/auth/login').send({ username: 'meena_1', password: 'secret-pass-1' })).status).toBe(401);
    expect((await api().post('/api/auth/login').send({ username: 'meena_1', password: 'fresh-pass-22' })).status).toBe(200);

    const page = await api().get(`/api/admin/users/${meenaId}`).set(chiefAuth);
    expect(page.body.user).toMatchObject({ username: 'meena_1', displayName: 'Meena K', coins: 1500, blocked: false });
    expect(page.body.user.passwordHash).toBeUndefined();
    expect(page.body.user.lastLoginAt).toEqual(expect.any(String));
    expect(page.body).toMatchObject({ activeSessions: 1, friends: 0, games: [] });
    expect(page.body.history.map((h: AuditEntry) => [h.action, h.by, h.amount ?? h.detail])).toEqual([
      ['password', 'Chief', 'Password reset, logged out everywhere'],
      ['update', 'Chief', 'Unblocked'],
      ['update', 'Chief', 'Blocked'],
      ['update', 'Chief', 'Name: Meena → Meena K · Role: player → admin'],
      ['coins', 'Chief', 300],
    ]);
    expect((await api().get('/api/admin/users/nope').set(chiefAuth)).status).toBe(404);

    // 12 changes after these: the page shows the newest 10, page 2 has the oldest 2
    for (let i = 1; i <= 7; i++) await api().post(`/api/admin/users/${meenaId}/coins`).set(chiefAuth).send({ amount: i });
    const first = (await api().get(`/api/admin/users/${meenaId}`).set(chiefAuth)).body;
    expect(first.history).toHaveLength(10);
    expect(first.historyTotal).toBe(12);
    expect(first.history.slice(0, 2).map((h: AuditEntry) => h.amount)).toEqual([7, 6]);
    const second = (await api().get(`/api/admin/users/${meenaId}/history?page=2`).set(chiefAuth)).body;
    expect(second.total).toBe(12);
    expect(second.history.map((h: AuditEntry) => h.amount ?? h.detail)).toEqual(['Name: Meena → Meena K · Role: player → admin', 300]);
    expect((await api().get(`/api/admin/users/${meenaId}/history?page=3`).set(chiefAuth)).body.history).toEqual([]);
    expect((await api().get(`/api/admin/users/${meenaId}/history`).set(bearer(meena.body.token))).status).toBe(401);
  });

  it('shows coin rank, friends and today\'s rewards on the profile', async () => {
    const raja = await register('rank_raja');
    const auth = bearer(raja.body.token);
    const before = await api().get('/api/me/overview').set(auth);
    expect(before.body).toMatchObject({ friends: 0, loginBonusToday: true, gamesToday: 0 });
    expect(before.body.coinRank).toBeGreaterThan(1);
    await api().post('/api/admin/make-admin').set('X-Admin-Key', ADMIN_KEY).send({ username: 'rank_raja' });
    await api().post(`/api/admin/users/${raja.body.user.id}/coins`).set(auth).send({ amount: 1_000_000 });
    const after = await api().get('/api/me/overview').set(auth);
    expect(after.body).toMatchObject({ coinRank: 1, players: before.body.players });
    expect((await api().get('/api/me/overview')).status).toBe(401);
  });

  it('saves a finished game and adds it to the logged-in player stats', async () => {
    const account = await register('asha', 'secret-pass-1', 'Asha');
    const player = await socketClient(account.body.token);
    const guest = await socketClient();
    const { code } = await send(player, 'room:create', { name: 'ignored' });
    await send(guest, 'room:join', { code, name: 'Guesty' });
    await until(() => player.state?.players.length === 2);
    expect(player.state!.players.map((p) => p.name)).toEqual(['Asha', 'Guesty']);
    // logged-in players show a username (for friend requests) and a level; guests show neither
    expect(player.state!.players.map((p) => [p.username, p.level])).toEqual([['asha', 1], [null, null]]);

    await send(player, 'room:start');
    await until(() => player.state?.phase === 'playing' && guest.state?.phase === 'playing');
    // the starter plays their whole hand at once and the other passes, which ends the game
    const [mover, other] = player.state!.turnId === player.state!.meId ? [player, guest] : [guest, player];
    await send(mover, 'game:play', { cardIds: mover.state!.hand.map((c) => c.id), rank: 'A' });
    await until(() => other.state?.turnId === other.state?.meId);
    await send(other, 'game:pass');
    await until(() => player.state?.phase === 'over');

    let games: GameSummary[] = [];
    for (let i = 0; i < 60 && games.length === 0; i++) {
      games = (await api().get('/api/me/games').set(bearer(account.body.token))).body.games;
      if (games.length === 0) await wait(50);
    }
    const ashaWon = mover === player;
    expect(games).toHaveLength(1);
    expect(games[0]).toMatchObject({ roomCode: code, status: 'finished', won: ashaWon, lost: !ashaWon });
    expect(games[0].players.map((p) => p.guest)).toEqual([false, true]);

    const me = (await api().get('/api/me').set(bearer(account.body.token))).body.user as PublicUser;
    expect(me.stats).toMatchObject({ gamesPlayed: 1, wins: ashaWon ? 1 : 0, losses: ashaWon ? 0 : 1 });
    player.socket.disconnect();
    guest.socket.disconnect();
  });

  /** two logged-in players in a lobby; returns them host first */
  async function stakedRoom(a: string, b: string) {
    const ra = await register(a, 'secret-pass-1', a.slice(0, 16));
    const rb = await register(b, 'secret-pass-1', b.slice(0, 16));
    const host = await socketClient(ra.body.token);
    const other = await socketClient(rb.body.token);
    const { code } = await send(host, 'room:create', {});
    await send(other, 'room:join', { code });
    await until(() => host.state?.players.length === 2);
    return { host, other, code: code!, tokens: [ra.body.token as string, rb.body.token as string] };
  }

  /** whoever starts plays their whole hand, the other passes: the starter wins; a long game counts for daily rewards */
  async function playToEnd(x: Client, y: Client, code: string, longGame = true) {
    await until(() => x.state?.phase === 'playing' && y.state?.phase === 'playing');
    if (longGame) server.rooms.get(code).startedAt = new Date(Date.now() - 2 * 60_000);
    const [mover, other] = x.state!.turnId === x.state!.meId ? [x, y] : [y, x];
    await send(mover, 'game:play', { cardIds: mover.state!.hand.map((c) => c.id), rank: 'A' });
    await until(() => other.state?.turnId === other.state?.meId);
    await send(other, 'game:pass');
    await until(() => x.state?.phase === 'over' && y.state?.phase === 'over');
    return { winner: mover, loser: other };
  }

  const coinsOf = async (token: string) => (await api().get('/api/me').set(bearer(token))).body.user.coins as number;

  it('pays the daily login bonus once per day', async () => {
    const reg = await register('daily_d');
    expect(reg.body.user.coins).toBe(1200);
    const again = await api().get('/api/me').set(bearer(reg.body.token));
    expect(again.body).toMatchObject({ bonus: 0, user: { coins: 1200 } });

    const client = new MongoClient(MONGO!);
    await client.connect();
    await client.db(DB).collection('users').updateOne({ username: 'daily_d' }, { $set: { lastLoginBonusDay: '2000-01-01' } });
    await client.close();
    const nextDay = await api().get('/api/me').set(bearer(reg.body.token));
    expect(nextDay.body).toMatchObject({ bonus: 200, user: { coins: 1400 } });
    expect((await api().get('/api/me').set(bearer(reg.body.token))).body.bonus).toBe(0);
  });

  it('checks balances at start, moves the stake only when the game finishes, and pays the daily game ladder', async () => {
    const { host, other, tokens, code } = await stakedRoom('stake_a', 'stake_b');
    expect(await send(host, 'room:config', { decks: 1, bluffRule: 'all', stake: 5000 })).toEqual({ ok: true });
    const tooRich = await send(host, 'room:start');
    expect(tooRich.error).toMatch(/Not enough coins for a 5,000 stake: stake_a, stake_b/);
    expect(await send(host, 'room:config', { decks: 1, bluffRule: 'all', stake: 7 })).toEqual({ ok: false, error: 'Invalid settings' });

    // a game the host stops moves no coins
    await send(host, 'room:config', { decks: 1, bluffRule: 'all', stake: 100 });
    expect(await send(host, 'room:start')).toEqual({ ok: true });
    await until(() => other.state?.phase === 'playing');
    await send(host, 'room:lobby');
    expect([await coinsOf(tokens[0]), await coinsOf(tokens[1])]).toEqual([1200, 1200]);

    // first game of the day: stake moves and both get the 1-game reward (+100)
    await send(host, 'room:start');
    const { winner, loser } = await playToEnd(host, other, code);
    await until(() => winner.state?.coinResults != null);
    const results = new Map(winner.state!.coinResults!.map((r) => [r.playerId, r]));
    expect(results.get(winner.state!.meId)).toMatchObject({ change: 100, bonus: 100, coins: 1400, gamesToday: 1, counted: true });
    expect(results.get(loser.state!.meId)).toMatchObject({ change: -100, bonus: 100, coins: 1200, gamesToday: 1, counted: true });
    expect(winner.state!.players.find((p) => p.id === winner.state!.meId)?.coins).toBe(1400);

    // second game the same day: stake moves again, 2 games is not a reward step
    await send(host, 'room:rematch');
    const second = await playToEnd(host, other, code);
    await until(() => second.winner.state?.coinResults != null);
    expect(second.winner.state!.coinResults!.map((r) => [r.bonus, r.gamesToday])).toEqual([
      [0, 2],
      [0, 2],
    ]);

    const games = (await api().get('/api/me/games').set(bearer(tokens[0]))).body.games as GameSummary[];
    expect(games.map((g) => g.status)).toEqual(['finished', 'finished', 'ended_early']);
    expect(games[1]).toMatchObject({ stake: 100, bonus: 100, coinChange: winner === host ? 100 : -100 });
    expect(games[1].my).toEqual(expect.objectContaining({ bluffs: expect.any(Number), pickedUp: 0 }));
    host.socket.disconnect();
    other.socket.disconnect();
  });

  it('pays the daily game ladder at 1, 3, 5… games, skips games under a minute, and restarts each day', async () => {
    const reg = await register('ladder_l');
    const userId = reg.body.user.id as string;
    const zero = { bluffs: 0, caught: 0, goodCalls: 0, wrongCalls: 0, pickedUp: 0 };
    const game = (seconds: number): GameRecord => ({
      roomCode: 'LADR',
      config: { decks: 1, bluffRule: 'one', stake: 0 },
      status: 'finished',
      startedAt: new Date(Date.now() - seconds * 1000),
      endedAt: new Date(),
      players: [
        { memberId: 'm1', userId, name: 'ladder_l', place: 1, loser: false, kicked: false, won: true, stats: zero },
        { memberId: 'm2', userId: null, name: 'Guest', place: null, loser: true, kicked: false, won: false, stats: zero },
      ],
      awards: [],
      bets: [],
    });
    const save = async (seconds: number) => new Map((await store.games.save(game(seconds))).map((r) => [r.playerId, r]));

    // winning a game with no bluffs or calls: +20 for playing, +50 for winning
    expect((await save(90)).get('m1')).toMatchObject({ bonus: 100, gamesToday: 1, counted: true, coins: 1300, xp: 70 });
    expect((await save(30)).get('m1')).toMatchObject({ bonus: 0, gamesToday: 1, counted: false, coins: 1300 });
    expect((await save(90)).get('m1')).toMatchObject({ bonus: 0, gamesToday: 2, counted: true });
    const third = await save(90);
    expect(third.get('m1')).toMatchObject({ bonus: 300, gamesToday: 3, coins: 1600, level: expect.any(Number) });
    expect(third.get('m2')).toMatchObject({ bonus: 0, gamesToday: null, counted: false, coins: null, level: null, xp: 0 });
    expect((await api().get('/api/me/overview').set(bearer(reg.body.token))).body.gamesToday).toBe(3);

    const client = new MongoClient(MONGO!);
    await client.connect();
    await client.db(DB).collection('users').updateOne({ username: 'ladder_l' }, { $set: { gamesTodayDay: '2000-01-01' } });
    await client.close();
    expect((await save(90)).get('m1')).toMatchObject({ bonus: 100, gamesToday: 1, coins: 1700 });
  });

  it('plays a staked 2v2 with a bet: the team splits the pot and the bet is paid', async () => {
    const regs = [];
    for (const u of ['team_a1', 'team_b1', 'team_a2', 'team_b2']) regs.push(await register(u, 'secret-pass-1', u));
    const people = [];
    for (const r of regs) people.push(await socketClient(r.body.token));
    const { code } = await send(people[0], 'room:create', {});
    for (const p of people.slice(1)) await send(p, 'room:join', { code });
    await until(() => people.every((p) => p.state?.players.length === 4));
    expect(await send(people[0], 'room:config', { decks: 1, bluffRule: 'all', stake: 100, bets: true, teams: true })).toEqual({ ok: true });
    expect(await send(people[0], 'room:start')).toEqual({ ok: true });
    await until(() => people.every((p) => p.state?.phase === 'playing'));

    // the mover lies; an opponent (not their partner) calls with a bet
    const byId = new Map(people.map((p) => [p.state!.meId, p]));
    const mover = byId.get(people[0].state!.turnId!)!;
    const teams = mover.state!.teams!;
    const moverTeam = teams.find((t) => t.includes(mover.state!.meId))!;
    const caller = byId.get(teams.find((t) => t !== moverTeam)![0])!;
    const lie = mover.state!.hand[0];
    await send(mover, 'game:play', { cardIds: [lie.id], rank: lie.rank === 'K' ? 'Q' : 'K' });
    await until(() => caller.state?.lastPlay?.count === 1);
    expect(caller.state!.betLimit).toBe(100);
    const playId = caller.state!.lastPlay!.id;
    expect((await send(caller, 'game:bluff', { playId, bet: 7 })).error).toBe('Invalid bet');
    expect((await send(caller, 'game:bluff', { playId, bet: 250 })).error).toBe('You can bet up to the stake (100)');
    expect(await send(caller, 'game:bluff', { playId, bet: 100 })).toEqual({ ok: true });
    await until(() => caller.state?.reveal?.bet === 100);

    // the caller finishes 1st and the host ends the game: the caller's team wins
    server.rooms.get(code!).game!.places.push(caller.state!.meId);
    expect(await send(people[0], 'room:end')).toEqual({ ok: true });
    await until(() => people.every((p) => p.state?.coinResults != null));
    const results = new Map(caller.state!.coinResults!.map((r) => [r.playerId, r]));
    const callerId = caller.state!.meId;
    const callerPartner = teams.find((t) => t.includes(callerId))!.find((id) => id !== callerId)!;
    const moverPartner = moverTeam.find((id) => id !== mover.state!.meId)!;
    // pot of 400 split by the winning team: +100 each after paying 100; the bet moves 100 from mover to caller
    expect(results.get(callerId)).toMatchObject({ change: 100, bets: 100, coins: 1400 });
    expect(results.get(callerPartner)).toMatchObject({ change: 100, bets: 0, coins: 1300 });
    expect(results.get(mover.state!.meId)).toMatchObject({ change: -100, bets: -100, coins: 1000 });
    expect(results.get(moverPartner)).toMatchObject({ change: -100, bets: 0, coins: 1100 });
    expect([...caller.state!.winnerIds].sort()).toEqual([callerId, callerPartner].sort());
    people.forEach((p) => p.socket.disconnect());
  });

  it('keeps guests out of staked games', async () => {
    const acc = await register('host_g');
    const host = await socketClient(acc.body.token);
    const guest = await socketClient();
    const { code } = await send(host, 'room:create', {});
    await send(guest, 'room:join', { code, name: 'Guesty' });
    await send(host, 'room:config', { decks: 1, bluffRule: 'all', stake: 50 });
    expect((await send(host, 'room:start')).error).toMatch(/Guesty: guests can only play Free games/);
    host.socket.disconnect();
    guest.socket.disconnect();
  });

  it('lets only the host remove people, and stops a game that is left with one player', async () => {
    const { host, other, tokens } = await stakedRoom('kick_a', 'kick_b');
    const otherId = other.state!.meId;
    expect((await send(other, 'room:kick', { memberId: host.state!.meId })).error).toBe('Only the host can do that');

    let kicked = false;
    other.socket.on('room:kicked', () => (kicked = true));
    await send(host, 'room:config', { decks: 1, bluffRule: 'all', stake: 100 });
    await send(host, 'room:start');
    await until(() => other.state?.phase === 'playing');
    expect(await send(host, 'room:kick', { memberId: otherId })).toEqual({ ok: true });
    await until(() => kicked && host.state?.phase === 'over');
    expect(host.state!.players.map((p) => p.id)).not.toContain(otherId);
    expect((await send(other, 'game:pass')).error).toBe('You were removed from this room');
    await wait(200);
    expect([await coinsOf(tokens[0]), await coinsOf(tokens[1])]).toEqual([1200, 1200]);
    host.socket.disconnect();
    other.socket.disconnect();
  });

  it('handles friend requests, shows who is online, and delivers room invites', async () => {
    const a = await register('friend_a', 'secret-pass-1', 'Fa');
    const b = await register('friend_b', 'secret-pass-1', 'Fb');
    const authA = bearer(a.body.token);
    const authB = bearer(b.body.token);

    expect((await api().post('/api/friends/request').set(authA).send({ username: 'friend_a' })).status).toBe(400);
    expect((await api().post('/api/friends/request').set(authA).send({ username: 'nobody_here' })).status).toBe(404);
    expect((await api().post('/api/friends/request').set(authA).send({ username: 'friend_b' })).body.result).toBe('sent');
    expect((await api().post('/api/friends/request').set(authA).send({ username: 'friend_b' })).status).toBe(409);

    const bList = (await api().get('/api/friends').set(authB)).body as FriendsResponse;
    expect(bList.incoming.map((f) => f.username)).toEqual(['friend_a']);
    expect((await api().post(`/api/friends/${a.body.user.id}/accept`).set(authB)).status).toBe(204);

    const bSocket = await socketClient(b.body.token);
    const aList = (await api().get('/api/friends').set(authA)).body as FriendsResponse;
    expect(aList.friends).toEqual([expect.objectContaining({ username: 'friend_b', online: true })]);

    const invites: InviteEvent[] = [];
    bSocket.socket.on('invite', (i: InviteEvent) => invites.push(i));
    const aSocket = await socketClient(a.body.token);
    const { code } = await send(aSocket, 'room:create', {});
    expect(await send(aSocket, 'friend:invite', { userId: b.body.user.id })).toEqual({ ok: true });
    await until(() => invites.length === 1);
    expect(invites[0]).toEqual({ fromId: a.body.user.id, fromName: 'Fa', code });
    const friendB = async () => ((await api().get('/api/friends').set(authA)).body as FriendsResponse).friends[0];
    expect((await friendB()).inRoom).toBeNull();

    // nobody already in a room can be invited: this room...
    await send(bSocket, 'room:join', { code });
    expect((await friendB()).inRoom).toBe('here');
    expect((await send(aSocket, 'friend:invite', { userId: b.body.user.id })).error).toBe('Your friend is already in this room');

    // ...or another one
    await send(bSocket, 'room:leave');
    await send(bSocket, 'room:create', {});
    expect((await friendB()).inRoom).toBe('other');
    expect((await send(aSocket, 'friend:invite', { userId: b.body.user.id })).error).toBe('Your friend is already in another room');
    await send(bSocket, 'room:leave');
    expect((await friendB()).inRoom).toBeNull();
    expect(invites).toHaveLength(1);

    expect((await api().post(`/api/friends/${b.body.user.id}/remove`).set(authA)).status).toBe(204);
    expect((await send(aSocket, 'friend:invite', { userId: b.body.user.id })).error).toBe('You can only invite friends');
    aSocket.socket.disconnect();
    bSocket.socket.disconnect();
  });

  it('finds players by name, counts friend requests, and tells the other player straight away', async () => {
    const sam = await register('sam_find', 'secret-pass-1', 'Sam');
    const tia = await register('tia_find', 'secret-pass-1', 'Tia Sharma');
    const [samAuth, tiaAuth] = [bearer(sam.body.token), bearer(tia.body.token)];
    const search = async (q: string, auth = samAuth) =>
      (await api().get(`/api/friends/search?q=${encodeURIComponent(q)}`).set(auth)).body.players as PlayerSearchResult[];

    expect(await search('t')).toEqual([]);
    expect((await search('tia_f')).map((p) => [p.username, p.displayName, p.status, p.level])).toEqual([
      ['tia_find', 'Tia Sharma', 'none', 1],
    ]);
    expect((await search('SHARMA')).map((p) => p.username)).toEqual(['tia_find']);
    expect(await search('sam_find')).toEqual([]);
    expect(await search('nobody_here_zz')).toEqual([]);
    expect(await search('.*')).toEqual([]);
    expect((await api().get('/api/friends/search?q=tia')).status).toBe(401);

    const tiaApp = await socketClient(tia.body.token);
    let changed = 0;
    tiaApp.socket.on('friends:changed', () => changed++);
    await api().post('/api/friends/request').set(samAuth).send({ username: 'tia_find' });
    await until(() => changed === 1);
    expect((await api().get('/api/me').set(tiaAuth)).body.friendRequests).toBe(1);
    expect((await search('tia_f'))[0].status).toBe('sent');
    expect((await search('sam_f', tiaAuth))[0].status).toBe('incoming');

    await api().post(`/api/friends/${sam.body.user.id}/accept`).set(tiaAuth);
    expect((await api().get('/api/me').set(tiaAuth)).body.friendRequests).toBe(0);
    expect((await search('tia_f'))[0].status).toBe('friend');
    tiaApp.socket.disconnect();
  });

  it('shows a basic public profile of any player, with nothing private', async () => {
    const pia = await register('pia_pub', 'secret-pass-1', 'Pia');
    const raj = await register('raj_pub', 'secret-pass-1', 'Raj');
    const [piaAuth, rajAuth] = [bearer(pia.body.token), bearer(raj.body.token)];
    const card = async (username: string, auth = piaAuth) => (await api().get(`/api/players/${username}`).set(auth)).body.profile;

    expect((await api().get('/api/players/raj_pub')).status).toBe(401);
    const raju = await card('raj_pub');
    expect(raju).toMatchObject({ username: 'raj_pub', displayName: 'Raj', level: 1, online: false, status: 'none' });
    expect(raju.stats).toMatchObject({ gamesPlayed: 0, wins: 0 });
    // no coins, role, login times or password hash
    expect(Object.keys(raju).sort()).toEqual(['displayName', 'id', 'joinedAt', 'level', 'online', 'stats', 'status', 'username']);
    expect((await card('pia_pub')).status).toBe('me');

    await api().post('/api/friends/request').set(piaAuth).send({ username: 'raj_pub' });
    expect((await card('raj_pub')).status).toBe('sent');
    expect((await card('pia_pub', rajAuth)).status).toBe('incoming');
    expect((await api().get('/api/players/nobody_xyz').set(piaAuth)).status).toBe(404);

    // blocked accounts are hidden
    await api().post('/api/admin/make-admin').set('X-Admin-Key', ADMIN_KEY).send({ username: 'pia_pub' });
    await api().post(`/api/admin/users/${raj.body.user.id}`).set(piaAuth).send({ blocked: true });
    expect((await api().get('/api/players/raj_pub').set(piaAuth)).status).toBe(404);
  });

  it('allows API calls only from allowed sites', async () => {
    const ok = await api().options('/api/me').set('Origin', 'http://localhost:5173');
    expect(ok.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(ok.headers['access-control-allow-headers']).toContain('Authorization');
    const evil = await api().options('/api/me').set('Origin', 'https://evil.example');
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();
  });
});
