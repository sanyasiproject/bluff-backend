import type { AddressInfo } from 'node:net';
import { io as connect, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBluffServer } from '../src/server.js';
import type { Announcement, ChatEvent, RoomView, ThrowEvent } from '../src/types.js';

type Client = { socket: Socket; state: RoomView | null; notes: Announcement[] };
type Res = { ok: boolean; error?: string; code?: string; token?: string; pending?: boolean };

let server: ReturnType<typeof createBluffServer>;
let url = '';
const opened: Client[] = [];

beforeAll(async () => {
  // every test client shares one address, so the per-network limits get their own test
  server = createBluffServer({ limits: { createsPerIp: 10_000, liveRoomsPerIp: 10_000 } });
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
    expect(a.state!.config).toEqual({ decks: 1, bluffRule: 'one', stake: 0, peeks: 0, bets: false, teams: false });
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
    // mid-game the newcomer asks; only the host sees the request and can let them in
    expect(await send(late, 'room:join', { code, name: 'Late' })).toEqual({ ok: true, code, pending: true });
    await until(() => a.state?.watchRequests.length === 1);
    expect(b.state!.watchRequests).toEqual([]);
    const requestId = a.state!.watchRequests[0].id;
    expect(await send(b, 'room:admit', { requestId, accept: true })).toEqual({ ok: false, error: 'Only the host can do that' });
    const admitted = new Promise<{ code: string; token: string }>((resolve) => late.socket.once('watch:admitted', resolve));
    expect(await send(a, 'room:admit', { requestId, accept: true })).toEqual({ ok: true });
    const seatToken = (await admitted).token;
    expect(await send(late, 'room:rejoin', { code, token: seatToken })).toEqual({ ok: true, code });
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

  it('lets anyone switch between playing and watching in the lobby', async () => {
    const people: Client[] = [];
    for (let i = 0; i < 6; i++) people.push(await client());
    const [host, p2, , , , p6] = people;
    const { code } = await send(host, 'room:create', { name: 'P1' });
    for (let i = 1; i < 6; i++) await send(people[i], 'room:join', { code, name: `P${i + 1}` });
    await until(() => host.state?.players.length === 5 && host.state.watchers.length === 1);
    const names = (list: { name: string }[]) => list.map((p) => p.name);

    // P6 waits for a seat; P2 chooses to watch, so P6 gets that seat
    expect(await send(p2, 'room:watch', { watching: true })).toEqual({ ok: true });
    await until(() => names(host.state!.watchers).join() === 'P2');
    expect(names(host.state!.players)).toEqual(['P1', 'P3', 'P4', 'P5', 'P6']);
    expect(host.state!.watchers[0].byChoice).toBe(true);
    expect(await send(p2, 'room:watch', { watching: false })).toEqual({ ok: false, error: 'All 5 seats are taken' });

    // a seat frees up, but someone who chose to watch isn't seated until they switch back
    await send(p6, 'room:leave');
    await until(() => host.state!.players.length === 4);
    expect(names(host.state!.watchers)).toEqual(['P2']);
    expect(await send(p2, 'room:watch', { watching: false })).toEqual({ ok: true });
    await until(() => host.state!.players.length === 5 && host.state!.watchers.length === 0);
    await until(() => host.notes.at(-1)?.text === 'P2 is playing');

    // the host can move anyone; nobody else can
    const p3 = people[2];
    const p3Id = p3.state!.meId;
    expect(await send(p2, 'room:watch', { watching: true, memberId: p3Id })).toEqual({ ok: false, error: 'Only the host can do that' });
    expect(await send(host, 'room:watch', { watching: true, memberId: p3Id })).toEqual({ ok: true });
    await until(() => names(host.state!.watchers).join() === 'P3');
    await until(() => host.notes.at(-1)?.text === 'P1 moved P3 to watching');
    expect(await send(host, 'room:watch', { watching: false, memberId: p3Id })).toEqual({ ok: true });
    await until(() => host.state!.watchers.length === 0);

    // the host can watch and still start the game; switching waits for the lobby
    expect(await send(host, 'room:watch', { watching: true })).toEqual({ ok: true });
    expect(await send(host, 'room:start')).toEqual({ ok: true });
    await until(() => host.state?.phase === 'playing');
    expect(host.state!.hand).toEqual([]);
    expect(host.state!.watch).not.toBeNull();
    expect(await send(host, 'room:watch', { watching: false })).toEqual({
      ok: false,
      error: 'You can switch between playing and watching in the lobby',
    });
    await send(host, 'room:lobby');
    await until(() => host.state?.phase === 'lobby');
    expect(names(host.state!.watchers)).toEqual(['P1']);
  });

  it('plays 2v2: teams pair the 1st & 3rd seats, the host can shuffle them, and a peek stays private', async () => {
    const people: Client[] = [];
    for (let i = 0; i < 4; i++) people.push(await client());
    const [host] = people;
    const { code } = await send(host, 'room:create', { name: 'T1' });
    for (let i = 1; i < 4; i++) await send(people[i], 'room:join', { code, name: `T${i + 1}` });
    expect(await send(host, 'room:config', { decks: 1, bluffRule: 'all', peeks: 1, teams: true })).toEqual({ ok: true });
    await until(() => people.every((p) => p.state?.teams != null));
    const ids = people.map((p) => p.state!.meId);
    expect(host.state!.teams).toEqual([
      [ids[0], ids[2]],
      [ids[1], ids[3]],
    ]);
    expect(await send(people[1], 'room:teams')).toEqual({ ok: false, error: 'Only the host can do that' });
    expect(await send(host, 'room:teams')).toEqual({ ok: true });
    await until(() => host.state!.teams![0][1] !== ids[2]);

    // three players can't start a team game
    await send(people[3], 'room:watch', { watching: true });
    expect(await send(host, 'room:start')).toEqual({ ok: false, error: 'Teams need exactly 4 players' });
    await send(people[3], 'room:watch', { watching: false });
    expect(await send(host, 'room:start')).toEqual({ ok: true });
    await until(() => people.every((p) => p.state?.phase === 'playing'));
    const teams = host.state!.teams!;

    const byId = new Map(people.map((p) => [p.state!.meId, p]));
    const mover = byId.get(host.state!.turnId!)!;
    const moverId = mover.state!.meId;
    const partner = byId.get(teams.find((t) => t.includes(moverId))!.find((id) => id !== moverId)!)!;
    const rival = byId.get(teams.find((t) => !t.includes(moverId))![0])!;
    const played = mover.state!.hand.slice(0, 2);
    await send(mover, 'game:play', { cardIds: played.map((c) => c.id), rank: 'Q' });
    await until(() => rival.state?.lastPlay?.count === 2);
    const playId = rival.state!.lastPlay!.id;
    expect((await send(partner, 'game:bluff', { playId })).error).toBe("You can't call bluff on your partner");

    // the card comes back only in the peeker's reply; others hear that a peek happened
    const peek = (await send(rival, 'game:peek', { playId, cardIndex: 1 })) as Res & { card?: unknown };
    expect(peek).toEqual({ ok: true, card: played[1] });
    await until(() => host.notes.some((n) => n.text === `${rival.state!.players.find((p) => p.id === rival.state!.meId)!.name} used a peek 🔍`));
    await until(() => rival.state!.peeksLeft === 0);
    expect((await send(rival, 'game:peek', { playId, cardIndex: 0 })).error).toBe('No peeks left this game');
    expect(JSON.stringify(partner.state)).not.toContain(played[1].id);
  });

  it('lets 2v2 players pick a slot, swap places on request, and see only their partner\'s hand', async () => {
    const [s1, s2, s3] = [await client(), await client(), await client()];
    const { code } = await send(s1, 'room:create', { name: 'S1' });
    await send(s2, 'room:join', { code, name: 'S2' });
    await send(s3, 'room:join', { code, name: 'S3' });
    await send(s1, 'room:config', { decks: 1, bluffRule: 'all', teams: true });
    const id = (c: Client) => c.state!.meId;
    await until(() => s1.state?.slots?.filter(Boolean).length === 3);
    expect(s1.state!.slots).toEqual([id(s1), id(s2), id(s3), null]);

    // S3 picks the empty slot, which moves them to the other team
    expect((await send(s3, 'room:slot', { slot: 1 })).error).toBe('That slot is taken. Ask them to swap instead');
    expect(await send(s3, 'room:slot', { slot: 3 })).toEqual({ ok: true });
    await until(() => s1.state!.slots![3] === id(s3));
    const s4 = await client();
    await send(s4, 'room:join', { code, name: 'S4' });
    await until(() => s1.state!.slots![2] === id(s4));
    expect(s1.state!.teams).toEqual([
      [id(s1), id(s4)],
      [id(s2), id(s3)],
    ]);

    // S1 asks S2 to swap; only S2 can answer, and yes swaps their places
    expect(await send(s1, 'room:swap', { memberId: id(s2) })).toEqual({ ok: true });
    await until(() => s2.state!.swapAsks.some((a) => a.fromId === id(s1) && a.toId === id(s2)));
    expect((await send(s3, 'room:swapAnswer', { memberId: id(s1), accept: true })).error).toBe('That swap request has expired');
    expect(await send(s2, 'room:swapAnswer', { memberId: id(s1), accept: true })).toEqual({ ok: true });
    await until(() => s1.state!.slots![0] === id(s2) && s1.state!.slots![1] === id(s1));
    await until(() => s1.notes.at(-1)?.text === 'S1 and S2 swapped places');
    expect(s1.state!.swapAsks).toEqual([]);

    // a no leaves everyone where they are
    await send(s3, 'room:swap', { memberId: id(s4) });
    expect(await send(s4, 'room:swapAnswer', { memberId: id(s3), accept: false })).toEqual({ ok: true });
    await until(() => s1.notes.at(-1)?.text === 'S4 said no to swapping');
    expect(s1.state!.slots).toEqual([id(s2), id(s1), id(s4), id(s3)]);

    // in the game partners see each other's hand and nobody else's
    expect(await send(s1, 'room:start')).toEqual({ ok: true });
    await until(() => [s1, s2, s3, s4].every((c) => c.state?.phase === 'playing'));
    expect(s2.state!.partnerHand).toEqual(s4.state!.hand);
    expect(s4.state!.partnerHand).toEqual(s2.state!.hand);
    expect(s1.state!.partnerHand).toEqual(s3.state!.hand);
    const s1Json = JSON.stringify(s1.state);
    expect([...s2.state!.hand, ...s4.state!.hand].some((c) => s1Json.includes(`"${c.id}"`))).toBe(false);
  });

  it('asks the host before anyone watches a game in progress, and lets waiting people in back in the lobby', async () => {
    const [host, b, nope, quitter, later] = [await client(), await client(), await client(), await client(), await client()];
    const { code } = await send(host, 'room:create', { name: 'Host' });
    await send(b, 'room:join', { code, name: 'Bee' });
    await send(host, 'room:start');
    await until(() => b.state?.phase === 'playing');

    // a no goes back to the asker
    const denied = new Promise<{ code: string }>((resolve) => nope.socket.once('watch:denied', resolve));
    await send(nope, 'room:join', { code, name: 'Nope' });
    await until(() => host.state!.watchRequests.length === 1);
    expect(await send(host, 'room:admit', { requestId: host.state!.watchRequests[0].id, accept: false })).toEqual({ ok: true });
    expect(await denied).toEqual({ code });
    await until(() => host.state!.watchRequests.length === 0);
    // after a no they wait 10 s before asking again
    expect(await send(nope, 'room:join', { code, name: 'Nope' })).toMatchObject({ ok: false, error: expect.stringMatching(/^Wait \d+ s before asking again$/) });

    // closing the app takes the request away
    await send(quitter, 'room:join', { code, name: 'Quitter' });
    await until(() => host.state!.watchRequests.length === 1);
    quitter.socket.disconnect();
    await until(() => host.state!.watchRequests.length === 0);

    // still waiting when the host goes back to the lobby: they come straight in
    const admitted = new Promise<{ token: string }>((resolve) => later.socket.once('watch:admitted', resolve));
    await send(later, 'room:join', { code, name: 'Later' });
    await until(() => host.state!.watchRequests.length === 1);
    await send(host, 'room:lobby');
    const { token } = await admitted;
    expect(await send(later, 'room:rejoin', { code, token })).toEqual({ ok: true, code });
    await until(() => host.state!.players.some((p) => p.name === 'Later'));
  });

  it('lets a player leave a game in progress as a forfeit', async () => {
    const [a, b] = [await client(), await client()];
    const { code } = await send(a, 'room:create', { name: 'Stayer' });
    await send(b, 'room:join', { code, name: 'Leaver' });
    await send(a, 'room:start');
    await until(() => b.state?.phase === 'playing');
    const room = server.rooms.get(code!);
    expect(await send(b, 'room:leave')).toEqual({ ok: true });
    await until(() => a.state?.phase === 'over');
    expect(a.state!.winnerIds).toEqual([a.state!.meId]);
    // the leaver is still part of this game's result
    const leftId = a.state!.loserIds[0];
    expect(a.state!.leftPlayers).toEqual([{ id: leftId, name: 'Leaver', registered: false, level: null }]);
    await until(() => a.notes.some((n) => n.text === 'Leaver left the game'));
    expect(room.snapshot('finished')!.players.map((p) => [p.name, p.won, p.loser, p.kicked])).toEqual([
      ['Stayer', true, false, false],
      ['Leaver', false, true, false],
    ]);
    // back in the lobby the list is cleared
    await send(a, 'room:lobby');
    await until(() => a.state?.phase === 'lobby');
    expect(a.state!.leftPlayers).toEqual([]);
  });

  it('throws an emoji at someone in the room for everyone to see', async () => {
    const [a, b] = [await client(), await client()];
    const { code } = await send(a, 'room:create', { name: 'Thrower' });
    await send(b, 'room:join', { code, name: 'Target' });
    await until(() => a.state?.players.length === 2 && b.state?.players.length === 2);
    const seen: ThrowEvent[] = [];
    b.socket.on('throw', (t: ThrowEvent) => seen.push(t));
    const [me, them] = [a.state!.meId, b.state!.meId];
    expect(await send(a, 'chat:throw', { to: them, index: 2 })).toEqual({ ok: true });
    await until(() => seen.length === 1);
    expect(seen[0]).toEqual({ from: me, to: them, index: 2 });
    // shares the chat speed limit, and only real people in the room
    expect(await send(a, 'chat:throw', { to: them, index: 0 })).toEqual({ ok: false, error: 'Slow down' });
    expect(await send(b, 'chat:throw', { to: them, index: 0 })).toEqual({ ok: false, error: 'Pick someone else' });
    expect(await send(b, 'chat:throw', { to: me, index: 99 })).toEqual({ ok: false, error: 'Invalid emoji' });
    expect(await send(b, 'chat:throw', { to: 'abcdefabcdef', index: 0 })).toEqual({ ok: false, error: 'That player has left' });
    // the newest throw (🤡, last of the 20) goes through like the first ones
    expect(await send(b, 'chat:throw', { to: me, index: 19 })).toEqual({ ok: true });
    // guests can't send coins
    expect(await send(a, 'friend:gift', { memberId: them, amount: 10 })).toEqual({ ok: false, error: 'Log in to send coins' });
    a.socket.disconnect();
    b.socket.disconnect();
  });

  it('limits connections, new rooms and open rooms per network', async () => {
    const limited = createBluffServer({ limits: { connectionsPerIp: 4, createsPerIp: 3, liveRoomsPerIp: 2 } });
    await new Promise<void>((resolve) => limited.httpServer.listen(0, resolve));
    const at = `http://localhost:${(limited.httpServer.address() as AddressInfo).port}`;
    const from = (ip: string) =>
      connect(at, { transports: ['websocket'], forceNew: true, reconnection: false, extraHeaders: { 'x-forwarded-for': `6.6.6.6, ${ip}` } });
    const open = (ip: string) =>
      new Promise<Socket>((resolve, reject) => {
        const s = from(ip);
        s.once('connect', () => resolve(s));
        s.once('connect_error', reject);
      });
    const sockets = [await open('9.9.9.9'), await open('9.9.9.9'), await open('9.9.9.9'), await open('9.9.9.9')];
    await expect(open('9.9.9.9')).rejects.toThrow('Too many connections');
    const other = await open('8.8.8.8');
    const ask = (s: Socket, event: string, payload: object = {}) => s.timeout(2000).emitWithAck(event, payload) as Promise<Res>;

    // moving to a new room closes the empty old one, but still counts as a new room
    expect(await ask(sockets[0], 'room:create', { name: 'One' })).toMatchObject({ ok: true });
    expect(await ask(sockets[0], 'room:create', { name: 'One' })).toMatchObject({ ok: true });
    expect(limited.rooms.size).toBe(1);
    expect(await ask(sockets[1], 'room:create', { name: 'Two' })).toMatchObject({ ok: true });
    expect((await ask(sockets[2], 'room:create', { name: 'Three' })).error).toBe('Too many new rooms from your network. Try again in a few minutes');
    expect(await ask(other, 'room:create', { name: 'Elsewhere' })).toMatchObject({ ok: true });

    const fresh = createBluffServer({ limits: { liveRoomsPerIp: 1 } });
    await new Promise<void>((resolve) => fresh.httpServer.listen(0, resolve));
    const at2 = `http://localhost:${(fresh.httpServer.address() as AddressInfo).port}`;
    const s1 = connect(at2, { transports: ['websocket'], forceNew: true, reconnection: false, extraHeaders: { 'cf-connecting-ip': '7.7.7.7' } });
    const s2 = connect(at2, { transports: ['websocket'], forceNew: true, reconnection: false, extraHeaders: { 'cf-connecting-ip': '7.7.7.7' } });
    await Promise.all([s1, s2].map((s) => new Promise<void>((resolve) => s.once('connect', () => resolve()))));
    expect(await ask(s1, 'room:create', { name: 'Open' })).toMatchObject({ ok: true });
    expect((await ask(s2, 'room:create', { name: 'Second' })).error).toBe('Your network already has several rooms open. Use one of them');

    [...sockets, other, s1, s2].forEach((s) => s.disconnect());
    limited.close();
    fresh.close();
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
