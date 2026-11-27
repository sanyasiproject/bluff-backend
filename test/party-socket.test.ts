import type { AddressInfo } from 'node:net';
import { io as connect, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBluffServer } from '../src/server.js';
import type { Announcement, RmcsView, RoomView, SnakesView } from '../src/types.js';

type Client = { socket: Socket; state: RoomView | null; notes: Announcement[] };
type Res = { ok: boolean; error?: string; code?: string };

let server: ReturnType<typeof createBluffServer>;
let url = '';
const opened: Client[] = [];

beforeAll(async () => {
  // bots and timed steps at 1/20 of human pace: an 8 s chit window is 400 ms
  server = createBluffServer({ limits: { createsPerIp: 10_000, liveRoomsPerIp: 10_000 }, botSpeed: 0.05 });
  await new Promise<void>((resolve) => server.httpServer.listen(0, resolve));
  url = `http://localhost:${(server.httpServer.address() as AddressInfo).port}`;
});

afterAll(() => {
  opened.forEach((c) => c.socket.disconnect());
  server.close();
});

async function client(games: string[]): Promise<Client> {
  const c: Client = { socket: connect(url, { transports: ['websocket'], forceNew: true, auth: { rang: true, games } }), state: null, notes: [] };
  c.socket.on('state', (s: RoomView) => (c.state = s));
  c.socket.on('announce', (n: Announcement) => c.notes.push(n));
  await new Promise<void>((resolve) => c.socket.once('connect', () => resolve()));
  opened.push(c);
  return c;
}

/** the server's per-player rate limit can refuse a machine-fast move: wait a moment and send it again */
async function send(c: Client, event: string, payload: object = {}): Promise<Res> {
  for (let i = 0; ; i++) {
    const res: Res = await c.socket.timeout(2000).emitWithAck(event, payload);
    if (res.error !== 'Too fast, slow down' || i >= 15) return res;
    await new Promise((r) => setTimeout(r, 300 + 100 * i));
  }
}

