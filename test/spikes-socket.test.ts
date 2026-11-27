import type { AddressInfo } from 'node:net';
import { io as connect, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBluffServer } from '../src/server.js';
import { SPIKES_SPEED, type Announcement, type RoomView, type SpikesView } from '../src/types.js';

/** states: views received, with when */
type Client = { socket: Socket; state: RoomView | null; notes: Announcement[]; states: number[] };
type Res = { ok: boolean; error?: string; code?: string };

let server: ReturnType<typeof createBluffServer>;
let url = '';
const opened: Client[] = [];

beforeAll(async () => {
  // real pace: warnings, strikes and bots on the real clock
  server = createBluffServer({ limits: { createsPerIp: 10_000, liveRoomsPerIp: 10_000 }, botSpeed: 1 });
  await new Promise<void>((resolve) => server.httpServer.listen(0, resolve));
  url = `http://localhost:${(server.httpServer.address() as AddressInfo).port}`;
});

afterAll(() => {
  opened.forEach((c) => c.socket.disconnect());
  server.close();
});

async function client(): Promise<Client> {
  const c: Client = { socket: connect(url, { transports: ['websocket'], forceNew: true, auth: { rang: true, games: ['fruit', 'spikes'] } }), state: null, notes: [], states: [] };
  c.socket.on('state', (s: RoomView) => {
    c.state = s;
    c.states.push(Date.now());
  });
  c.socket.on('announce', (n: Announcement) => c.notes.push(n));
  await new Promise<void>((resolve) => c.socket.once('connect', () => resolve()));
  opened.push(c);
  return c;
}

const send = (c: Client, event: string, payload: object = {}): Promise<Res> => c.socket.timeout(2000).emitWithAck(event, payload);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(check: () => boolean, ms = 8000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await wait(5);
  }
}

const spikesOf = (c: Client): SpikesView => (c.state!.plugged as { kind: 'spikes'; spikes: SpikesView }).spikes;
const move = (c: Client, x: number, y: number) => send(c, 'game:move', { kind: 'spikes', move: { type: 'move', x, y } });

describe('Spike Attack over sockets', () => {
  it('two people: free moves at ~12 Hz pass the allowance, views are coalesced, too-far moves are clamped', async () => {
    const [a, b] = [await client(), await client()];
    const created = await send(a, 'room:create', { name: 'Asha' });
    expect(await send(b, 'room:join', { code: created.code, name: 'Bilal' })).toMatchObject({ ok: true });
    expect(await send(a, 'room:config', { game: 'spikes', decks: 1, bluffRule: 'one', stake: 0, turnTimer: true, opts: { size: 5, speed: 'normal' } })).toEqual({ ok: true });
    expect(await send(a, 'room:start')).toEqual({ ok: true });
    await until(() => [a, b].every((c) => c.state?.phase === 'playing' && c.state.plugged?.kind === 'spikes'));
    const [ida, idb] = [a.state!.meId, b.state!.meId];
    const v = spikesOf(a);
    expect(v.pos[ida]).toEqual([0.5, 0.5]);
    expect(v.pos[idb]).toEqual([4.5, 4.5]);
    expect(a.state!.turnId).toBeNull();
    expect(a.state!.turnMsLeft).toBeNull();
    expect(await move(a, 0.6, 0.5)).toEqual({ ok: false, error: 'Wait for the countdown' });
    expect(await move(a, 'x' as unknown as number, 1)).toEqual({ ok: false, error: 'Invalid move' });
    await until(() => Date.now() >= v.startsAt + 30, 5000);
    // a jump across the arena is cut back to speed × time + slack
    expect(await move(a, 4.5, 0.5)).toEqual({ ok: true });
    await until(() => spikesOf(b).pos[ida][0] > 0.5);
    expect(spikesOf(b).pos[ida][0]).toBeLessThan(0.5 + 0.35 + SPIKES_SPEED * 0.5);
    // both move at 12 Hz for ~10.5 s: past the usual 40-per-10 s limit, never "Too fast"
    const t0 = Date.now();
    const errors: string[] = [];
    let sent = 0;
    const statesBefore = b.states.length;
    let windowStates = -1;
    for (let i = 0; Date.now() - t0 < 10_500; i++) {
      const phase = (i % 48) / 48;
      const x = 2.5 + 1.8 * Math.sin(phase * 2 * Math.PI);
      const res = await Promise.all([move(a, x, 2.5), move(b, 5 - x, 2.5)]);
      sent += 2;
      for (const r of res) if (r.error) errors.push(r.error);
      // views during the first 2 s of moving: at most one push per 80 ms, plus warnings
      if (windowStates < 0 && Date.now() - t0 >= 2000) windowStates = b.states.filter((t) => t >= t0 && t < t0 + 2000).length;
      await wait(Math.max(0, 83 - ((Date.now() - t0) % 83)));
    }
    expect(sent).toBeGreaterThan(220);
    expect(errors.filter((e) => e === 'Too fast, slow down')).toEqual([]);
    // 24 moves a second would be ~48 views in 2 s uncoalesced
    expect(windowStates).toBeGreaterThan(8);
    expect(windowStates).toBeLessThanOrEqual(2000 / 80 + 4);
    expect(b.states.length).toBeGreaterThan(statesBefore);
    // B's view follows A moving on the middle row
    expect(spikesOf(b).pos[ida][1]).toBeCloseTo(2.5, 3);
    const texts = a.notes.map((n) => n.text);
    expect(texts).toContain('Dodge the spikes! 🔺');
    // sparse: no line per move, warning or hit
    expect(texts.length).toBeLessThan(8);
  }, 30_000);

  it('a bot runs freely by itself', async () => {
    const a = await client();
    await send(a, 'room:create', { name: 'Asha' });
    await send(a, 'room:config', { game: 'spikes', decks: 1, bluffRule: 'one', stake: 0, botLevel: 'expert', opts: { size: 6 } });
    expect(await send(a, 'room:addBot')).toMatchObject({ ok: true });
    expect(await send(a, 'room:start')).toEqual({ ok: true });
    await until(() => a.state?.plugged?.kind === 'spikes');
    const bot = a.state!.players.find((p) => p.bot)!.id;
    expect(spikesOf(a).pos[bot]).toEqual([5.5, 5.5]);
    await until(() => spikesOf(a).pos[bot].join() !== '5.5,5.5' || a.state!.phase === 'over', 20_000);
    const p = spikesOf(a).pos[bot];
    // somewhere between box centres while it runs, or already arrived
    expect(p.every((n) => n >= 0.32 && n <= 6 - 0.32)).toBe(true);
  }, 30_000);
});
