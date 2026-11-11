import type { AddressInfo } from 'node:net';
import { io as connect, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBluffServer } from '../src/server.js';
import type { Announcement, Card, RoomView } from '../src/types.js';

type Client = { socket: Socket; state: RoomView | null; notes: Announcement[] };
type Res = { ok: boolean; error?: string; code?: string; token?: string };

let server: ReturnType<typeof createBluffServer>;
let url = '';
const opened: Client[] = [];

beforeAll(async () => {
  // bots think in a few milliseconds here instead of seconds
  server = createBluffServer({ limits: { createsPerIp: 10_000, liveRoomsPerIp: 10_000 }, botSpeed: 0.004 });
  await new Promise<void>((resolve) => server.httpServer.listen(0, resolve));
  url = `http://localhost:${(server.httpServer.address() as AddressInfo).port}`;
});

afterAll(() => {
  opened.forEach((c) => c.socket.disconnect());
  server.close();
});

async function client(): Promise<Client> {
  const c: Client = { socket: connect(url, { transports: ['websocket'], forceNew: true }), state: null, notes: [] };
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
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** a plain honest person: real cards of the round's rank, else pass, else one card */
async function playMyTurn(c: Client) {
  const v = c.state!;
  const rank = v.roundRank;
  const real = rank ? v.hand.filter((x) => x.rank === rank) : [];
  if (rank && real.length === 0 && v.lastPlay) return send(c, 'game:pass');
  const cards: Card[] = rank ? (real.length > 0 ? real : [v.hand[0]]) : v.hand.filter((x) => x.rank === v.hand[0].rank);
  return send(c, 'game:play', { cardIds: cards.map((x) => x.id), rank: rank ? undefined : cards[0].rank });
}

describe('bots at the table', () => {
  it('lets the host add bots, needs a person playing, and plays a whole game with them', async () => {
    const [a, b] = [await client(), await client()];
    const { code } = await send(a, 'room:create', { name: 'Asha' });
    await send(b, 'room:join', { code, name: 'Ravi' });
    expect(await send(b, 'room:addBot')).toEqual({ ok: false, error: 'Only the host can do that' });
    expect(await send(a, 'room:addBot')).toEqual({ ok: true });
    expect(await send(a, 'room:addBot')).toEqual({ ok: true });
    await until(() => a.state!.players.filter((p) => p.bot).length === 2);
    const bots = a.state!.players.filter((p) => p.bot);
    expect(new Set(bots.map((p) => p.name)).size).toBe(2);
    expect(bots.every((p) => p.connected && p.username === null && p.level === null)).toBe(true);
    expect(a.notes.some((n) => / added .+ 🤖$/.test(n.text))).toBe(true);

    // bots can't be the host, sit out, or be moved
    expect(await send(a, 'room:host', { memberId: bots[0].id })).toEqual({ ok: false, error: "A bot can't be the host" });
    expect(await send(a, 'room:watch', { watching: true, memberId: bots[0].id })).toEqual({
      ok: false,
      error: 'Bots always play. Remove the bot instead',
    });

    // people watching and only bots seated: no game
    await send(b, 'room:watch', { watching: true });
    await send(a, 'room:watch', { watching: true });
    expect(await send(a, 'room:start')).toEqual({ ok: false, error: 'Someone has to play with the bots' });
    await send(a, 'room:watch', { watching: false });
    await send(b, 'room:watch', { watching: false });

    expect(await send(a, 'room:start')).toEqual({ ok: true });
    await until(() => a.state?.phase === 'playing' && b.state?.phase === 'playing');
    // the people play honestly until it's over; the bots move on their own
    const end = Date.now() + 25_000;
    while (a.state!.phase === 'playing' && Date.now() < end) {
      for (const c of [a, b]) {
        if (c.state!.phase === 'playing' && c.state!.turnId === c.state!.meId) await playMyTurn(c);
      }
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(a.state!.phase).toBe('over');
    expect(a.notes.some((n) => n.kind === 'play' && bots.some((x) => n.text.startsWith(x.name)))).toBe(true);
  }, 30_000);

  it('caps the stake at 100 with bots at the table', async () => {
    const a = await client();
    await send(a, 'room:create', { name: 'Host' });
    expect(await send(a, 'room:config', { decks: 1, bluffRule: 'one', stake: 500 })).toEqual({ ok: true });
    await send(a, 'room:addBot');
    await until(() => a.state!.config.stake === 100);
    expect(a.notes.some((n) => n.text === 'With bots at the table the stake is now 100')).toBe(true);
    expect(await send(a, 'room:config', { decks: 1, bluffRule: 'one', stake: 250 })).toEqual({
      ok: false,
      error: 'With bots at the table the stake can be up to 100',
    });
    expect(await send(a, 'room:config', { decks: 1, bluffRule: 'one', stake: 50 })).toEqual({ ok: true });
  });

  it('never leaves a room to bots alone, in the lobby or mid-game', async () => {
    const [a, other] = [await client(), await client()];
    const lobby = await send(a, 'room:create', { name: 'Solo' });
    await send(a, 'room:addBot');
    await send(a, 'room:leave');
    expect(await send(other, 'room:join', { code: lobby.code, name: 'Late' })).toEqual({ ok: false, error: `Room ${lobby.code} not found` });

    const game = await send(a, 'room:create', { name: 'Solo' });
    await send(a, 'room:addBot');
    await send(a, 'room:addBot');
    await send(a, 'room:start');
    await until(() => a.state?.phase === 'playing');
    await send(a, 'room:leave');
    expect(await send(other, 'room:join', { code: game.code, name: 'Late' })).toEqual({ ok: false, error: `Room ${game.code} not found` });
  });

  it('ends the game once no person holds cards, and lets the host remove a bot', async () => {
    const a = await client();
    await send(a, 'room:create', { name: 'Kiran' });
    await send(a, 'room:addBot');
    await send(a, 'room:addBot');
    await until(() => a.state!.players.length === 3);
    const gone = a.state!.players.find((p) => p.bot)!;
    expect(await send(a, 'room:kick', { memberId: gone.id })).toEqual({ ok: true });
    await until(() => a.state!.players.length === 2);
    await send(a, 'room:addBot');
    await send(a, 'room:start');
    await until(() => a.state?.phase === 'playing');
    const end = Date.now() + 25_000;
    while (a.state!.phase === 'playing' && Date.now() < end) {
      if (a.state!.turnId === a.state!.meId) await playMyTurn(a);
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(a.state!.phase).toBe('over');
    // the person finished or the bots won; either way the bots didn't play on alone
    const me = a.state!.players.find((p) => p.id === a.state!.meId)!;
    expect(me.cardCount === 0 || a.state!.players.filter((p) => p.bot && p.cardCount === 0).length >= 1).toBe(true);
  }, 30_000);

  it('swaps 2v2 places with a bot at once', async () => {
    const a = await client();
    await send(a, 'room:create', { name: 'Team' });
    for (let i = 0; i < 3; i++) await send(a, 'room:addBot');
    await send(a, 'room:config', { decks: 1, bluffRule: 'one', teams: true });
    await until(() => a.state!.slots?.every((x) => x !== null) === true);
    const mySlot = a.state!.slots!.indexOf(a.state!.meId);
    const target = a.state!.slots!.find((id, i) => id && i !== mySlot)!;
    expect(await send(a, 'room:swap', { memberId: target })).toEqual({ ok: true });
    await until(() => a.state!.slots!.indexOf(target) === mySlot);
  });
});