async function until(check: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function room(game: string, n: number, config: object) {
  const people = await Promise.all(Array.from({ length: n }, () => client(['ludo', 'snakes', 'rmcs'])));
  const created = await send(people[0], 'room:create', { name: 'P0' });
  for (const [i, p] of people.slice(1).entries()) expect(await send(p, 'room:join', { code: created.code, name: `P${i + 1}` })).toMatchObject({ ok: true });
  expect(await send(people[0], 'room:config', { game, decks: 1, bluffRule: 'one', stake: 0, ...config })).toEqual({ ok: true });
  await until(() => people.every((p) => p.state?.config.game === game));
  return people;
}

const snakesOf = (c: Client): SnakesView => (c.state!.plugged as { kind: 'snakes'; snakes: SnakesView }).snakes;
const rmcsOf = (c: Client): RmcsView => (c.state!.plugged as { kind: 'rmcs'; rmcs: RmcsView }).rmcs;

describe('Saanp Seedhi over sockets', () => {
  it('two people roll a whole game with game:move; only the player on turn rolls', async () => {
    const people = await room('snakes', 2, { opts: { exact: false, six: false } });
    expect(await send(people[0], 'room:start')).toEqual({ ok: true });
    await until(() => people.every((p) => p.state?.phase === 'playing' && p.state.plugged?.kind === 'snakes'));
    const idle = people.find((p) => p.state!.meId !== snakesOf(p).turnId)!;
    expect(await send(idle, 'game:move', { kind: 'snakes', move: { type: 'roll' } })).toEqual({ ok: false, error: 'Not your turn' });
    expect(await send(idle, 'game:move', { kind: 'ludo', move: { type: 'roll' } })).toEqual({ ok: false, error: 'That move is for another game' });
    expect(await send(idle, 'game:move', { kind: 'snakes', move: { type: 'jump' } })).toEqual({ ok: false, error: 'Invalid move' });
    const key = (c: Client) => `${c.state!.phase}|${snakesOf(c).rollSeq}`;
    for (let i = 0; i < 3000 && people[0].state!.phase === 'playing'; i++) {
      await until(() => people.every((p) => key(p) === key(people[0])));
      if (people[0].state!.phase !== 'playing') break;
      const before = key(people[0]);
      const p = people.find((x) => x.state!.meId === snakesOf(x).turnId)!;
      expect(await send(p, 'game:move', { kind: 'snakes', move: { type: 'roll' } })).toEqual({ ok: true });
      await until(() => people.every((x) => key(x) !== before));
    }
    await until(() => people.every((p) => p.state!.phase === 'over'));
    const end = people[0].state!;
    expect(end.winnerIds).toHaveLength(1);
    expect(snakesOf(people[0]).seats.find((s) => s.playerId === end.winnerIds[0])!.pos).toBe(100);
    expect(people[0].notes.some((n) => n.kind === 'over' && /wins 🎉$/.test(n.text))).toBe(true);
  }, 120_000);

  it('a bot rolls its own turns', async () => {
    const [me] = await room('snakes', 1, { opts: { exact: false, six: false } });
    expect(await send(me, 'room:addBot')).toMatchObject({ ok: true });
    expect(await send(me, 'room:start')).toEqual({ ok: true });
    await until(() => me.state?.phase === 'playing');
    const bot = me.state!.players.find((p) => p.id !== me.state!.meId)!.id;
    // I roll whenever it's my turn; the bot answers by itself
    for (let i = 0; i < 400 && me.state!.phase === 'playing'; i++) {
      if (snakesOf(me).turnId === me.state!.meId) await send(me, 'game:move', { kind: 'snakes', move: { type: 'roll' } });
      await new Promise((r) => setTimeout(r, 10));
      if (snakesOf(me).last?.playerId === bot) break;
    }
    await until(() => snakesOf(me).last?.playerId === bot || me.state!.phase === 'over', 20_000);
  }, 60_000);
});

describe('Raja Mantri over sockets', () => {
  it('one person and three bots play 5 rounds: open, guess as Mantri, results, game over', async () => {
    const [me] = await room('rmcs', 1, { opts: { rounds: 5 } });
    expect(await send(me, 'room:start')).toEqual({ ok: false, error: 'Raja Mantri Chor Sipahi needs exactly 4 players. Add bots to fill the table' });
    for (let i = 0; i < 3; i++) expect(await send(me, 'room:addBot')).toMatchObject({ ok: true });
    expect(await send(me, 'room:start')).toEqual({ ok: true });
    await until(() => me.state?.phase === 'playing' && me.state.plugged?.kind === 'rmcs');
    expect(await send(me, 'game:move', { kind: 'rmcs', move: { type: 'guess', target: 'x' } })).toEqual({ ok: false, error: 'Wait for everyone to open their chit' });
    const acted = new Set<string>();
    while (me.state!.phase === 'playing') {
      const v = rmcsOf(me);
      const id = me.state!.meId;
      const at = `${v.round}|${v.phase}`;
      if (v.phase === 'open' && !v.opened.includes(id) && !acted.has(at)) {
        acted.add(at);
        expect(v.myRole).not.toBeNull();
        expect(Object.keys(v.shown).every((p) => v.shown[p] === 'raja')).toBe(true);
        const res = await send(me, 'game:move', { kind: 'rmcs', move: { type: 'open' } });
        expect([undefined, 'Your chit is already open']).toContain(res.error);
      }
      if (v.phase === 'guess' && me.state!.turnId === id && !acted.has(at)) {
        acted.add(at);
        const target = Object.keys(v.scores).find((p) => p !== id && v.shown[p] !== 'raja')!;
        const res = await send(me, 'game:move', { kind: 'rmcs', move: { type: 'guess', target } });
        expect([undefined, 'This round is over']).toContain(res.error);
      }
      await new Promise((r) => setTimeout(r, 5));
    }
    await until(() => me.state!.phase === 'over', 30_000);
    const end = rmcsOf(me);
    expect(end.history).toHaveLength(5);
    expect(end.endsAt).toBeNull();
    expect(Object.values(end.scores).reduce((a, b) => a + b, 0)).toBe(5 * 2300);
    expect(me.state!.winnerIds.length).toBeGreaterThan(0);
    const texts = me.notes.map((n) => n.text);
    expect(texts).toContain('Game started');
    expect(texts).toContain('Round 1 of 5');
    expect(texts).toContain('Round 5 of 5');
    expect(texts.some((t) => /^Raja is .+ 👑$/.test(t))).toBe(true);
    expect(texts.some((t) => /^Mantri .+, find the Chor!$/.test(t))).toBe(true);
    expect(texts.some((t) => /^(Pakda gaya! 🦹|Chor bach gaya! 😈) .+ was the Chor$/.test(t))).toBe(true);
    expect(texts.some((t) => /^Game over\. .+ (wins|share first) with .+ points 🎉$/.test(t))).toBe(true);
  }, 60_000);
});
