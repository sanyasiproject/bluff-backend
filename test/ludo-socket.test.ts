import type { AddressInfo } from 'node:net';
import { io as connect, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBluffServer } from '../src/server.js';
import type { Announcement, RoomView } from '../src/types.js';

type Client = { socket: Socket; state: RoomView | null; notes: Announcement[] };
type Res = { ok: boolean; error?: string; code?: string; token?: string };

let server: ReturnType<typeof createBluffServer>;
let url = '';
const opened: Client[] = [];

beforeAll(async () => {
  server = createBluffServer({ limits: { createsPerIp: 10_000, liveRoomsPerIp: 10_000 }, botSpeed: 0.01 });
  await new Promise<void>((resolve) => server.httpServer.listen(0, resolve));
  url = `http://localhost:${(server.httpServer.address() as AddressInfo).port}`;
});

afterAll(() => {
  opened.forEach((c) => c.socket.disconnect());
  server.close();
});

/** games: what the app says it has in the handshake (older apps send nothing) */
async function client(games?: string[]): Promise<Client> {
  const c: Client = { socket: connect(url, { transports: ['websocket'], forceNew: true, auth: { rang: true, ...(games ? { games } : {}) } }), state: null, notes: [] };
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

const LUDO = { game: 'ludo', decks: 1, bluffRule: 'one', stake: 0, opts: { mode: 'quick' } };
const key = (v: RoomView) => {
  const l = v.plugged?.ludo;
  return `${v.phase}|${l?.rollSeq}|${l?.last?.seq}|${l?.turnId}|${l?.rolled}`;
};

/** the person on turn rolls, or picks a goti when there's a real choice; the room plays forced steps and bots */
async function step(people: Client[]) {
  await until(() => people.every((p) => key(p.state!) === key(people[0].state!)));
  const v = people[0].state!;
  if (v.phase !== 'playing') return;
  const l = v.plugged!.ludo;
  const before = key(v);
  const p = people.find((x) => x.state!.meId === l.turnId);
  const seat = l.seats.find((s) => s.playerId === l.movesFor)!;
  const choices = new Set(l.movable.map((t) => seat.tokens[t])).size;
  if (p && !l.rolled) expect(await send(p, 'game:move', { kind: 'ludo', move: { type: 'roll' } })).toEqual({ ok: true });
  else if (p && choices > 1) expect(await send(p, 'game:move', { kind: 'ludo', move: { type: 'move', token: l.movable[0] } })).toEqual({ ok: true });
  await until(() => people.every((x) => key(x.state!) !== before), 10_000);
}

async function ludoRoom(apps: (string[] | undefined)[]) {
  const people = await Promise.all(apps.map((a) => client(a)));
  const created = await send(people[0], 'room:create', { name: 'P0' });
  for (const [i, p] of people.slice(1).entries()) expect(await send(p, 'room:join', { code: created.code, name: `P${i + 1}` })).toMatchObject({ ok: true });
  expect(await send(people[0], 'room:config', LUDO)).toEqual({ ok: true });
  await until(() => people.every((p) => p.state?.config.game === 'ludo'));
  return people;
}

describe('ludo over sockets', () => {
  it('plays a whole Quick game with game:move: only the player on turn moves, bad moves come back as errors', async () => {
    const people = await ludoRoom([['ludo'], ['ludo', 'chess']]);
    expect(people[0].state!.config.opts).toEqual({ mode: 'quick' });
    expect(await send(people[0], 'room:start')).toEqual({ ok: true });
    await until(() => people.every((p) => p.state?.phase === 'playing' && p.state.plugged?.kind === 'ludo'));
    const v = people[0].state!.plugged!.ludo;
    expect(v.mode).toBe('quick');
    expect(v.seats.map((s) => s.color)).toEqual(['red', 'yellow']);
    const idle = people.find((p) => p.state!.meId !== v.turnId)!;
    expect(await send(idle, 'game:move', { kind: 'ludo', move: { type: 'roll' } })).toEqual({ ok: false, error: 'Not your turn' });
    expect(await send(idle, 'game:move', { kind: 'chess', move: { type: 'roll' } })).toEqual({ ok: false, error: 'That move is for another game' });
    expect(await send(idle, 'game:move', { kind: 'ludo', move: { type: 'move', token: 9 } })).toEqual({ ok: false, error: 'Pick one of your gotis' });
    expect(await send(idle, 'game:move', { kind: 'ludo' })).toEqual({ ok: false, error: 'Invalid move' });
    expect(await send(people[0], 'rang:pick')).toMatchObject({ ok: false });
    expect(await send(people[0], 'room:end')).toEqual({ ok: false, error: 'Ludo plays to the end. Use Stop game instead' });

    for (let i = 0; i < 3000 && people[0].state!.phase === 'playing'; i++) await step(people);
    await until(() => people.every((p) => p.state!.phase === 'over'));
    const end = people[0].state!;
    expect(end.winnerIds).toHaveLength(1);
    expect(end.loserIds).toHaveLength(1);
    expect(end.plugged!.ludo.seats.find((s) => s.playerId === end.winnerIds[0])!.home).toBe(2);
    expect(people[0].notes.some((n) => n.kind === 'over' && /wins 🎉$/.test(n.text))).toBe(true);
    // game:move is refused once the game is over
    expect(await send(people[0], 'game:move', { kind: 'ludo', move: { type: 'roll' } })).toEqual({ ok: false, error: 'No game in progress' });
  }, 120_000);

  it("refuses to start Ludo while a person's app doesn't have it", async () => {
    const people = await ludoRoom([['ludo'], undefined]);
    expect(await send(people[0], 'room:start')).toEqual({ ok: false, error: 'P1 must update the app (reload it) to play Ludo' });
  });

  it('a bot plays its own turns, and the turn timer rolls and moves for a person who does nothing', async () => {
    const [me] = await ludoRoom([['ludo']]);
    expect(await send(me, 'room:addBot')).toMatchObject({ ok: true });
    expect(await send(me, 'room:config', { ...LUDO, turnTimer: true })).toEqual({ ok: true });
    expect(await send(me, 'room:start')).toEqual({ ok: true });
    await until(() => me.state!.phase === 'over', 100_000);
    expect(me.notes.some((n) => /ran out of time/.test(n.text))).toBe(true);
    expect(me.state!.winnerIds).toHaveLength(1);
  }, 120_000);
});
