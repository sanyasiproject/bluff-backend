import type { AddressInfo } from 'node:net';
import { io as connect, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBluffServer } from '../src/server.js';
import type { Announcement, ChatEvent, RoomView } from '../src/types.js';

type Client = { socket: Socket; state: RoomView | null; notes: Announcement[] };
type Res = { ok: boolean; error?: string; code?: string; token?: string };

let server: ReturnType<typeof createBluffServer>;
let url = '';
const opened: Client[] = [];

beforeAll(async () => {
  server = createBluffServer();
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

const send = (c: Client, event: string, payload: object = {}): Promise<Res> =>
  c.socket.timeout(2000).emitWithAck(event, payload);

async function until(check: () => boolean, ms = 2000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('socket server', () => {
  it('runs a game where each player only sees their own hand', async () => {
    const [a, b, c] = [await client(), await client(), await client()];
    const created = await send(a, 'room:create', { name: 'Asha' });
    expect(created).toMatchObject({ ok: true });
    const code = created.code!;
    // new rooms start on the "pick one card" bluff rule
    await until(() => a.state !== null);
    expect(a.state!.config).toEqual({ decks: 1, bluffRule: 'one', stake: 0 });
    expect(await send(b, 'room:join', { code: code.toLowerCase(), name: 'Ravi' })).toMatchObject({ ok: true });
    expect(await send(c, 'room:join', { code, name: 'ravi' })).toEqual({ ok: false, error: 'That name is taken in this room' });
    expect(await send(c, 'room:join', { code, name: 'Meena' })).toMatchObject({ ok: true });
    expect(await send(b, 'room:config', { decks: 2, bluffRule: 'one' })).toEqual({ ok: false, error: 'Only the host can do that' });
    expect(await send(a, 'room:config', { decks: 1, bluffRule: 'all' })).toEqual({ ok: true });
    expect(await send(b, 'room:start')).toEqual({ ok: false, error: 'Only the host can do that' });
    expect(await send(a, 'room:start')).toEqual({ ok: true });
    await until(() => [a, b, c].every((x) => x.state?.phase === 'playing'));

    const hands = [a, b, c].map((x) => x.state!.hand);
    expect(hands.map((h) => h.length).sort()).toEqual([17, 17, 18]);
    expect(new Set(hands.flat().map((card) => card.id)).size).toBe(52);
    const bJson = JSON.stringify(b.state);
    expect(hands[0].some((card) => bJson.includes(`"${card.id}"`))).toBe(false);

    const byId = new Map([a, b, c].map((x) => [x.state!.meId, x]));
    const mover = byId.get(a.state!.turnId!)!;
    const played = mover.state!.hand.slice(0, 2);
    const notMyTurn = [a, b, c].find((x) => x !== mover)!;
    expect(await send(notMyTurn, 'game:play', { cardIds: [notMyTurn.state!.hand[0].id], rank: 'K' })).toEqual({
      ok: false,
      error: 'Not your turn',
    });
    expect(await send(mover, 'game:play', { cardIds: played.map((x) => x.id), rank: 'K' })).toEqual({ ok: true });
    await until(() => [a, b, c].every((x) => x.notes.some((n) => n.kind === 'play')));
    expect(c.notes.find((n) => n.kind === 'play')!.text).toMatch(/ played two Kings$/);

    const caller = notMyTurn;
    await until(() => caller.state?.lastPlay?.count === 2);
    expect(JSON.stringify(caller.state)).not.toContain(played[0].id);
    expect(await send(caller, 'game:bluff', { playId: caller.state!.lastPlay!.id })).toEqual({ ok: true });
    await until(() => caller.state?.reveal != null);

    const truth = played.every((x) => x.rank === 'K');
    expect(caller.state!.reveal).toMatchObject({ bluff: !truth, pileCount: 2 });
    const loser = truth ? caller : mover;
    await until(() => played.every((x) => loser.state!.hand.some((h) => h.id === x.id)));
    expect(a.notes.some((n) => n.kind === 'bluff')).toBe(true);
  });

  it('lets a player rejoin their seat with the saved token', async () => {
    const [a, b] = [await client(), await client()];
    const { code, token } = await send(a, 'room:create', { name: 'Host' });
    await send(b, 'room:join', { code, name: 'Guest' });
    a.socket.disconnect();
    await until(() => b.state?.players.find((p) => p.name === 'Host')?.connected === false);

    const a2 = await client();
    expect(await send(a2, 'room:rejoin', { code, token: 'f'.repeat(32) })).toEqual({
      ok: false,
      error: 'Your seat in this room is gone',
    });
    expect(await send(a2, 'room:rejoin', { code, token })).toEqual({ ok: true, code });
    await until(() => b.state!.players.every((p) => p.connected));
    expect(a2.state!.hostId).toBe(a2.state!.meId);
  });

  it('seats five players, lets the next people watch, and caps the room at 12', async () => {
    const host = await client();
    const { code } = await send(host, 'room:create', { name: 'P1' });
    for (const name of ['P2', 'P3', 'P4', 'P5']) {
      expect(await send(await client(), 'room:join', { code, name })).toMatchObject({ ok: true });
    }
    const sixth = await client();
    expect(await send(sixth, 'room:join', { code, name: 'P6' })).toMatchObject({ ok: true });
    await until(() => sixth.state?.watchers.some((w) => w.name === 'P6') === true);
    expect(sixth.state!.players).toHaveLength(5);
    for (const name of ['W2', 'W3', 'W4', 'W5', 'W6', 'W7']) {
      expect(await send(await client(), 'room:join', { code, name })).toMatchObject({ ok: true });
    }
    const extra = await client();
    expect(await send(extra, 'room:join', { code, name: 'X' })).toEqual({ ok: false, error: 'Room is full (max 12)' });
    expect(await send(extra, 'room:join', { code, name: '   ' })).toMatchObject({ ok: false });
    expect(await send(extra, 'room:join', { code: 'AB', name: 'X' })).toEqual({ ok: false, error: 'Room code is 4 letters' });
    expect(await send(extra, 'game:pass')).toEqual({ ok: false, error: 'Join a room first' });
  });

  it('lets late friends watch and chat, then seats them for the next game', async () => {
    const [a, b, late] = [await client(), await client(), await client()];
    const { code } = await send(a, 'room:create', { name: 'Host' });
    await send(b, 'room:join', { code, name: 'Guest' });
    await send(a, 'room:start');
    expect(await send(late, 'room:join', { code, name: 'Late' })).toMatchObject({ ok: true });
    await until(() => late.state?.phase === 'playing');
    expect(late.state!.players.map((p) => p.name)).toEqual(['Host', 'Guest']);
    expect(late.state!.watchers.map((w) => w.name)).toEqual(['Late']);
    expect(late.state!.hand).toEqual([]);
    expect(await send(late, 'game:pass')).toEqual({ ok: false, error: 'Not your turn' });
    expect(a.notes.at(-1)?.text).toBe('Late is watching');

    // the watcher sees every hand; seated players only ever get their own
    expect(late.state!.watch!.hands[a.state!.meId]).toEqual(a.state!.hand);
    expect(late.state!.watch!.hands[b.state!.meId]).toEqual(b.state!.hand);
    expect(a.state!.watch).toBeNull();
    expect(b.state!.watch).toBeNull();
    expect(b.state!.hand.some((c) => JSON.stringify(a.state).includes(`"${c.id}"`))).toBe(false);

    // ...and the real cards of each play, in the order they were tapped
    const mover = [a, b].find((x) => x.state!.turnId === x.state!.meId)!;
    const played = [mover.state!.hand[3], mover.state!.hand[0]];
    await send(mover, 'game:play', { cardIds: played.map((c) => c.id), rank: 'Q' });
    await until(() => late.state?.lastPlay?.count === 2);
    expect(late.state!.watch!.lastPlayCards).toEqual(played);
    await until(() => a.state?.lastPlay?.count === 2 && b.state?.lastPlay?.count === 2);
    expect(a.state!.watch).toBeNull();
    expect(JSON.stringify(a.state === mover.state ? b.state : a.state)).not.toContain(`"${played[0].id}"`);

    const chats: ChatEvent[] = [];
    a.socket.on('chat', (c: ChatEvent) => chats.push(c));
    expect(await send(late, 'chat:send', { kind: 'reaction', index: 1 })).toEqual({ ok: true });
    expect(await send(late, 'chat:send', { kind: 'message', index: 0 })).toEqual({ ok: false, error: 'Slow down' });
    expect(await send(late, 'chat:send', { kind: 'message', index: 999 })).toEqual({ ok: false, error: 'Invalid message' });
    await until(() => chats.length === 1);
    expect(chats[0]).toEqual({ from: late.state!.meId, kind: 'reaction', index: 1 });

    expect(await send(a, 'room:lobby')).toEqual({ ok: true });
    await until(() => late.state?.phase === 'lobby');
    expect(late.state!.players.map((p) => p.name)).toEqual(['Host', 'Guest', 'Late']);
    expect(late.state!.watchers).toEqual([]);
  });

  it('lets the host deal the same table again from the game-over screen', async () => {
    const [a, b] = [await client(), await client()];
    const { code } = await send(a, 'room:create', { name: 'Host' });
    await send(b, 'room:join', { code, name: 'Guest' });
    await send(a, 'room:start');
    await until(() => b.state?.phase === 'playing');
    expect(await send(a, 'room:rematch')).toEqual({ ok: false, error: 'The game is not over yet' });

    // finish fast: the mover is down to one card, plays it, and the other player passes
    const game = server.rooms.get(code!).game!;
    const [mover, other] = game.turnId === a.state!.meId ? [a, b] : [b, a];
    const last = game.hand(mover.state!.meId).slice(0, 1);
    game.hands.set(mover.state!.meId, last);
    await send(mover, 'game:play', { cardIds: [last[0].id], rank: 'A' });
    await send(other, 'game:pass');
    await until(() => a.state?.phase === 'over' && b.state?.phase === 'over');

    expect(await send(b, 'room:rematch')).toEqual({ ok: false, error: 'Only the host can do that' });
    expect(await send(a, 'room:rematch')).toEqual({ ok: true });
    await until(() => b.state?.phase === 'playing' && b.state.hand.length === 26);
    await until(() => a.notes.at(-1)?.text.startsWith('Rematch. ') === true);
  });

  it('lets the host end the game once someone has won, and everyone else loses', async () => {
    const [a, b, c] = [await client(), await client(), await client()];
    const { code } = await send(a, 'room:create', { name: 'Host' });
    await send(b, 'room:join', { code, name: 'Bee' });
    await send(c, 'room:join', { code, name: 'Cee' });
    await send(a, 'room:start');
    await until(() => c.state?.phase === 'playing');
    expect(await send(a, 'room:end')).toEqual({ ok: false, error: 'Nobody has won yet. Use Stop game instead' });

    // Bee empties their hand and finishes 1st
    const room = server.rooms.get(code!);
    const beeId = b.state!.meId;
    room.game!.hands.set(beeId, []);
    room.game!.places.push(beeId);
    expect(await send(c, 'room:end')).toEqual({ ok: false, error: 'Only the host can do that' });
    expect(await send(a, 'room:end')).toEqual({ ok: true });
    await until(() => c.state?.phase === 'over');
    expect(c.state!.endedEarly).toBe(true);
    expect([...c.state!.loserIds].sort()).toEqual([a.state!.meId, c.state!.meId].sort());
    expect(room.snapshot('finished')!.players.map((p) => [p.name, p.place, p.loser])).toEqual([
      ['Host', null, true],
      ['Bee', 1, false],
      ['Cee', null, true],
    ]);
    await until(() => a.notes.at(-1)?.text === 'The host ended the game. Bee wins');
  });

  it('lets the host hand the host role to someone else in the lobby', async () => {
    const [a, b, c] = [await client(), await client(), await client()];
    const { code } = await send(a, 'room:create', { name: 'Host' });
    await send(b, 'room:join', { code, name: 'Bee' });
    await send(c, 'room:join', { code, name: 'Cee' });
    await until(() => [a, b, c].every((x) => x.state?.players.length === 3));
    const [aId, bId, cId] = [a, b, c].map((x) => x.state!.meId);

    expect(await send(b, 'room:host', { memberId: cId })).toEqual({ ok: false, error: 'Only the host can do that' });
    expect(await send(a, 'room:host', { memberId: aId })).toEqual({ ok: false, error: "You're already the host" });
    c.socket.disconnect();
    await until(() => a.state!.players.find((p) => p.id === cId)?.connected === false);
    expect(await send(a, 'room:host', { memberId: cId })).toEqual({ ok: false, error: 'Cee is offline' });

    expect(await send(a, 'room:host', { memberId: bId })).toEqual({ ok: true });
    await until(() => a.state?.hostId === bId && b.state?.hostId === bId);
    await until(() => a.notes.at(-1)?.text === 'Host made Bee the host');
    // the old host lost the controls, the new one has them
    expect(await send(a, 'room:config', { decks: 2, bluffRule: 'all' })).toEqual({ ok: false, error: 'Only the host can do that' });
    expect(await send(b, 'room:config', { decks: 2, bluffRule: 'all' })).toEqual({ ok: true });
    expect(await send(b, 'room:start')).toEqual({ ok: true });
    expect(await send(b, 'room:host', { memberId: aId })).toEqual({ ok: false, error: 'The host can only be changed in the lobby' });
  });

  it('blocks browser connections from unknown sites', async () => {
    const evil = connect(url, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
      extraHeaders: { origin: 'https://evil.example' },
    });
    await expect(
      new Promise((resolve, reject) => {
        evil.once('connect', () => resolve('connected'));
        evil.once('connect_error', reject);
      }),
    ).rejects.toThrow();
    evil.close();

    const local = connect(url, { transports: ['websocket'], forceNew: true, extraHeaders: { origin: 'http://localhost:5173' } });
    await new Promise<void>((resolve) => local.once('connect', () => resolve()));
    local.close();
  });
});
