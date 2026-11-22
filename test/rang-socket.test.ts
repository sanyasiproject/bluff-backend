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

async function client(at = url): Promise<Client> {
  const c: Client = { socket: connect(at, { transports: ['websocket'], forceNew: true, auth: { rang: true } }), state: null, notes: [] };
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
    // the limit is per second: back off a little more each time
    await new Promise((r) => setTimeout(r, 300 + 100 * i));
  }
}

async function until(check: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 5));
  }
}

const RANG = { game: 'rang', decks: 1, bluffRule: 'one', stake: 0, rangPicks: 2, rangStack: true, rangChallenge: true, rangSwap: true };

/** a room of people playing Rang */
async function rangRoom(names: string[]) {
  const people = await Promise.all(names.map(() => client()));
  const created = await send(people[0], 'room:create', { name: names[0] });
  for (const [i, p] of people.slice(1).entries()) expect(await send(p, 'room:join', { code: created.code, name: names[i + 1] })).toMatchObject({ ok: true });
  expect(await send(people[0], 'room:config', RANG)).toEqual({ ok: true });
  await until(() => people.every((p) => p.state?.config.game === 'rang'));
  expect(await send(people[0], 'room:start')).toEqual({ ok: true });
  await until(() => people.every((p) => p.state?.phase === 'playing' && p.state.rang !== null));
  return people;
}

const moveId = (v: RoomView) => v.rang?.last?.id ?? 0;
const sameMoment = (people: Client[]) => {
  const a = people[0].state!;
  return people.every((x) => x.state!.phase === a.phase && x.state!.turnId === a.turnId && moveId(x.state!) === moveId(a));
};

/** the player on turn makes one simple, legal move */
async function step(people: Client[]) {
  await until(() => sameMoment(people));
  if (people[0].state!.phase !== 'playing') return;
  const p = people.find((x) => x.state!.meId === people[0].state!.turnId)!;
  const v = p.state!.rang!;
  let before = moveId(p.state!);
  if (v.auto) {
    await until(() => people.every((x) => moveId(x.state!) > before || x.state!.phase === 'over'));
    return;
  }
  if (v.canCall) {
    expect(await send(p, 'rang:call')).toEqual({ ok: true });
    await until(() => people.every((x) => moveId(x.state!) > before));
    before = moveId(p.state!);
  }
  let res: Res;
  if (v.canChallenge) res = await send(p, 'rang:challenge');
  else if (v.playable.length > 0) {
    const card = v.hand.find((c) => c.id === v.playable[0])!;
    const other = p.state!.players.find((x) => x.id !== p.state!.meId && x.cardCount > 0)!;
    res = await send(p, 'rang:play', { cardId: card.id, color: card.color === null ? 'green' : undefined, targetId: card.value === '7' && v.hand.length > 1 ? other.id : undefined });
  } else res = v.canPass ? await send(p, 'rang:pass') : await send(p, 'rang:pick');
  expect(res.error ?? "ok").toBe("ok");
  await until(() => people.every((x) => moveId(x.state!) > before || x.state!.phase === 'over'));
}

describe('rang over sockets', () => {
  it('plays a whole game: only the player on turn moves, hands stay private, first out wins', async () => {
    const people = await rangRoom(['Asha', 'Ravi', 'Meena']);
    for (const p of people) {
      const others = people.filter((x) => x !== p).flatMap((x) => x.state!.rang!.hand.map((c) => c.id));
      expect(others.some((id) => JSON.stringify(p.state).includes(`"${id}"`))).toBe(false);
      expect(p.state!.hand).toEqual([]);
    }
    const idle = people.find((p) => p.state!.meId !== p.state!.turnId)!;
    expect(await send(idle, 'rang:pick')).toEqual({ ok: false, error: 'Not your turn' });
    expect(await send(idle, 'rang:play', { cardId: 'bogus' })).toEqual({ ok: false, error: 'Invalid card' });
    expect(await send(idle, 'rang:play', { cardId: 'rg-red-5-1', color: 'pink' })).toEqual({ ok: false, error: 'Invalid colour' });
    expect(await send(people[0], 'c7:pick')).toMatchObject({ ok: false });
    expect(await send(people[0], 'room:end')).toMatchObject({ ok: false });

    for (let i = 0; i < 800 && people[0].state!.phase === 'playing'; i++) await step(people);
    await until(() => people.every((p) => p.state!.phase === 'over'));
    const v = people[0].state!;
    expect(v.winnerIds).toHaveLength(1);
    expect(v.loserIds.length).toBeGreaterThanOrEqual(1);
    expect(people[0].notes.some((n) => n.kind === 'play' && / played /.test(n.text))).toBe(true);
    expect(people[0].notes.some((n) => n.kind === 'over' && / wins$/.test(n.text))).toBe(true);
  }, 60_000);

  it('runs a game of one person and bots to the end', async () => {
    const [me] = await Promise.all([client()]);
    const created = await send(me, 'room:create', { name: 'Solo' });
    expect(await send(me, 'room:addBot')).toMatchObject({ ok: true });
    expect(await send(me, 'room:addBot')).toMatchObject({ ok: true });
    expect(await send(me, 'room:config', RANG)).toEqual({ ok: true });
    expect(await send(me, 'room:start')).toEqual({ ok: true });
    void created;
    for (let i = 0; i < 800 && me.state?.phase !== 'over'; i++) {
      await until(() => me.state!.phase === 'over' || (me.state!.turnId === me.state!.meId && !me.state!.rang!.auto), 20_000);
      if (me.state!.phase === 'over') break;
      await step([me]);
    }
    expect(me.state!.phase).toBe('over');
  }, 90_000);
});
