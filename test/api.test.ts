import type { AddressInfo } from 'node:net';
import { MongoClient } from 'mongodb';
import { io as connect, type Socket } from 'socket.io-client';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBluffServer } from '../src/server.js';
import { createStore, type Store } from '../src/services/store.js';
import type { GameSummary, PublicUser, RoomView } from '../src/types.js';

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
      { db: DB, users: 'users', sessions: 'sessions', games: 'games', audit: 'audit_log' },
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
    expect(res.body.user).toMatchObject({ username: 'ravi_01', displayName: 'Ravi', role: 'user', coins: 1000 });
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
    expect(give.body.user.coins).toBe(1500);
    const tooMuch = await api().post(`/api/admin/users/${kidId}/coins`).set(bossAuth).send({ amount: -2000 });
    expect(tooMuch.status).toBe(400);
    const take = await api().post(`/api/admin/users/${kidId}/coins`).set(bossAuth).send({ amount: -200 });
    expect(take.body.user.coins).toBe(1300);
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

  it('saves a finished game and adds it to the logged-in player stats', async () => {
    const account = await register('asha', 'secret-pass-1', 'Asha');
    const player = await socketClient(account.body.token);
    const guest = await socketClient();
    const { code } = await send(player, 'room:create', { name: 'ignored' });
    await send(guest, 'room:join', { code, name: 'Guesty' });
    await until(() => player.state?.players.length === 2);
    expect(player.state!.players.map((p) => p.name)).toEqual(['Asha', 'Guesty']);

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

  it('allows API calls only from allowed sites', async () => {
    const ok = await api().options('/api/me').set('Origin', 'http://localhost:5173');
    expect(ok.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(ok.headers['access-control-allow-headers']).toContain('Authorization');
    const evil = await api().options('/api/me').set('Origin', 'https://evil.example');
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();
  });
});
