import { MongoClient, ObjectId } from 'mongodb';
import { io as connect, type Socket } from 'socket.io-client';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MessageDoc } from '../src/db/documents.js';
import { createBluffServer } from '../src/server.js';
import { DM_KEEP } from '../src/services/messages.js';
import { createStore, type Store } from '../src/services/store.js';
import { DM_MAX_LENGTH, DM_PAGE_SIZE, type DirectMessage, type DmHistoryResponse, type DmReadEvent, type DmUnreadResponse, type PublicUser } from '../src/types.js';

// run with TEST_MONGODB_URI=mongodb://127.0.0.1:27099 (a throwaway database is created and dropped)
const MONGO = process.env.TEST_MONGODB_URI;
const DB = `bluff_messages_test_${Date.now()}`;

describe.skipIf(!MONGO)('private messages (MongoDB)', () => {
  let store: Store;
  let server: ReturnType<typeof createBluffServer>;
  let raw: MongoClient;
  let url = '';
  const sockets: Socket[] = [];

  beforeAll(async () => {
    store = await createStore(
      MONGO!,
      { db: DB, users: 'users', sessions: 'sessions', games: 'games', audit: 'audit_log', friends: 'friends', settings: 'settings' },
      { defaultCoins: 1000, sessionTtlDays: 30 },
    );
    server = createBluffServer({ store, authAttempts: 1000 });
    await new Promise<void>((resolve) => server.httpServer.listen(0, resolve));
    const addr = server.httpServer.address();
    url = `http://localhost:${typeof addr === 'object' && addr ? addr.port : 0}`;
    raw = new MongoClient(MONGO!);
    await raw.connect();
  });

  afterAll(async () => {
    for (const s of sockets) s.disconnect();
    server?.close();
    await raw?.db(DB).dropDatabase();
    await raw?.close();
    await store?.close();
  });

  const api = () => request(server.app);
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  let made = 0;
  async function account() {
    const username = `dm_${++made}`;
    const res = await api().post('/api/auth/register').send({ username, password: 'secret-pass-1' });
    expect(res.status).toBe(201);
    const user = res.body.user as PublicUser;
    return { id: user.id, token: res.body.token as string, username };
  }
  type Account = Awaited<ReturnType<typeof account>>;
  async function befriend(a: Account, b: Account, accept = true) {
    expect((await api().post('/api/friends/request').set(bearer(a.token)).send({ username: b.username })).body.result).toBe('sent');
    if (accept) expect((await api().post(`/api/friends/${a.id}/accept`).set(bearer(b.token))).status).toBe(204);
  }
  const send = (from: Account, to: Account, text: unknown) => api().post(`/api/friends/${to.id}/messages`).set(bearer(from.token)).send({ text });
  const history = async (me: Account, other: Account, before?: string) =>
    (await api().get(`/api/friends/${other.id}/messages${before ? `?before=${encodeURIComponent(before)}` : ''}`).set(bearer(me.token))).body as DmHistoryResponse;
  const unread = async (me: Account) => (await api().get('/api/friends/unread').set(bearer(me.token))).body as DmUnreadResponse;
  /** a connected socket for this account */
  async function phone(a: Account): Promise<Socket> {
    const s = connect(url, { transports: ['websocket'], forceNew: true, auth: { token: a.token } });
    sockets.push(s);
    await new Promise<void>((resolve) => s.once('server:info', () => resolve()));
    return s;
  }
  const next = <T>(s: Socket, event: string) => new Promise<T>((resolve) => s.once(event, resolve));

  it('only accepted friends can message each other', async () => {
    const [a, b, c] = [await account(), await account(), await account()];
    await befriend(a, b, false);
    expect((await send(a, b, 'hi')).status).toBe(403);
    expect((await send(a, c, 'hi')).status).toBe(403);
    expect((await api().get(`/api/friends/${c.id}/messages`).set(bearer(a.token))).status).toBe(403);
    expect((await send(a, a, 'me')).status).toBe(400);
    expect((await api().post(`/api/friends/${b.id}/messages`).send({ text: 'x' })).status).toBe(401);
    await api().post(`/api/friends/${a.id}/accept`).set(bearer(b.token));
    const res = await send(a, b, '  hello there  ');
    expect(res.status).toBe(201);
    expect(res.body.message).toMatchObject({ from: a.id, to: b.id, text: 'hello there', read: false });
    // unfriended: no more messages either way
    await api().post(`/api/friends/${a.id}/remove`).set(bearer(b.token));
    expect((await send(b, a, 'still there?')).status).toBe(403);
  });

  it('checks the length after trimming', async () => {
    const [a, b] = [await account(), await account()];
    await befriend(a, b);
    expect((await send(a, b, '   ')).status).toBe(400);
    expect((await send(a, b, 42)).status).toBe(400);
    expect((await send(a, b, 'x'.repeat(DM_MAX_LENGTH + 1))).status).toBe(400);
    expect((await send(a, b, ` ${'x'.repeat(DM_MAX_LENGTH)} `)).status).toBe(201);
  });

  it('blocked accounts cannot send, and nobody can message a blocked account', async () => {
    const [a, b] = [await account(), await account()];
    await befriend(a, b);
    await raw.db(DB).collection('users').updateOne({ _id: new ObjectId(b.id) }, { $set: { blocked: true } });
    expect((await send(a, b, 'hi')).status).toBe(404);
    expect((await send(b, a, 'hi')).status).toBe(401);
  });

  it('limits each sender to 20 a minute with a friendly message', async () => {
    const [a, b, c] = [await account(), await account(), await account()];
    await befriend(a, b);
    await befriend(c, b);
    for (let i = 0; i < 20; i++) expect((await send(a, b, `m${i}`)).status).toBe(201);
    const res = await send(a, b, 'one more');
    expect(res.status).toBe(429);
    expect(res.body.error).toMatch(/too fast/);
    // someone else still can
    expect((await send(c, b, 'hi')).status).toBe(201);
  });

  it('returns history oldest first, in pages, and keeps the newest per pair', async () => {
    const [a, b] = [await account(), await account()];
    await befriend(a, b);
    const pair = [a.id, b.id].sort().join('_');
    const base = Date.now() - 1_000_000;
    const docs: MessageDoc[] = Array.from({ length: DM_KEEP + 5 }, (_, i) => ({
      _id: new ObjectId(),
      pair,
      from: new ObjectId(i % 2 ? a.id : b.id),
      to: new ObjectId(i % 2 ? b.id : a.id),
      text: `n${i}`,
      at: new Date(base + i * 1000),
      read: true,
    }));
    await raw.db(DB).collection<MessageDoc>('messages').insertMany(docs);
    const page = await history(a, b);
    expect(page.messages).toHaveLength(DM_PAGE_SIZE);
    expect(page.more).toBe(true);
    expect(page.messages.at(-1)!.text).toBe(`n${DM_KEEP + 4}`);
    expect(page.messages.map((m) => m.at)).toEqual([...page.messages.map((m) => m.at)].sort());
    const older = await history(a, b, page.messages[0].at);
    expect(older.messages.at(-1)!.text).toBe(`n${DM_KEEP + 4 - DM_PAGE_SIZE}`);
    // a new message trims the thread to the newest DM_KEEP
    expect((await send(b, a, 'newest')).status).toBe(201);
    const left = await raw.db(DB).collection<MessageDoc>('messages').find({ pair }).sort({ at: 1 }).toArray();
    expect(left).toHaveLength(DM_KEEP);
    expect(left[0].text).toBe('n6');
    expect(left.at(-1)!.text).toBe('newest');
    expect((await api().get(`/api/friends/${b.id}/messages?before=nope`).set(bearer(a.token))).status).toBe(400);
  });

  it('counts unread per friend and marks a thread read', async () => {
    const [a, b, c] = [await account(), await account(), await account()];
    await befriend(b, a);
    await befriend(c, a);
    await send(b, a, 'one');
    await send(b, a, 'two');
    await send(c, a, 'three');
    await send(a, b, 'mine');
    expect(await unread(a)).toEqual({ total: 3, byFriend: { [b.id]: 2, [c.id]: 1 } });
    expect(await unread(b)).toEqual({ total: 1, byFriend: { [a.id]: 1 } });
    expect((await api().post(`/api/friends/${b.id}/messages/read`).set(bearer(a.token))).status).toBe(204);
    expect(await unread(a)).toEqual({ total: 1, byFriend: { [c.id]: 1 } });
    expect((await history(b, a)).messages.filter((m) => m.from === b.id).every((m) => m.read)).toBe(true);
    // an ex-friend's unread messages stop counting
    await api().post(`/api/friends/${a.id}/remove`).set(bearer(c.token));
    expect(await unread(a)).toEqual({ total: 0, byFriend: {} });
  });

  it('delivers live to the receiver and the sender’s other phones, and tells both about reads', async () => {
    const [a, b] = [await account(), await account()];
    await befriend(a, b);
    const [a1, a2, b1] = [await phone(a), await phone(a), await phone(b)];
    const got = [next<DirectMessage>(a1, 'dm'), next<DirectMessage>(a2, 'dm'), next<DirectMessage>(b1, 'dm')];
    const res = await send(a, b, 'live!');
    const sent = res.body.message as DirectMessage;
    for (const m of await Promise.all(got)) expect(m).toEqual(sent);
    const reads = [next<DmReadEvent>(a1, 'dm:read'), next<DmReadEvent>(b1, 'dm:read')];
    await api().post(`/api/friends/${a.id}/messages/read`).set(bearer(b.token));
    for (const e of await Promise.all(reads)) expect(e).toEqual({ reader: b.id, other: a.id });
  });
});
