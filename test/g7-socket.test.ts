import type { AddressInfo } from 'node:net';
import { io as connect, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dictionary } from '../src/games/wordhunt/dictionary.js';
import { solve } from '../src/games/wordhunt/grid.js';
import { createBluffServer } from '../src/server.js';
import type { Announcement, GomokuView, RoomView, UtttView, WordHuntView } from '../src/types.js';

type Client = { socket: Socket; state: RoomView | null; notes: Announcement[] };
type Res = { ok: boolean; error?: string };

const GAMES = ['gomoku', 'uttt', 'wordhunt'];
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

const gomokuOf = (c: Client) => (c.state!.plugged as { kind: 'gomoku'; gomoku: GomokuView }).gomoku;
const utttOf = (c: Client) => (c.state!.plugged as { kind: 'uttt'; uttt: UtttView }).uttt;
const huntOf = (c: Client) => (c.state!.plugged as { kind: 'wordhunt'; wordhunt: WordHuntView }).wordhunt;

describe('Five in a Row over sockets', () => {
  it('a person and a bot play to five in a row or a full board', async () => {
    const [me] = await room('gomoku', 1, 1, {});
    expect(gomokuOf(me).size).toBe(15);
    while (me.state!.phase === 'playing') {
      const v = gomokuOf(me);
      if (v.turnId === me.state!.meId) {
        // the empty point nearest the centre
        const c = 7;
        const free = v.cells.map((s, i) => (s === -1 ? i : -1)).filter((i) => i >= 0);
        const at = free.sort((a, b) => Math.hypot((a % 15) - c, Math.floor(a / 15) - c) - Math.hypot((b % 15) - c, Math.floor(b / 15) - c))[0];
        expect(await send(me, 'game:move', { kind: 'gomoku', move: { type: 'place', at } })).toEqual({ ok: true });
        await until(() => me.state!.phase !== 'playing' || gomokuOf(me).moves > v.moves);
      }
      await new Promise((r) => setTimeout(r, 5));
    }
    const v = gomokuOf(me);
    expect(v.winner !== null || v.draw).toBe(true);
    if (v.winner) expect(v.line!.length).toBeGreaterThanOrEqual(5);
    expect(me.notes.some((n) => n.kind === 'over')).toBe(true);
  }, 60_000);
});

describe('Ultimate Tic-Tac-Toe over sockets', () => {
  it('a person and a bot play a whole game in the boards they are sent to', async () => {
    const [me] = await room('uttt', 1, 1, {});
    while (me.state!.phase === 'playing') {
      const v = utttOf(me);
      if (v.turnId === me.state!.meId) {
        const board = v.active[0];
        const cell = [4, 0, 2, 6, 8, 1, 3, 5, 7].find((k) => v.cells[board * 9 + k] === null)!;
        expect(await send(me, 'game:move', { kind: 'uttt', move: { type: 'place', board, cell } })).toEqual({ ok: true });
        await until(() => me.state!.phase !== 'playing' || utttOf(me).moves > v.moves);
        const after = utttOf(me);
        if (after.last?.playerId === me.state!.meId && after.turnId) expect(after.active.length > 1 || after.active[0] === cell).toBe(true);
      }
      await new Promise((r) => setTimeout(r, 5));
    }
    const v = utttOf(me);
    expect(v.winner !== null || v.draw).toBe(true);
    expect(me.notes.some((n) => n.kind === 'over')).toBe(true);
  }, 60_000);
});

describe('Word Grid Hunt over sockets', () => {
  it('two people and a bot play 3 rounds; words stay hidden until the reveal', async () => {
    const [a, b] = await room('wordhunt', 2, 1, { grid: 4, time: 90 });
    // the game's clock runs 20× fast, matching the test server's bot pace
    const g = (server.rooms.get(a.state!.code) as unknown as { plugged: { now: () => number } }).plugged;
    const t0 = Date.now();
    g.now = () => t0 + (Date.now() - t0) * 20;
    const d = dictionary();
    const seenRounds = new Set<number>();
    while (a.state!.phase === 'playing') {
      const v = huntOf(a);
      if (v.phase === 'play' && !seenRounds.has(v.round)) {
        seenRounds.add(v.round);
        const words = [...solve(d, v.grid, 4).entries()];
        const [w1, w2] = [words[0], words[words.length - 1]];
        expect(await send(a, 'game:move', { kind: 'wordhunt', move: { type: 'word', round: v.round, path: w1[1].path } })).toEqual({ ok: true });
        await until(() => huntOf(a).lastTry?.word === w1[0] || huntOf(a).phase !== 'play');
        if (huntOf(a).phase !== 'play') continue;
        expect(huntOf(a).lastTry).toMatchObject({ verdict: 'ok' });
        expect(await send(b, 'game:move', { kind: 'wordhunt', move: { type: 'word', round: v.round, path: w2[1].path } })).toEqual({ ok: true });
        // a path that skips tiles
        expect(await send(a, 'game:move', { kind: 'wordhunt', move: { type: 'word', round: v.round, path: [0, 2, 8] } })).toEqual({ ok: true });
        await until(() => huntOf(a).lastTry?.verdict === 'path' || huntOf(a).phase !== 'play');
        await until(() => huntOf(a).counts[b.state!.meId!] >= 1 || huntOf(a).phase !== 'play');
        const mine = huntOf(a);
        if (mine.phase === 'play') {
          expect(mine.mine.map((w) => w.word)).toEqual([w1[0]]);
          if (w2[0] !== w1[0]) expect(JSON.stringify(mine)).not.toContain(`"${w2[0]}"`);
        }
      }
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(seenRounds.size).toBe(3);
    const v = huntOf(a);
    expect(v.phase).toBe('over');
    expect(v.reveal?.round).toBe(3);
    expect(Object.keys(v.reveal!.words)).toHaveLength(3);
    expect(Object.keys(v.places)).toHaveLength(3);
    expect(a.notes.some((n) => /^Round 1 of 3/.test(n.text))).toBe(true);
    expect(a.notes.some((n) => n.kind === 'over')).toBe(true);
  }, 90_000);
});
