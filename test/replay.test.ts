import type { AddressInfo } from 'node:net';
import { MongoClient, ObjectId } from 'mongodb';
import { io as connect, type Socket } from 'socket.io-client';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GameEvent } from '../src/models.js';
import { ReplayRecorder } from '../src/replay.js';
import { Room } from '../src/rooms.js';
import { createBluffServer } from '../src/server.js';
import { createStore, type Store } from '../src/services/store.js';
import type { Card, GameConfig, GameSummary, Rank, ReplayResponse, RoomView } from '../src/types.js';
import { parseConfig } from '../src/validate.js';

let seq = 0;
const card = (rank: Rank, suit: Card['suit'] = 'S'): Card => ({ id: `${rank}${suit}${++seq}`, rank, suit });

/** a dealt room with these people (the first is host) */
function room(names: string[], config: GameConfig) {
  const r = new Room('REPL');
  const people = names.map((n) => r.addMember(n));
  r.setConfig(people[0].id, config);
  r.start(people[0].id);
  return { r, people };
}

/** what socket.ts does after each move */
const move = (r: Room, events: GameEvent[]) => r.recordStep(r.announce(events).map((a) => a.text), events);

describe('replay steps', () => {
  it('records the deal and every move in order, with counts, pile, claims and real cards', () => {
    const { r, people } = room(['Asha', 'Ravi'], parseConfig({ decks: 1, bluffRule: 'all' }));
    const [asha, ravi] = people;
    const g = r.game!;
    g.hands.set(asha.id, [card('K'), card('2'), card('3')]);
    g.hands.set(ravi.id, [card('5'), card('6')]);
    g.turnId = asha.id;
    // start step taken at the deal; take a fresh one with the hands set above
    r.replay!.start(g, g, null);

    const fake = g.hand(asha.id).find((c) => c.rank === '2')!;
    move(r, g.play(asha.id, [fake.id], 'K'));
    move(r, g.callBluff(ravi.id, g.lastPlay!.id));

    const rec = r.snapshot('finished')!.replay!;
    expect(rec.game).toBe('bluff');
    expect(rec.cards).toBe(true);
    expect(rec.players.map((p) => p.name)).toEqual(['Asha', 'Ravi']);
    expect(rec.steps).toHaveLength(3);
    const [start, played, called] = rec.steps;
    expect(start).toMatchObject({ turnId: asha.id, counts: [3, 2], pile: 0, claim: null });
    expect(played.lines).toEqual(['Asha played one King']);
    expect(played).toMatchObject({ turnId: ravi.id, counts: [2, 2], pile: 1, claim: { playerId: asha.id, count: 1, rank: 'K', cards: [fake] } });
    // the call shows the play it turned over and who picked up
    expect(called.lines[0]).toMatch(/^Ravi called bluff. Caught! Asha picks up 1 cards/);
    expect(called).toMatchObject({ counts: [3, 2], pile: 0, call: { callerId: ravi.id, playerId: asha.id, caught: true } });
    expect(called.claim?.cards).toEqual([fake]);
  });

  it('never keeps played cards when lies are secret', () => {
    const { r, people } = room(['Asha', 'Ravi'], parseConfig({ decks: 1, bluffRule: 'all', secretLies: true }));
    const [asha, ravi] = people;
    const g = r.game!;
    g.turnId = asha.id;
    move(r, g.play(asha.id, [g.hand(asha.id)[0].id], 'A'));
    move(r, g.callBluff(ravi.id, g.lastPlay!.id));
    const rec = r.snapshot('finished')!.replay!;
    expect(rec.cards).toBe(false);
    expect(rec.steps[1].claim).toEqual({ playerId: asha.id, count: 1, rank: 'A' });
    expect(JSON.stringify(rec.steps)).not.toMatch(/"cards"|"suit"/);
  });

  it('records Crazy 7 top cards and nothing in the lobby', () => {
    const { r, people } = room(['Asha', 'Ravi'], parseConfig({ decks: 1, bluffRule: 'all', game: 'crazy7' }));
    const c = r.c7!;
    const rec = r.snapshot('ended_early')!.replay!;
    expect(rec).toMatchObject({ game: 'crazy7', cards: false });
    expect(rec.steps[0].top).toEqual(c.top());
    expect(rec.steps[0].counts).toEqual(c.order.map((id) => c.hand(id).length));
    r.backToLobby(people[0].id);
    expect(r.replay).toBe(null);
    r.recordStep(['nothing'], []);
    expect(r.snapshot('ended_early')).toBe(null);
  });

  it('caps the steps but keeps the game-over step last', () => {
    const { r } = room(['Asha', 'Ravi'], parseConfig({ decks: 1, bluffRule: 'all' }));
    const g = r.game!;
    const rec = new ReplayRecorder('bluff', [], true, 3);
    rec.start(g, g, null);
    for (let i = 0; i < 5; i++) rec.record(g, g, null, [`move ${i}`], []);
    g.over = true;
    rec.record(g, g, null, ['Game over'], []);
    rec.record(g, g, null, ['after the end'], []);
    const out = rec.toReplay();
    expect(out.steps.map((s) => s.lines[0] ?? 'start')).toEqual(['start', 'move 0', 'Game over']);
    expect(out.truncated).toBe(true);
  });
});

// run with TEST_MONGODB_URI=mongodb://127.0.0.1:27099 (a throwaway database is created and dropped)
const MONGO = process.env.TEST_MONGODB_URI;
const DB = `bluff_test_replay_${Date.now()}`;
const ADMIN_KEY = 'test-admin-key-replay';

type Client = { socket: Socket; state: RoomView | null };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await wait(10);
  }
}

