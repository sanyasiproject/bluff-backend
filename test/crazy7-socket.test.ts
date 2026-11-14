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
  const c: Client = { socket: connect(at, { transports: ['websocket'], forceNew: true }), state: null, notes: [] };
  c.socket.on('state', (s: RoomView) => (c.state = s));
  c.socket.on('announce', (n: Announcement) => c.notes.push(n));
  await new Promise<void>((resolve) => c.socket.once('connect', () => resolve()));
  opened.push(c);
  return c;
}

const send = (c: Client, event: string, payload: object = {}): Promise<Res> => c.socket.timeout(2000).emitWithAck(event, payload);

async function until(check: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 5));
  }
}

const C7 = { game: 'crazy7', decks: 1, bluffRule: 'one', stake: 0, handSize: 5, maxPicks: 2, stack7: true };

/** a room of people playing Crazy 7 */
async function crazyRoom(names: string[], at = url) {
  const people = await Promise.all(names.map(() => client(at)));
  const created = await send(people[0], 'room:create', { name: names[0] });
  for (const [i, p] of people.slice(1).entries()) expect(await send(p, 'room:join', { code: created.code, name: names[i + 1] })).toMatchObject({ ok: true });
  expect(await send(people[0], 'room:config', { ...C7, teams: true, peeks: 2 })).toEqual({ ok: true });
  await until(() => people.every((p) => p.state?.config.game === 'crazy7'));
  // Bluff's extras are kept for when the host switches back, and Crazy 7 ignores them (3 players start despite teams)
  expect(people[1].state!.config).toMatchObject({ teams: true, peeks: 2, handSize: 5, maxPicks: 2 });
  expect(people[1].state!.slots).toBe(null);
  expect(await send(people[0], 'room:start')).toEqual({ ok: true });
  await until(() => people.every((p) => p.state?.phase === 'playing' && p.state.crazy7 !== null));
  return people;
}

/** every view shows the same moment of the game (each player hears about a change a moment apart) */
const sameMoment = (people: Client[]) => {
  const a = people[0].state!;
  const at = (v: RoomView) => v.crazy7?.last?.id ?? 0;
  return people.every((x) => x.state!.phase === a.phase && x.state!.turnId === a.turnId && at(x.state!) === at(a));
};

/** the player on turn makes one simple, legal move */
async function step(people: Client[]) {
  // judged on a view that may lag, a move could meet a turn the room is about to play for them
  await until(() => sameMoment(people));
  if (people[0].state!.phase !== 'playing') return;
  const p = people.find((x) => x.state!.meId === people[0].state!.turnId)!;
  const v = p.state!.crazy7!;
  let before = v.last?.id ?? 0;
  // the room is about to pick or pass for them: wait for it (the refusal of a move meanwhile is checked at human pace below)
  if (v.auto) {
    await until(() => people.every((x) => (x.state!.crazy7?.last?.id ?? 0) > before || x.state!.phase === 'over'));
    return;
  }
  if (v.canCall) {
    expect(await send(p, 'c7:call')).toEqual({ ok: true });
    // wait for the call itself, so the play below is judged against the state after it
    await until(() => people.every((x) => (x.state!.crazy7?.last?.id ?? 0) > before));
    before = p.state!.crazy7!.last?.id ?? before;
  }
  const res = v.playable.length > 0 ? await send(p, 'c7:play', { cardId: v.playable[0] }) : v.canPass ? await send(p, 'c7:pass') : await send(p, 'c7:pick');
  expect(res).toEqual({ ok: true });
  await until(() => people.every((x) => (x.state!.crazy7?.last?.id ?? 0) > before || x.state!.phase === 'over'));
}

