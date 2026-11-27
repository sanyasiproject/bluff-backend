import type { AddressInfo } from 'node:net';
import { io as connect, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBluffServer } from '../src/server.js';
import type { Announcement, RoomView, SpikesView } from '../src/types.js';

type Client = { socket: Socket; state: RoomView | null; notes: Announcement[] };
type Res = { ok: boolean; error?: string; code?: string };

let server: ReturnType<typeof createBluffServer>;
let url = '';
const opened: Client[] = [];

beforeAll(async () => {
  // warnings, strikes and bots at 1/10 pace; steps and safety are still checked on the real clock
  server = createBluffServer({ limits: { createsPerIp: 10_000, liveRoomsPerIp: 10_000 }, botSpeed: 0.1 });
  await new Promise<void>((resolve) => server.httpServer.listen(0, resolve));
  url = `http://localhost:${(server.httpServer.address() as AddressInfo).port}`;
});

afterAll(() => {
  opened.forEach((c) => c.socket.disconnect());
  server.close();
});

async function client(): Promise<Client> {
  const c: Client = { socket: connect(url, { transports: ['websocket'], forceNew: true, auth: { rang: true, games: ['fruit', 'spikes'] } }), state: null, notes: [] };
  c.socket.on('state', (s: RoomView) => (c.state = s));
  c.socket.on('announce', (n: Announcement) => c.notes.push(n));
  await new Promise<void>((resolve) => c.socket.once('connect', () => resolve()));
  opened.push(c);
  return c;
}

const send = (c: Client, event: string, payload: object = {}): Promise<Res> => c.socket.timeout(2000).emitWithAck(event, payload);

async function until(check: () => boolean, ms = 8000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 5));
  }
}

const spikesOf = (c: Client): SpikesView => (c.state!.plugged as { kind: 'spikes'; spikes: SpikesView }).spikes;
const step = (c: Client, dir: string) => send(c, 'game:move', { kind: 'spikes', move: { type: 'step', dir } });

describe('Spike Attack over sockets', () => {
  it('two people: countdown, steps with game:move, warnings and strikes take lives, last one standing', async () => {
    const [a, b] = [await client(), await client()];
    const created = await send(a, 'room:create', { name: 'Asha' });
    expect(await send(b, 'room:join', { code: created.code, name: 'Bilal' })).toMatchObject({ ok: true });
    expect(await send(a, 'room:config', { game: 'spikes', decks: 1, bluffRule: 'one', stake: 0, turnTimer: true, opts: { size: 5, speed: 'fast' } })).toEqual({ ok: true });
    expect(await send(a, 'room:start')).toEqual({ ok: true });
    await until(() => [a, b].every((c) => c.state?.phase === 'playing' && c.state.plugged?.kind === 'spikes'));
    const me = a.state!.meId;
    const v = spikesOf(a);
    expect(v).toMatchObject({ size: 5, lives: { [me]: 3 } });
    expect(v.pos[me]).toEqual([0, 0]);
    expect(Math.abs(v.now - Date.now())).toBeLessThan(1000);
    // no turns: no turn clock even with the turn timer on
    expect(a.state!.turnId).toBeNull();
    expect(a.state!.turnMsLeft).toBeNull();
    expect(await step(a, 'right')).toEqual({ ok: false, error: 'Wait for the countdown' });
    await until(() => Date.now() >= v.startsAt + 20, 5000);
    expect(await step(a, 'up')).toEqual({ ok: false, error: "Can't go that way" });
    expect(await step(a, 'north')).toEqual({ ok: false, error: 'Invalid move' });
    expect(await step(a, 'right')).toEqual({ ok: true });
    expect(await step(a, 'down')).toEqual({ ok: false, error: 'Too quick, one step at a time' });
    await until(() => spikesOf(b).pos[me][0] === 1);
    await new Promise((r) => setTimeout(r, 150));
    expect(await step(a, 'down')).toEqual({ ok: true });
    // a step every 140 ms gets past the socket limit (40 events per 10 s for everything else)
    const dirs = ['right', 'left'];
    for (let i = 0; i < 44; i++) {
      await new Promise((r) => setTimeout(r, 145));
      const res = await step(a, dirs[i % 2]);
      expect(res.error).not.toBe('Too fast, slow down');
      if (a.state!.phase !== 'playing' || spikesOf(a).lives[me] === 0) break;
    }
    // now both stand still until the spikes finish them
    await until(() => spikesOf(a).warnings.length > 0 || a.state!.phase === 'over');
    const w = spikesOf(a).warnings[0];
    if (w) expect(w.strikeAt).toBeGreaterThan(w.warnAt);
    await until(() => a.state!.phase === 'over', 40_000);
    const end = spikesOf(a);
    expect(end.strikes.length).toBeGreaterThan(0);
    expect(Object.values(end.lives).some((n) => n === 0)).toBe(true);
    expect(a.state!.winnerIds.length).toBeGreaterThan(0);
    await until(() => a.notes.some((n) => n.kind === 'over'));
    const texts = a.notes.map((n) => n.text);
    expect(texts).toContain('Dodge the spikes! 🔺');
    expect(texts.some((t) => /is out 💀/.test(t))).toBe(true);
    expect(texts.some((t) => /^Game over\. .+ (wins|share the win) 🎉$/.test(t))).toBe(true);
    // sparse: no line per step, warning or hit
    expect(texts.length).toBeLessThan(12);
  }, 60_000);

  it('a bot steps by itself and reacts to warnings', async () => {
    const a = await client();
    await send(a, 'room:create', { name: 'Asha' });
    await send(a, 'room:config', { game: 'spikes', decks: 1, bluffRule: 'one', stake: 0, botLevel: 'expert', opts: { size: 6 } });
    expect(await send(a, 'room:addBot')).toMatchObject({ ok: true });
    expect(await send(a, 'room:start')).toEqual({ ok: true });
    await until(() => a.state?.plugged?.kind === 'spikes');
    const bot = a.state!.players.find((p) => p.bot)!.id;
    expect(spikesOf(a).pos[bot]).toEqual([5, 5]);
    await until(() => spikesOf(a).pos[bot].join() !== '5,5' || a.state!.phase === 'over', 20_000);
    expect(a.state!.phase === 'over' || spikesOf(a).pos[bot].join() !== '5,5').toBe(true);
  }, 30_000);
});
