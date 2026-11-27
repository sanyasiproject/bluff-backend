import type { AddressInfo } from 'node:net';
import { io as connect, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FRUIT_BOT } from '../src/games/fruit/game.js';
import { createBluffServer } from '../src/server.js';
import { FRUIT_SLOW_MS, type Announcement, type FruitView, type RoomView } from '../src/types.js';

/** seen: when each item first reached this phone (its "paint" time) */
type Client = { socket: Socket; state: RoomView | null; notes: Announcement[]; seen: Map<number, number> };
type Res = { ok: boolean; error?: string; code?: string };

let server: ReturnType<typeof createBluffServer>;
let url = '';
const opened: Client[] = [];

beforeAll(async () => {
  // timed steps at 0.3 pace (an item closes ~750 ms after it shows with no strikes); strikes are still checked on the real clock
  server = createBluffServer({ limits: { createsPerIp: 10_000, liveRoomsPerIp: 10_000 }, botSpeed: 0.3 });
  await new Promise<void>((resolve) => server.httpServer.listen(0, resolve));
  url = `http://localhost:${(server.httpServer.address() as AddressInfo).port}`;
});

afterAll(() => {
  opened.forEach((c) => c.socket.disconnect());
  server.close();
});

const fruitOf = (c: Client): FruitView => (c.state!.plugged as { kind: 'fruit'; fruit: FruitView }).fruit;

async function client(): Promise<Client> {
  const c: Client = { socket: connect(url, { transports: ['websocket'], forceNew: true, auth: { rang: true, games: ['fruit', 'spikes'] } }), state: null, notes: [], seen: new Map() };
  c.socket.on('state', (s: RoomView) => {
    c.state = s;
    const item = s.plugged?.kind === 'fruit' ? s.plugged.fruit.item : null;
    if (item && !c.seen.has(item.round)) c.seen.set(item.round, Date.now());
  });
  c.socket.on('announce', (n: Announcement) => c.notes.push(n));
  await new Promise<void>((resolve) => c.socket.once('connect', () => resolve()));
  opened.push(c);
  return c;
}

const send = (c: Client, event: string, payload: object = {}): Promise<Res> => c.socket.timeout(2000).emitWithAck(event, payload);
const strike = (c: Client, round: number, reaction: number) => send(c, 'game:move', { kind: 'fruit', move: { type: 'strike', round, reaction } });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(check: () => boolean, ms = 8000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await wait(5);
  }
}

describe('Fruit Slice Duel over sockets', () => {
  it('two people: items one at a time, strikes judged by reaction, refusals, to the last item', async () => {
    const [a, b] = [await client(), await client()];
    const created = await send(a, 'room:create', { name: 'Asha' });
    expect(await send(b, 'room:join', { code: created.code, name: 'Bilal' })).toMatchObject({ ok: true });
    expect(await send(a, 'room:config', { game: 'fruit', decks: 1, bluffRule: 'one', stake: 0, opts: { rounds: 15 } })).toEqual({ ok: true });
    expect(await send(a, 'room:start')).toEqual({ ok: true });
    await until(() => [a, b].every((c) => c.state?.phase === 'playing' && c.state.plugged?.kind === 'fruit'));
    const [ida, idb] = [a.state!.meId, b.state!.meId];
    const v = fruitOf(a);
    expect(v).toMatchObject({ phase: 'countdown', round: 0, rounds: 15, item: null, result: null });
    expect(a.state!.turnId).toBeNull();
    expect(Math.abs(v.now - Date.now())).toBeLessThan(1000);
    expect(await strike(a, 1, 300)).toEqual({ ok: false, error: 'Wait for the countdown' });
    for (let round = 1; round <= 15; round++) {
      await until(() => a.seen.has(round) && b.seen.has(round), 10_000);
      await wait(230);
      const ra = Date.now() - a.seen.get(round)!;
      const rb = Date.now() - b.seen.get(round)!;
      if (round === 1) {
        expect(await strike(b, 1, 50)).toEqual({ ok: false, error: 'Too fast to be real, that strike did not count' });
        expect(await strike(b, 1, 9_000)).toEqual({ ok: false, error: "That strike doesn't match the clock, it did not count" });
        expect(await strike(b, 2, 300)).toEqual({ ok: false, error: 'Wait for the item to show' });
      }
      // A claims 200 ms, B 100 ms slower
      expect(await strike(a, round, Math.min(ra, 200))).toEqual({ ok: true });
      if (round === 1) expect(await strike(a, 1, 200)).toEqual({ ok: false, error: 'You already struck this one' });
      expect(await strike(b, round, Math.min(rb, 300))).toEqual({ ok: true });
      // both struck: the item closes at once
      await until(() => fruitOf(a).result?.round === round);
      const r = fruitOf(a).result!;
      expect(r.reactions[ida]! % FRUIT_SLOW_MS).toBe(200 % FRUIT_SLOW_MS);
      if (r.kind === 'magnet') expect(r.slowed.sort()).toEqual([ida, idb].sort());
      else if (fruitOf(a).slow[ida] === 0 && r.reactions[ida] === 200) expect(r.winner).toBe(ida);
      if (round === 1) expect(await strike(b, 1, 250)).toEqual({ ok: false, error: 'Too late, that item is over' });
    }
    await until(() => a.state!.phase === 'over', 10_000);
    expect(fruitOf(a).phase).toBe('over');
    expect(a.state!.winnerIds.length).toBeGreaterThan(0);
    await until(() => a.notes.some((n) => n.kind === 'over'));
    const texts = a.notes.map((n) => n.text);
    expect(texts).toContain('Swords ready! 15 items, fastest strike takes the fruit. Never cut the magnet 🧲');
    expect(texts.some((t) => /^Game over! .+ (wins|share first) with .+ points 🎉$/.test(t))).toBe(true);
    // sparse: no line per item
    expect(texts.length).toBeLessThan(10);
  }, 60_000);

  it('a bot strikes by itself, at its level\'s reaction', async () => {
    const a = await client();
    await send(a, 'room:create', { name: 'Asha' });
    await send(a, 'room:config', { game: 'fruit', decks: 1, bluffRule: 'one', stake: 0, botLevel: 'expert' });
    expect(await send(a, 'room:addBot')).toMatchObject({ ok: true });
    expect(await send(a, 'room:start')).toEqual({ ok: true });
    await until(() => a.state?.plugged?.kind === 'fruit');
    const bot = a.state!.players.find((p) => p.bot)!.id;
    await until(() => (fruitOf(a).result?.reactions[bot] ?? null) !== null, 20_000);
    const r = fruitOf(a).result!.reactions[bot]!;
    const [lo, hi] = FRUIT_BOT.expert.reaction;
    expect((r >= lo && r <= hi) || (r >= lo + FRUIT_SLOW_MS && r <= hi + FRUIT_SLOW_MS)).toBe(true);
  }, 30_000);

  it('the strike allowance holds: a burst past it is cut off', async () => {
    const [a, b] = [await client(), await client()];
    const created = await send(a, 'room:create', { name: 'Asha' });
    await send(b, 'room:join', { code: created.code, name: 'Bilal' });
    await send(a, 'room:config', { game: 'fruit', decks: 1, bluffRule: 'one', stake: 0 });
    expect(await send(a, 'room:start')).toEqual({ ok: true });
    await until(() => a.state?.plugged?.kind === 'fruit');
    const burst = await Promise.all(Array.from({ length: 120 }, () => strike(a, 1, 300)));
    expect(burst.filter((r) => r.error === 'Too fast, slow down').length).toBeGreaterThanOrEqual(50);
  }, 20_000);
});
