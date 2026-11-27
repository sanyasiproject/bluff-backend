import type { AddressInfo } from 'node:net';
import { io as connect, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { onScreen } from '../src/games/fruit/game.js';
import { createBluffServer } from '../src/server.js';
import { fruitWave, type Announcement, type FruitView, type RoomView } from '../src/types.js';

type Client = { socket: Socket; state: RoomView | null; notes: Announcement[]; states: number };
type Res = { ok: boolean; error?: string; code?: string };

let server: ReturnType<typeof createBluffServer>;
let url = '';
const opened: Client[] = [];

beforeAll(async () => {
  // timed steps at 0.15 pace: a 45 s game with no bots ends ~7 s after the start; slices are still checked on the real clock
  server = createBluffServer({ limits: { createsPerIp: 10_000, liveRoomsPerIp: 10_000 }, botSpeed: 0.15 });
  await new Promise<void>((resolve) => server.httpServer.listen(0, resolve));
  url = `http://localhost:${(server.httpServer.address() as AddressInfo).port}`;
});

afterAll(() => {
  opened.forEach((c) => c.socket.disconnect());
  server.close();
});

async function client(): Promise<Client> {
  const c: Client = { socket: connect(url, { transports: ['websocket'], forceNew: true, auth: { rang: true, games: ['fruit', 'spikes'] } }), state: null, notes: [], states: 0 };
  c.socket.on('state', (s: RoomView) => {
    c.state = s;
    c.states++;
  });
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

const fruitOf = (c: Client): FruitView => (c.state!.plugged as { kind: 'fruit'; fruit: FruitView }).fruit;
const slice = (c: Client, ids: number[], at: number) => send(c, 'game:move', { kind: 'fruit', move: { type: 'slice', ids, at } });

describe('Fruit Slice Duel over sockets', () => {
  it('two people: countdown, slices checked on the server clock, a fast move allowance, then time up', async () => {
    const [a, b] = [await client(), await client()];
    const created = await send(a, 'room:create', { name: 'Asha' });
    expect(await send(b, 'room:join', { code: created.code, name: 'Bilal' })).toMatchObject({ ok: true });
    expect(await send(a, 'room:config', { game: 'fruit', decks: 1, bluffRule: 'one', stake: 0, botLevel: 'expert', opts: { time: 45 } })).toEqual({ ok: true });
    expect(await send(a, 'room:start')).toEqual({ ok: true });
    await until(() => [a, b].every((c) => c.state?.phase === 'playing' && c.state.plugged?.kind === 'fruit'));
    const v = fruitOf(a);
    expect(v.phase).toBe('countdown');
    expect(a.state!.turnId).toBeNull();
    expect(a.state!.turnMsLeft).toBeNull();
    expect(Math.abs(v.now - Date.now())).toBeLessThan(1000);
    expect(await slice(a, [1], 0)).toEqual({ ok: false, error: 'Wait for the countdown' });
    const wave = fruitWave(v.seed, v.seconds);
    // wait (real time) for the first fruit to be up, then cut it
    const f = wave.find((x) => x.kind !== 'bomb')!;
    const elapsed = () => Date.now() - v.startsAt;
    await until(() => onScreen(f, elapsed()) && elapsed() > f.t + 300, 10_000);
    const at = elapsed();
    expect(await slice(a, [f.id], at)).toEqual({ ok: true });
    await until(() => fruitOf(b).sliced[a.state!.meId].includes(f.id));
    expect(await slice(a, [f.id], elapsed())).toEqual({ ok: false, error: 'Already sliced' });
    expect(await slice(b, [f.id], at - 1000)).toEqual({ ok: false, error: 'Too late, that swipe did not count' });
    expect(await slice(b, [f.id], elapsed() + 1000)).toEqual({ ok: false, error: 'That swipe is ahead of the clock' });
    expect(await send(b, 'game:move', { kind: 'fruit', move: { type: 'slice', ids: [], at } })).toEqual({ ok: false, error: 'Invalid move' });
    // ~10 swipes a second get through (the usual limit is 40 events per 10 s for everything)
    const burst = await Promise.all(Array.from({ length: 80 }, () => slice(b, [f.id + 1000], elapsed())));
    expect(burst.some((r) => r.error === 'Too fast, slow down')).toBe(false);
    await until(() => a.state!.phase === 'over', 15_000);
    const end = fruitOf(a);
    expect(end.phase).toBe('over');
    expect(end.scores[a.state!.meId]).toBeGreaterThan(0);
    expect(a.state!.winnerIds.length).toBeGreaterThan(0);
    await until(() => a.notes.some((n) => n.kind === 'over'));
    const texts = a.notes.map((n) => n.text);
    expect(texts).toContain('Slice! 45 seconds on the clock 🍉');
    expect(texts.some((t) => /^Time's up! .+ (wins|share first) with .+ points 🎉$/.test(t))).toBe(true);
    // sparse: no line per slice
    expect(texts.length).toBeLessThan(15);
  }, 30_000);

  it('a bot slices by itself on the shared wave', async () => {
    const a = await client();
    await send(a, 'room:create', { name: 'Asha' });
    await send(a, 'room:config', { game: 'fruit', decks: 1, bluffRule: 'one', stake: 0, botLevel: 'expert' });
    expect(await send(a, 'room:addBot')).toMatchObject({ ok: true });
    expect(await send(a, 'room:start')).toEqual({ ok: true });
    await until(() => a.state?.plugged?.kind === 'fruit');
    const bot = a.state!.players.find((p) => p.bot)!.id;
    await until(() => fruitOf(a).sliced[bot].length > 0, 15_000);
    const v = fruitOf(a);
    const wave = fruitWave(v.seed, v.seconds);
    expect(v.sliced[bot].every((id) => wave.some((f) => f.id === id))).toBe(true);
    expect(v.scores[bot]).not.toBe(0);
  }, 20_000);

  it('the generic limit still holds once a burst goes past the game allowance', async () => {
    const [a, b] = [await client(), await client()];
    const created = await send(a, 'room:create', { name: 'Asha' });
    await send(b, 'room:join', { code: created.code, name: 'Bilal' });
    await send(a, 'room:config', { game: 'fruit', decks: 1, bluffRule: 'one', stake: 0 });
    expect(await send(a, 'room:start')).toEqual({ ok: true });
    await until(() => a.state?.plugged?.kind === 'fruit');
    const burst = await Promise.all(Array.from({ length: 170 }, () => slice(a, [1], 0)));
    expect(burst.filter((r) => r.error === 'Too fast, slow down').length).toBeGreaterThanOrEqual(20);
  }, 20_000);
});