describe.skipIf(!MONGO)('replay API (MongoDB)', () => {
  let store: Store;
  let server: ReturnType<typeof createBluffServer>;
  let url = '';

  beforeAll(async () => {
    store = await createStore(
      MONGO!,
      { db: DB, users: 'users', sessions: 'sessions', games: 'games', audit: 'audit_log', friends: 'friends', settings: 'settings' },
      { defaultCoins: 1000, sessionTtlDays: 30 },
    );
    server = createBluffServer({ store, adminApiKey: ADMIN_KEY, authAttempts: 1000, limits: { createsPerIp: 10_000, liveRoomsPerIp: 10_000 } });
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
  const register = async (username: string) => (await api().post('/api/auth/register').send({ username, password: 'secret-pass-1' })).body.token as string;

  async function socketClient(token?: string): Promise<Client> {
    const c: Client = { socket: connect(url, { transports: ['websocket'], forceNew: true, auth: token ? { token } : {} }), state: null };
    c.socket.on('state', (s: RoomView) => (c.state = s));
    await new Promise<void>((resolve) => c.socket.once('connect', () => resolve()));
    return c;
  }
  const send = (c: Client, event: string, payload: object = {}) =>
    c.socket.timeout(3000).emitWithAck(event, payload) as Promise<{ ok: boolean; code?: string; error?: string }>;

  /** a logged-in player and a guest play one quick game; returns its saved summary */
  async function playGame(token: string, secretLies: boolean): Promise<GameSummary> {
    const player = await socketClient(token);
    const guest = await socketClient();
    const { code } = await send(player, 'room:create', {});
    await send(guest, 'room:join', { code, name: 'Guesty' });
    await until(() => player.state?.players.length === 2);
    expect(await send(player, 'room:config', { decks: 1, bluffRule: 'all', secretLies })).toEqual({ ok: true });
    await send(player, 'room:start');
    await until(() => player.state?.phase === 'playing' && guest.state?.phase === 'playing');
    // the starter plays their whole hand as Aces (a lie) and the other passes, which ends the game
    const [mover, other] = player.state!.turnId === player.state!.meId ? [player, guest] : [guest, player];
    await send(mover, 'game:play', { cardIds: mover.state!.hand.map((c) => c.id), rank: 'A' });
    await until(() => other.state?.turnId === other.state?.meId);
    await send(other, 'game:pass');
    await until(() => player.state?.phase === 'over');
    let games: GameSummary[] = [];
    for (let i = 0; i < 60; i++) {
      games = (await api().get('/api/me/games').set(bearer(token))).body.games;
      if (games.some((g) => g.roomCode === code)) break;
      await wait(50);
    }
    player.socket.disconnect();
    guest.socket.disconnect();
    return games.find((g) => g.roomCode === code)!;
  }

  it('saves the steps with the game and shows them only to its players and admins', async () => {
    const asha = await register('rp_asha');
    const outsider = await register('rp_out');
    const boss = await register('rp_boss');
    await api().post('/api/admin/make-admin').set('X-Admin-Key', ADMIN_KEY).send({ username: 'rp_boss' });

    const game = await playGame(asha, false);
    expect(game.hasReplay).toBe(true);
    const res = await api().get(`/api/me/games/${game.id}/replay`).set(bearer(asha));
    expect(res.status).toBe(200);
    const replay = res.body as ReplayResponse;
    expect(replay).toMatchObject({ id: game.id, game: 'bluff', status: 'finished', cards: true });
    expect(replay.players.map((p) => p.name)).toEqual(['rp_asha', 'Guesty']);
    // deal, the play, the pass that ends it
    expect(replay.steps.length).toBe(3);
    expect(replay.steps[0].lines[0]).toMatch(/^Game started/);
    expect(replay.steps[1].lines[0]).toMatch(/played/);
    expect(replay.steps[1].claim?.cards?.length).toBe(replay.steps[1].claim?.count);
    expect(replay.steps[2].lines.join(' ')).toMatch(/Game over/);
    expect(replay.steps[2].turnId).toBe(null);

    expect((await api().get(`/api/me/games/${game.id}/replay`).set(bearer(outsider))).status).toBe(404);
    expect((await api().get(`/api/me/games/${game.id}/replay`).set(bearer(boss))).status).toBe(200);
    expect((await api().get(`/api/me/games/${game.id}/replay`)).status).toBe(401);
    expect((await api().get('/api/me/games/not-an-id/replay').set(bearer(asha))).status).toBe(404);
  });

  it('keeps played cards out when lies are secret', async () => {
    const asha = await register('rp_secret');
    const game = await playGame(asha, true);
    const replay = (await api().get(`/api/me/games/${game.id}/replay`).set(bearer(asha))).body as ReplayResponse;
    expect(replay.cards).toBe(false);
    expect(replay.steps[1].claim).toMatchObject({ rank: 'A' });
    expect(JSON.stringify(replay.steps)).not.toMatch(/"cards"|"suit"/);
  });

  it('answers 404 for older games saved without a replay', async () => {
    const asha = await register('rp_old');
    const game = await playGame(asha, false);
    const client = new MongoClient(MONGO!);
    await client.connect();
    await client.db(DB).collection('games').updateOne({ _id: new ObjectId(game.id) }, { $unset: { replay: '' } });
    await client.close();
    expect((await api().get(`/api/me/games/${game.id}/replay`).set(bearer(asha))).status).toBe(404);
    const games: GameSummary[] = (await api().get('/api/me/games').set(bearer(asha))).body.games;
    expect(games.find((g) => g.id === game.id)!.hasReplay).toBe(false);
  });
});
