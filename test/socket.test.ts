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

  it('rejects a sixth player and bad input', async () => {
    const host = await client();
    const { code } = await send(host, 'room:create', { name: 'P1' });
    for (const name of ['P2', 'P3', 'P4', 'P5']) {
      expect(await send(await client(), 'room:join', { code, name })).toMatchObject({ ok: true });
    }
    const extra = await client();
    expect(await send(extra, 'room:join', { code, name: 'P6' })).toEqual({ ok: false, error: 'Room is full (max 5)' });
    expect(await send(extra, 'room:join', { code, name: '   ' })).toMatchObject({ ok: false });
    expect(await send(extra, 'room:join', { code: 'AB', name: 'X' })).toEqual({ ok: false, error: 'Room code is 4 letters' });
    expect(await send(extra, 'game:pass')).toEqual({ ok: false, error: 'Join a room first' });
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
