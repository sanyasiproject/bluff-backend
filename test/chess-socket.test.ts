import type { AddressInfo } from 'node:net';
import { io as connect, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CHESS_TIMING } from '../src/games/chess/game.js';
import { createBluffServer } from '../src/server.js';
import type { Announcement, ChessView, RoomView } from '../src/types.js';

type Client = { socket: Socket; state: RoomView | null; notes: Announcement[] };
type Res = { ok: boolean; error?: string };

let server: ReturnType<typeof createBluffServer>;
let url = '';
const opened: Client[] = [];

beforeAll(async () => {
  CHESS_TIMING.botMinMs = 0;
  CHESS_TIMING.botAnswerMs = 20;
  server = createBluffServer({ limits: { createsPerIp: 10_000, liveRoomsPerIp: 10_000 }, botSpeed: 0.05 });
  await new Promise<void>((resolve) => server.httpServer.listen(0, resolve));
  url = `http://localhost:${(server.httpServer.address() as AddressInfo).port}`;
});

afterAll(() => {
  opened.forEach((c) => c.socket.disconnect());
  server.close();
  CHESS_TIMING.botMinMs = 500;
  CHESS_TIMING.botAnswerMs = 900;
});

async function client(): Promise<Client> {
  const c: Client = { socket: connect(url, { transports: ['websocket'], forceNew: true, auth: { rang: true, games: ['chess'] } }), state: null, notes: [] };
  c.socket.on('state', (s: RoomView) => (c.state = s));
  c.socket.on('announce', (n: Announcement) => c.notes.push(n));
  await new Promise<void>((resolve) => c.socket.once('connect', () => resolve()));
  opened.push(c);
  return c;
}

const send = (c: Client, event: string, payload: object = {}): Promise<Res> => c.socket.timeout(3000).emitWithAck(event, payload);

async function until(check: () => boolean, ms = 10_000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 5));
  }
}

const chessOf = (c: Client) => (c.state!.plugged as { kind: 'chess'; chess: ChessView }).chess;

async function room(people: number, bots: number, opts: object) {
  const all = await Promise.all(Array.from({ length: people }, () => client()));
  const created = await send(all[0], 'room:create', { name: 'P0' });
  for (const [i, p] of all.slice(1).entries()) expect(await send(p, 'room:join', { code: (created as { code?: string }).code, name: `P${i + 1}` })).toMatchObject({ ok: true });
  expect(await send(all[0], 'room:config', { game: 'chess', decks: 1, bluffRule: 'one', stake: 0, opts })).toEqual({ ok: true });
  for (let i = 0; i < bots; i++) expect(await send(all[0], 'room:addBot')).toMatchObject({ ok: true });
  await until(() => all.every((p) => p.state?.config.game === 'chess'));
  expect(await send(all[0], 'room:start')).toEqual({ ok: true });
  await until(() => all.every((p) => p.state?.phase === 'playing' && p.state.plugged?.kind === 'chess'));
  return all;
}

