import type { AddressInfo } from 'node:net';
import { io as connect, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { targetFor } from '../src/games/darts/brain.js';
import { createBluffServer } from '../src/server.js';
import type { Announcement, ColorWarView, DartsView, DotsView, RoomView } from '../src/types.js';

type Client = { socket: Socket; state: RoomView | null; notes: Announcement[] };
type Res = { ok: boolean; error?: string };

const GAMES = ['ludo', 'snakes', 'rmcs', 'darts', 'dots', 'colorwar'];
let server: ReturnType<typeof createBluffServer>;
let url = '';
const opened: Client[] = [];

beforeAll(async () => {
  // bots and pauses at 1/20 of human pace
  server = createBluffServer({ limits: { createsPerIp: 10_000, liveRoomsPerIp: 10_000 }, botSpeed: 0.05 });
  await new Promise<void>((resolve) => server.httpServer.listen(0, resolve));
  url = `http://localhost:${(server.httpServer.address() as AddressInfo).port}`;
});

afterAll(() => {
  opened.forEach((c) => c.socket.disconnect());
  server.close();
});

async function client(): Promise<Client> {
  const c: Client = { socket: connect(url, { transports: ['websocket'], forceNew: true, auth: { rang: true, games: GAMES } }), state: null, notes: [] };
  c.socket.on('state', (s: RoomView) => (c.state = s));
  c.socket.on('announce', (n: Announcement) => c.notes.push(n));
  await new Promise<void>((resolve) => c.socket.once('connect', () => resolve()));
  opened.push(c);
  return c;
}

/** the per-player rate limit can refuse a machine-fast move: wait and send again */
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

async function room(game: string, people: number, bots: number, opts: object) {
  const all = await Promise.all(Array.from({ length: people }, () => client()));
  const created = await send(all[0], 'room:create', { name: 'P0' });
  for (const [i, p] of all.slice(1).entries()) expect(await send(p, 'room:join', { code: (created as { code?: string }).code, name: `P${i + 1}` })).toMatchObject({ ok: true });
  expect(await send(all[0], 'room:config', { game, decks: 1, bluffRule: 'one', stake: 0, opts })).toEqual({ ok: true });
  for (let i = 0; i < bots; i++) expect(await send(all[0], 'room:addBot')).toMatchObject({ ok: true });
  await until(() => all.every((p) => p.state?.config.game === game));
  expect(await send(all[0], 'room:start')).toEqual({ ok: true });
  await until(() => all.every((p) => p.state?.phase === 'playing' && p.state.plugged?.kind === game));
  return all;
}

const dartsOf = (c: Client) => (c.state!.plugged as { kind: 'darts'; darts: DartsView }).darts;
const dotsOf = (c: Client) => (c.state!.plugged as { kind: 'dots'; dots: DotsView }).dots;
const cwOf = (c: Client) => (c.state!.plugged as { kind: 'colorwar'; colorwar: ColorWarView }).colorwar;

describe('Darts over sockets', () => {
  it('two people throw a whole 301 game with game:move; the turn waits for its pause', async () => {
    const people = await room('darts', 2, 0, { start: 301 });
    const v0 = dartsOf(people[0]);
    expect(v0).toMatchObject({ start: 301, thrown: [], turnStart: 301, last: null, places: {} });
    expect(Object.values(v0.left)).toEqual([301, 301]);
    const idle = people.find((p) => p.state!.meId !== dartsOf(p).turnId)!;
    expect(await send(idle, 'game:move', { kind: 'darts', move: { type: 'throw', x: 0, y: 0 } })).toEqual({ ok: false, error: 'Not your turn' });
    expect(await send(idle, 'game:move', { kind: 'darts', move: { type: 'throw', x: 'a', y: 0 } })).toEqual({ ok: false, error: 'Aim at the board' });
    let waits = 0;
    for (let i = 0; i < 3000 && people[0].state!.phase === 'playing'; i++) {
      const p = people.find((x) => x.state!.meId === dartsOf(x).turnId);
      if (!p) break;
      const seq = dartsOf(p).last?.seq ?? 0;
      const t = targetFor(dartsOf(p).left[p.state!.meId]);
      const res = await send(p, 'game:move', { kind: 'darts', move: { type: 'throw', ...t } });
      if (res.error === 'Wait for the next turn') {
        waits++;
        await until(() => dartsOf(p).turnId !== p.state!.meId || p.state!.phase !== 'playing');
        continue;
      }
      expect(res).toEqual({ ok: true });
      await until(() => people.every((x) => (dartsOf(x).last?.seq ?? 0) > seq));
    }
    await until(() => people.every((p) => p.state!.phase === 'over'));
    expect(waits).toBeGreaterThan(0);
    const end = people[0].state!;
    expect(end.winnerIds).toHaveLength(1);
    expect(dartsOf(people[0]).left[end.winnerIds[0]]).toBe(0);
    expect(people[0].notes.some((n) => n.kind === 'over' && /^Game over\. P\d wins 🎉$/.test(n.text))).toBe(true);
  }, 120_000);

  it('a bot throws its own darts', async () => {
    const [me] = await room('darts', 1, 1, { start: 301 });
    const bot = me.state!.players.find((p) => p.id !== me.state!.meId)!.id;
    for (let i = 0; i < 200 && dartsOf(me).last?.playerId !== bot; i++) {
      if (dartsOf(me).turnId === me.state!.meId) await send(me, 'game:move', { kind: 'darts', move: { type: 'throw', x: 0, y: 0.6 } });
      await new Promise((r) => setTimeout(r, 20));
    }
    await until(() => dartsOf(me).last?.playerId === bot, 10_000);
  }, 60_000);
});

describe('Dots and Boxes over sockets', () => {
  it('a person and a bot fill a 4×4 board', async () => {
    const [me] = await room('dots', 1, 1, { size: 4 });
    expect(dotsOf(me).size).toBe(4);
    while (me.state!.phase === 'playing') {
      const v = dotsOf(me);
      if (v.turnId === me.state!.meId) {
        const free = Array.from({ length: 40 }, (_, l) => l).filter((l) => v.lines[l] === undefined);
        const seq = v.last?.seq ?? 0;
        const res = await send(me, 'game:move', { kind: 'dots', move: { type: 'line', line: free[0] } });
        expect(res).toEqual({ ok: true });
        await until(() => (dotsOf(me).last?.seq ?? 0) > seq);
      }
      await new Promise((r) => setTimeout(r, 5));
    }
    const v = dotsOf(me);
    expect(Object.keys(v.lines)).toHaveLength(40);
    expect(Object.values(v.scores).reduce((a, b) => a + b, 0)).toBe(16);
    expect(me.state!.winnerIds.length).toBeGreaterThan(0);
    expect(me.notes.some((n) => n.kind === 'over' && /with \d+ box(es)? 🎉$/.test(n.text))).toBe(true);
  }, 60_000);
});

describe('Colour Wars over sockets', () => {
  it('a person and a bot play to the last colour', async () => {
    const [me] = await room('colorwar', 1, 1, { size: 5 });
    expect(await send(me, 'game:move', { kind: 'colorwar', move: { type: 'tap', cell: 99 } })).toMatchObject({ ok: false });
    while (me.state!.phase === 'playing') {
      const v = cwOf(me);
      const id = me.state!.meId;
      if (v.turnId === id) {
        const first = v.firstMove.includes(id);
        const mine = v.cells.map((c, i) => ({ c, i })).filter(({ c }) => (first ? c.owner === null : c.owner === id));
        // the fullest of my cells, so chains happen
        mine.sort((a, b) => b.c.dots - a.c.dots);
        const seq = v.last?.seq ?? 0;
        expect(await send(me, 'game:move', { kind: 'colorwar', move: { type: 'tap', cell: mine[0].i } })).toEqual({ ok: true });
        await until(() => (cwOf(me).last?.seq ?? 0) > seq);
      }
      await new Promise((r) => setTimeout(r, 5));
    }
    const v = cwOf(me);
    expect(v.alive).toHaveLength(1);
    expect(me.state!.winnerIds).toEqual(v.alive);
    expect(v.places[v.alive[0]]).toBe(1);
  }, 60_000);
});