describe('crazy 7 over sockets', () => {
  it('plays a whole game: only the player on turn moves, hands stay private, first out wins', async () => {
    const people = await crazyRoom(['Asha', 'Ravi', 'Meena']);
    const hands = people.map((p) => p.state!.hand);
    expect(hands.map((h) => h.length).every((n) => n >= 5)).toBe(true);
    for (const p of people) {
      const others = hands.filter((h) => h !== p.state!.hand).flat();
      expect(others.some((card) => JSON.stringify(p.state).includes(`"${card.id}"`))).toBe(false);
      expect(p.state!.watch).toBe(null);
    }
    const idle = people.find((p) => p.state!.meId !== p.state!.turnId)!;
    expect(await send(idle, 'c7:pass')).toEqual({ ok: false, error: 'Not your turn' });
    expect(await send(idle, 'c7:play', { cardId: 'bogus' })).toEqual({ ok: false, error: 'Invalid card' });
    expect(await send(people[0], 'room:end')).toMatchObject({ ok: false });

    for (let i = 0; i < 600 && people[0].state!.phase === 'playing'; i++) await step(people);
    await until(() => people.every((p) => p.state!.phase === 'over'));
    const v = people[0].state!;
    expect(v.winnerIds).toHaveLength(1);
    expect(v.loserIds).toHaveLength(2);
    expect(people.find((p) => p.state!.meId === v.winnerIds[0])!.state!.hand).toHaveLength(0);
    expect(people[0].notes.some((n) => n.kind === 'play' && / played /.test(n.text))).toBe(true);
    expect(people[0].notes.some((n) => n.kind === 'over' && / wins$/.test(n.text))).toBe(true);

    // same table, dealt again
    expect(await send(people[0], 'room:rematch')).toEqual({ ok: true });
    await until(() => people.every((p) => p.state!.phase === 'playing' && p.state!.hand.length >= 5));
  });

  it('drops a reaction on the pile for everyone, only while a game is on', async () => {
    const [a, b] = await crazyRoom(['Neha', 'Arjun']);
    const got: unknown[] = [];
    b.socket.on('chat', (c: unknown) => got.push(c));
    expect(await send(a, 'chat:send', { kind: 'message', index: 0, on: 'pile' })).toEqual({ ok: false, error: 'Invalid message' });
    expect(await send(a, 'chat:send', { kind: 'reaction', index: 3, on: 'pile' })).toEqual({ ok: true });
    await until(() => got.length === 1);
    expect(got[0]).toEqual({ from: a.state!.meId, kind: 'reaction', index: 3, on: 'pile' });
    expect(await send(a, 'room:lobby')).toEqual({ ok: true });
    await until(() => a.state!.phase === 'lobby');
    await new Promise((r) => setTimeout(r, 750));
    expect(await send(a, 'chat:send', { kind: 'reaction', index: 3, on: 'pile' })).toEqual({ ok: false, error: 'Nothing to react to right now' });
  });

  it('lets a player leave mid-game as a forfeit; the last one left wins', async () => {
    const [a, b] = await crazyRoom(['Kiran', 'Dev']);
    expect(await send(b, 'room:leave')).toEqual({ ok: true });
    await until(() => a.state!.phase === 'over');
    expect(a.state!.winnerIds).toEqual([a.state!.meId]);
    expect(a.state!.leftPlayers.map((p) => p.name)).toEqual(['Dev']);
  });
});

describe('crazy 7 at human pace', () => {
  let slow: ReturnType<typeof createBluffServer>;
  let slowUrl = '';

  beforeAll(async () => {
    // automatic steps wait over a second here, so a move sent meanwhile always arrives first
    slow = createBluffServer({ limits: { createsPerIp: 10_000, liveRoomsPerIp: 10_000 }, botSpeed: 1 });
    await new Promise<void>((resolve) => slow.httpServer.listen(0, resolve));
    slowUrl = `http://localhost:${(slow.httpServer.address() as AddressInfo).port}`;
  });

  afterAll(() => slow.close());

  it('refuses a move while the room is about to pick or pass for that player', async () => {
    const people = await crazyRoom(['Isha', 'Om'], slowUrl);
    try {
      for (let i = 0; i < 300; i++) {
        await until(() => sameMoment(people));
        // a game can end before anything automatic comes up: deal again
        if (people[0].state!.phase === 'over') {
          expect(await send(people[0], 'room:rematch')).toEqual({ ok: true });
          await until(() => people.every((x) => x.state!.phase === 'playing') && sameMoment(people));
          continue;
        }
        const p = people.find((x) => x.state!.meId === people[0].state!.turnId)!;
        if (p.state!.crazy7!.auto) {
          expect(await send(p, 'c7:pick')).toEqual({ ok: false, error: 'One moment, picking for you' });
          return;
        }
        await step(people);
      }
      throw new Error('no automatic step came up');
    } finally {
      people.forEach((c) => c.socket.disconnect());
    }
  });
});