describe('Chess over sockets', () => {
  it("two people play fool's mate with game:move; stale and out-of-turn moves are refused", async () => {
    const people = await room(2, 0, { color: 'black', time: '5+0', rated: 'yes' });
    const v = chessOf(people[0]);
    // the host chose black
    expect(v.players.b).toBe(people[0].state!.meId);
    // guests: never rated
    expect(v.rated).toBe(false);
    expect(v.clock).toMatchObject({ w: 300_000, b: 300_000, runningSince: null, inc: 0 });
    expect(v.abortAt).toBeGreaterThan(Date.now());
    const white = people.find((p) => p.state!.meId === v.players.w)!;
    const black = people.find((p) => p.state!.meId === v.players.b)!;
    expect(await send(black, 'game:move', { kind: 'chess', move: { type: 'move', uci: 'e7e5', ply: 0 } })).toEqual({ ok: false, error: 'Not your turn' });
    const moves = ['f2f3', 'e7e5', 'g2g4', 'd8h4'];
    for (const [i, uci] of moves.entries()) {
      const p = i % 2 === 0 ? white : black;
      expect(await send(p, 'game:move', { kind: 'chess', move: { type: 'move', uci, ply: i } })).toEqual({ ok: true });
      if (i === 1) expect(await send(white, 'game:move', { kind: 'chess', move: { type: 'move', uci: 'g2g4', ply: 1 } })).toEqual({ ok: false, error: 'The position has changed, try again' });
      await until(() => people.every((x) => chessOf(x).moves.length === i + 1));
    }
    await until(() => people.every((p) => p.state!.phase === 'over'));
    expect(chessOf(white)).toMatchObject({ status: 'over', result: { winner: 'b', reason: 'checkmate' }, sans: ['f3', 'e5', 'g4', 'Qh4#'] });
    expect(white.notes.some((n) => n.kind === 'over' && n.text === 'Checkmate. P0 wins with Black 🎉')).toBe(true);
  }, 30_000);

  it('a bot in the worker pool plays its moves and the game runs to the end', async () => {
    const [me] = await room(1, 1, { level: 1, time: 'none', variant: 'standard', color: 'white' });
    const id = me.state!.meId;
    expect(chessOf(me).players.w).toBe(id);
    expect(chessOf(me).bots.b).toBe(1);
    expect(chessOf(me).abortAt).toBeNull();
    // I play the first legal-looking move each turn; the bot answers from its worker
    const mine = ['e2e4', 'd2d4', 'g1f3', 'f1c4', 'b1c3', 'c1e3', 'd1d2', 'e1c1'];
    for (let i = 0; i < 3; i++) {
      const v = chessOf(me);
      await until(() => chessOf(me).turn === 'w' || me.state!.phase === 'over');
      if (me.state!.phase === 'over') break;
      const res = await send(me, 'game:move', { kind: 'chess', move: { type: 'move', uci: mine[i], ply: chessOf(me).moves.length } });
      if (!res.ok) break;
      await until(() => chessOf(me).moves.length >= v.moves.length + 2 || me.state!.phase === 'over', 15_000);
    }
    expect(chessOf(me).moves.length).toBeGreaterThanOrEqual(4);
    // resigning ends it
    expect(await send(me, 'game:move', { kind: 'chess', move: { type: 'resign' } })).toEqual({ ok: true });
    await until(() => me.state!.phase === 'over');
    expect(chessOf(me).result).toEqual({ winner: 'b', reason: 'resign' });
  }, 60_000);

  it('a bot answers a takeback request in a casual game', async () => {
    const [me] = await room(1, 1, { level: 2, time: '10+0', color: 'white' });
    expect(await send(me, 'game:move', { kind: 'chess', move: { type: 'move', uci: 'e2e4', ply: 0 } })).toEqual({ ok: true });
    await until(() => chessOf(me).moves.length === 2, 15_000);
    expect(await send(me, 'game:move', { kind: 'chess', move: { type: 'takeback' } })).toEqual({ ok: true });
    await until(() => chessOf(me).moves.length === 0, 5000);
    expect(chessOf(me).takebackOffer).toBeUndefined();
  }, 30_000);

  it('the server flags a side on its own timer and aborts a game whose first move never comes', async () => {
    const people = await room(2, 0, { color: 'white', time: '1+0' });
    const [w, b] = people;
    expect(await send(w, 'game:move', { kind: 'chess', move: { type: 'move', uci: 'e2e4', ply: 0 } })).toEqual({ ok: true });
    expect(await send(b, 'game:move', { kind: 'chess', move: { type: 'move', uci: 'e7e5', ply: 1 } })).toEqual({ ok: true });
    // black has 300 ms left once white moves
    const table = (server.rooms as unknown as { rooms: Map<string, { plugged: { left: { w: number; b: number } } }> }).rooms.get(w.state!.code)!;
    table.plugged.left.b = 300;
    expect(await send(w, 'game:move', { kind: 'chess', move: { type: 'move', uci: 'g1f3', ply: 2 } })).toEqual({ ok: true });
    await until(() => w.state!.phase === 'over', 5000);
    expect(chessOf(w).result).toEqual({ winner: 'w', reason: 'timeout' });
    expect(chessOf(w).clock!.b).toBe(0);

    CHESS_TIMING.firstMoveMs.bullet = 300;
    try {
      const [p] = await room(2, 0, { color: 'white', time: '2+1' });
      await until(() => p.state!.phase === 'over', 5000);
      expect(chessOf(p).result).toEqual({ winner: null, reason: 'abort' });
      expect(p.notes.some((n) => n.text === 'Game aborted. Nothing counts')).toBe(true);
    } finally {
      CHESS_TIMING.firstMoveMs.bullet = 30_000;
    }
  }, 30_000);

  it('a third person watches and sees the same board', async () => {
    const [host, other, watcher] = await Promise.all([client(), client(), client()]);
    const { code } = (await send(host, 'room:create', { name: 'H' })) as Res & { code: string };
    expect(await send(other, 'room:join', { code, name: 'O' })).toMatchObject({ ok: true });
    expect(await send(watcher, 'room:join', { code, name: 'W' })).toMatchObject({ ok: true });
    expect(await send(watcher, 'room:watch', { watching: true })).toEqual({ ok: true });
    expect(await send(host, 'room:config', { game: 'chess', decks: 1, bluffRule: 'one', stake: 0, opts: { time: 'none' } })).toEqual({ ok: true });
    expect(await send(host, 'room:start', {})).toEqual({ ok: true });
    await until(() => watcher.state?.plugged?.kind === 'chess');
    expect(watcher.state!.players.map((p) => p.id)).not.toContain(watcher.state!.meId);
    const v = chessOf(watcher);
    const white = [host, other].find((p) => p.state!.meId === v.players.w)!;
    expect(await send(watcher, 'game:move', { kind: 'chess', move: { type: 'move', uci: 'e2e4', ply: 0 } })).toMatchObject({ ok: false });
    expect(await send(white, 'game:move', { kind: 'chess', move: { type: 'move', uci: 'd2d4', ply: 0 } })).toEqual({ ok: true });
    await until(() => chessOf(watcher).moves.length === 1);
    expect(chessOf(watcher).fen).toBe(chessOf(host).fen);
  }, 30_000);
});
