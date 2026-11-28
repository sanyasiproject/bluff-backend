import type { AddressInfo } from 'node:net';
import { io as connect, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchOf, simulate } from '../src/carrom/index.js';
import { createBluffServer } from '../src/server.js';
import { BOMB_ARROWS, SEA_FLEET, type Announcement, type BombTask, type BombView, type CarromView, type RoomView, type SeaView } from '../src/types.js';

type Client = { socket: Socket; state: RoomView | null; notes: Announcement[] };
type Res = { ok: boolean; error?: string; code?: string };
const GAMES = ['carrom', 'bomb', 'seabattle'];

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

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean, ms = 8000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await wait(5);
  }
}

async function room(game: string, people: number, bots: number, opts: object) {
  const all = await Promise.all(Array.from({ length: people }, () => client()));
  const created = await send(all[0], 'room:create', { name: 'P0' });
  for (const [i, p] of all.slice(1).entries()) expect(await send(p, 'room:join', { code: created.code, name: `P${i + 1}` })).toMatchObject({ ok: true });
  expect(await send(all[0], 'room:config', { game, decks: 1, bluffRule: 'one', stake: 0, opts })).toEqual({ ok: true });
  for (let i = 0; i < bots; i++) expect(await send(all[0], 'room:addBot')).toMatchObject({ ok: true });
  await until(() => all.every((p) => p.state?.config.game === game));
  expect(await send(all[0], 'room:start')).toEqual({ ok: true });
  await until(() => all.every((p) => p.state?.phase === 'playing' && p.state.plugged?.kind === game));
  return all;
}

const carromOf = (c: Client) => (c.state!.plugged as { kind: 'carrom'; carrom: CarromView }).carrom;
const bombOf = (c: Client) => (c.state!.plugged as { kind: 'bomb'; bomb: BombView }).bomb;
const seaOf = (c: Client) => (c.state!.plugged as { kind: 'seabattle'; seabattle: SeaView }).seabattle;
const me = (c: Client) => c.state!.meId;

describe('Carrom over sockets', () => {
  it('two people: the break, the same board for both, the wait while coins roll', async () => {
    const people = await room('carrom', 2, 0, { mode: 'classic', length: 'quick' });
    const v = carromOf(people[0]);
    expect(v.coins).toHaveLength(19);
    expect(v.colors![v.turnId!]).toBe('w');
    const up = people.find((p) => me(p) === carromOf(p).turnId)!;
    const idle = people.find((p) => p !== up)!;
    expect(await send(idle, 'game:move', { kind: 'carrom', move: { type: 'shot', x: 0.5, dx: 0, dy: 1, power: 1 } })).toEqual({ ok: false, error: 'Not your turn' });
    expect(await send(up, 'game:move', { kind: 'carrom', move: { type: 'shot', x: 'a' } })).toEqual({ ok: false, error: 'Invalid shot' });
    expect(await send(up, 'game:move', { kind: 'carrom', move: { type: 'shot', x: 0.5, dx: 0, dy: 1, power: 1 } })).toEqual({ ok: true });
    await until(() => people.every((p) => carromOf(p).last?.seq === 1));
    const last = carromOf(idle).last!;
    // every phone replays the same shot to the same end
    const again = simulate(last.before, launchOf(last.side, last.x, last.dx, last.dy, last.power));
    expect(again.pocketed).toEqual(last.pocketed);
    if (last.returned.length === 0) expect(again.coins).toEqual(carromOf(idle).coins);
    expect(carromOf(idle).coins).toEqual(carromOf(up).coins);
    const next = people.find((p) => me(p) === carromOf(p).turnId)!;
    expect(await send(next, 'game:move', { kind: 'carrom', move: { type: 'shot', x: 0.5, dx: 0, dy: 1, power: 0.5 } })).toMatchObject({ ok: false, error: 'Wait for the coins to stop' });
    // time runs out (pauses run at 1/20 pace here): a soft straight shot goes for them
    await until(() => people.every((p) => carromOf(p).last?.seq === 2), 10_000);
    expect(carromOf(next).last).toMatchObject({ auto: true, playerId: me(next), dx: 0, dy: 1, power: 0.3 });
  }, 60_000);

  it('a bot takes its own shots', async () => {
    const [p] = await room('carrom', 1, 1, { mode: 'freestyle', length: 'quick' });
    const bot = p.state!.players.find((x) => x.id !== me(p))!.id;
    if (carromOf(p).turnId === me(p)) expect(await send(p, 'game:move', { kind: 'carrom', move: { type: 'shot', x: 0.5, dx: 0, dy: 1, power: 0.9 } })).toEqual({ ok: true });
    await until(() => carromOf(p).last?.playerId === bot, 20_000);
  }, 60_000);
});

/** what a test player would tap: solved where it can be, else the first choice */
function solve(t: BombTask): number {
  if (t.kind === 'sum') {
    const [a, op, b] = t.prompt.split(' ');
    return t.choices.indexOf(String(op === '+' ? Number(a) + Number(b) : Number(a) - Number(b)));
  }
  if (t.kind === 'bigger') return Number(t.choices[0]) > Number(t.choices[1]) ? 0 : 1;
  if (t.kind === 'colour') return t.choices.indexOf(t.ink!);
  if (t.kind === 'count') return t.choices.indexOf(String(t.dots!.length));
  if (t.kind === 'arrow') return BOMB_ARROWS.indexOf(t.arrow!);
  return 0;
}

describe('Bomb Pass over sockets', () => {
  it('two people pass the bomb by solving tasks; the fuse stays hidden', async () => {
    const people = await room('bomb', 2, 0, { hearts: 2, speed: 'fast' });
    await until(() => bombOf(people[0]).phase === 'play');
    const raw = JSON.stringify(people[0].state);
    expect(raw).not.toContain('fuse');
    expect(raw).not.toContain('answer');
    let passes = 0;
    for (let i = 0; i < 40 && passes < 3 && people[0].state!.phase === 'playing'; i++) {
      const holder = people.find((p) => bombOf(p).holder === me(p));
      const v = holder && bombOf(holder);
      if (!holder || !v?.task || v.shakeUntil > v.now) {
        await wait(20);
        continue;
      }
      const res = await send(holder, 'game:move', { kind: 'bomb', move: { type: 'answer', task: v.task.id, choice: solve(v.task) } });
      expect(res).toEqual({ ok: true });
      await until(() => bombOf(holder).task?.id !== v.task!.id || bombOf(holder).phase !== 'play');
      if (bombOf(holder).lastPass?.from === me(holder)) passes++;
    }
    expect(passes).toBeGreaterThan(0);
  }, 60_000);

  it('with a bot: booms and hearts until one is left', async () => {
    const [p] = await room('bomb', 1, 1, { hearts: 2, speed: 'fast' });
    await until(() => p.state!.phase === 'over', 40_000);
    expect(p.state!.winnerIds).toHaveLength(1);
    expect(p.notes.some((n) => /BOOM!/.test(n.text))).toBe(true);
  }, 60_000);
});

describe('Sea Battle over sockets', () => {
  it('two people place and ready, see only their own ships, and fire', async () => {
    const people = await room('seabattle', 2, 0, { powers: 'on' });
    const fleet = SEA_FLEET.map((len, i) => ({ x: 0, y: i * 2, len, v: false }));
    expect(await send(people[0], 'game:move', { kind: 'seabattle', move: { type: 'place', ships: fleet.slice(1) } })).toMatchObject({ ok: false });
    expect(await send(people[0], 'game:move', { kind: 'seabattle', move: { type: 'place', ships: fleet } })).toEqual({ ok: true });
    expect(await send(people[1], 'game:move', { kind: 'seabattle', move: { type: 'place' } })).toEqual({ ok: true });
    for (const p of people) expect(await send(p, 'game:move', { kind: 'seabattle', move: { type: 'ready' } })).toEqual({ ok: true });
    await until(() => people.every((p) => seaOf(p).phase === 'battle'));
    const [a, b] = people;
    expect(seaOf(a).seas[me(a)].ships).toHaveLength(5);
    expect(seaOf(a).seas[me(b)].ships).toEqual([]);
    expect(seaOf(b).seas[me(a)].ships).toEqual([]);
    const up = people.find((p) => seaOf(p).turnId === me(p))!;
    const other = people.find((p) => p !== up)!;
    expect(await send(up, 'game:move', { kind: 'seabattle', move: { type: 'fire', target: me(other), x: 9, y: 9 } })).toEqual({ ok: true });
    await until(() => seaOf(other).last?.by === me(up));
    expect(seaOf(other).seas[me(other)].shots[99]).toBeGreaterThan(0);
  }, 60_000);

  it('a person against a bot plays to the end', async () => {
    const [p] = await room('seabattle', 1, 1, { powers: 'off' });
    expect(await send(p, 'game:move', { kind: 'seabattle', move: { type: 'ready' } })).toEqual({ ok: true });
    await until(() => seaOf(p).phase === 'battle', 10_000);
    const bot = p.state!.players.find((x) => x.id !== me(p))!.id;
    for (let i = 0; i < 400 && p.state!.phase === 'playing'; i++) {
      const v = seaOf(p);
      if (v.turnId !== me(p)) {
        await wait(10);
        continue;
      }
      const c = v.seas[bot].shots.findIndex((s) => s === 0);
      const res = await send(p, 'game:move', { kind: 'seabattle', move: { type: 'fire', target: bot, x: c % 10, y: Math.floor(c / 10) } });
      if (!res.ok) await wait(10);
    }
    await until(() => p.state!.phase === 'over', 20_000);
    expect(p.state!.winnerIds).toHaveLength(1);
  }, 90_000);
});
