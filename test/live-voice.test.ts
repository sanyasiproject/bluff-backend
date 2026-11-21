import type { AddressInfo } from 'node:net';
import { MongoClient } from 'mongodb';
import { io as connect, type Socket } from 'socket.io-client';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MemberAccount } from '../src/models.js';
import { Room } from '../src/rooms.js';
import { createBluffServer } from '../src/server.js';
import { createStore, type Store } from '../src/services/store.js';
import { DEFAULT_CARD_BACK, DEFAULT_TABLE_THEME, RTC_MAX_SDP, type LiveVoiceJoin, type RoomView, type RtcSignal } from '../src/types.js';
import { parseRtcSignal } from '../src/validate.js';

const account = (name: string): MemberAccount => ({
  userId: `user-${name}`,
  username: name.toLowerCase(),
  coins: 1000,
  level: 1,
  stats: null,
  avatar: null,
  back: DEFAULT_CARD_BACK,
  table: DEFAULT_TABLE_THEME,
  habits: null,
});

const OFFER = { type: 'offer', sdp: 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\n' };
/** a member id in the right shape */
const ID = 'a1b2c3d4e5f6';

describe('live voice rules', () => {
  it('lets only logged-in, seated, connected people in, while the host has voice on', () => {
    const r = new Room('LIVE');
    const asha = r.addMember('Asha', account('Asha'));
    const guest = r.addMember('Ravi');
    const watcher = r.addMember('Meena', account('Meena'), true);
    for (const m of [asha, guest, watcher]) m.socketId = `s-${m.id}`;
    expect(() => r.setLive(guest.id, true)).toThrow('Log in to talk');
    expect(() => r.setLive(watcher.id, true)).toThrow('Only players in the game can talk');
    r.setLive(asha.id, true);
    expect(r.isLive(asha.id)).toBe(true);
    // offline for now: not in it, and back in once connected again
    asha.socketId = null;
    expect(r.isLive(asha.id)).toBe(false);
    asha.socketId = 's-again';
    expect(r.isLive(asha.id)).toBe(true);
    // a fresh connection starts with it off
    r.dropLive(asha.id);
    expect(r.isLive(asha.id)).toBe(false);
    r.setLive(asha.id, true);
    // the host's voice switch covers live voice too
    r.setConfig(asha.id, { ...r.config, voice: false });
    expect(r.isLive(asha.id)).toBe(false);
    expect(() => r.setLive(asha.id, true)).toThrow('The host turned voice off');
    // the mic is part of it: on shows to everyone, off means only listening
    r.setConfig(asha.id, { ...r.config, voice: true });
    r.setLive(asha.id, true, true);
    expect(r.view(asha.id).players.find((p) => p.id === asha.id)).toMatchObject({ live: true, mic: true });
    r.setLive(asha.id, true, false);
    expect(r.view(asha.id).players.find((p) => p.id === asha.id)).toMatchObject({ live: true, mic: false });
    r.setLive(asha.id, true, true);
    // turning it off always works, and takes the mic with it
    r.setLive(asha.id, false);
    expect(r.micOn(asha.id)).toBe(false);
    expect(r.view(asha.id).players.find((p) => p.id === asha.id)!.live).toBe(false);
  });

  it('takes one offer or answer for one player, of bounded size', () => {
    expect(parseRtcSignal({ to: ID, sdp: OFFER })).toEqual({ to: ID, sdp: OFFER });
    expect(() => parseRtcSignal({ to: ID, sdp: { type: 'pranswer', sdp: 'x' } })).toThrow('Invalid voice connection');
    expect(() => parseRtcSignal({ to: ID, sdp: { type: 'offer', sdp: '' } })).toThrow('Invalid voice connection');
    expect(() => parseRtcSignal({ to: ID, sdp: { type: 'offer', sdp: 'x'.repeat(RTC_MAX_SDP + 1) } })).toThrow('Invalid voice connection');
    expect(() => parseRtcSignal({ to: ID })).toThrow('Invalid voice connection');
  });
});

// run with TEST_MONGODB_URI=mongodb://127.0.0.1:27099 (a throwaway database is created and dropped)
const MONGO = process.env.TEST_MONGODB_URI;
const DB = `bluff_live_voice_test_${Date.now()}`;

describe.skipIf(!MONGO)('live voice through the server', () => {
  let store: Store;
  let server: ReturnType<typeof createBluffServer>;
  let url = '';
  const opened: Socket[] = [];

  beforeAll(async () => {
    store = await createStore(
      MONGO!,
      { db: DB, users: 'users', sessions: 'sessions', games: 'games', audit: 'audit_log', friends: 'friends', settings: 'settings' },
      { defaultCoins: 1000, sessionTtlDays: 30 },
    );
    server = createBluffServer({ store, adminApiKey: 'test-admin-key-live', authAttempts: 1000 });
    await new Promise<void>((resolve) => server.httpServer.listen(0, resolve));
    url = `http://localhost:${(server.httpServer.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    opened.forEach((s) => s.disconnect());
    server.close();
    const raw = new MongoClient(MONGO!);
    await raw.connect();
    await raw.db(DB).dropDatabase();
    await raw.close();
    await store.close();
  });

  async function token(username: string) {
    const res = await request(server.app).post('/api/auth/register').send({ username, password: 'secret-pass-1' });
    expect(res.status).toBe(201);
    return res.body.token as string;
  }

  type Client = { socket: Socket; state: RoomView | null; signals: RtcSignal[] };
  async function client(auth: string | null): Promise<Client> {
    const c: Client = { socket: connect(url, { transports: ['websocket'], forceNew: true, auth: auth ? { token: auth } : {} }), state: null, signals: [] };
    c.socket.on('state', (s: RoomView) => (c.state = s));
    c.socket.on('rtc:signal', (s: RtcSignal) => c.signals.push(s));
    await new Promise<void>((resolve) => c.socket.once('connect', () => resolve()));
    opened.push(c.socket);
    return c;
  }
  const send = (c: Client, event: string, payload: object = {}) =>
    c.socket.timeout(3000).emitWithAck(event, payload) as Promise<{ ok: boolean; code?: string; error?: string } & Partial<LiveVoiceJoin>>;
  async function until(check: () => boolean) {
    const end = Date.now() + 2000;
    while (!check()) {
      if (Date.now() > end) throw new Error('timed out');
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  const liveIn = (c: Client, id: string) => c.state?.players.find((p) => p.id === id)?.live === true;

  it('shows who is in live voice, passes connection messages only between them, and keeps watchers and guests out', async () => {
    const [asha, ravi, meena] = [await client(await token('live_asha')), await client(await token('live_ravi')), await client(await token('live_meena'))];
    const guest = await client(null);
    const { code } = await send(asha, 'room:create', {});
    expect((await send(ravi, 'room:join', { code })).ok).toBe(true);
    expect((await send(guest, 'room:join', { code, name: 'Guesty' })).ok).toBe(true);
    expect((await send(meena, 'room:join', { code })).ok).toBe(true);
    expect((await send(meena, 'room:watch', { watching: true })).ok).toBe(true);
    await until(() => asha.state?.players.length === 3 && asha.state.watchers.length === 1);
    const [ashaId, raviId, meenaId] = [asha.state!.meId, ravi.state!.meId, meena.state!.meId];

    // joining hands back how to reach the others: public STUN, no key
    const joined = await send(asha, 'voice:live', { on: true });
    expect(joined.ok).toBe(true);
    expect(JSON.stringify(joined.iceServers)).toContain('stun:');
    await until(() => liveIn(ravi, ashaId));
    expect((await send(ravi, 'voice:live', { on: true })).ok).toBe(true);
    await until(() => liveIn(asha, raviId));

    // an offer reaches only the player it's for, from whom it came
    expect((await send(asha, 'rtc:signal', { to: raviId, sdp: OFFER })).ok).toBe(true);
    await until(() => ravi.signals.length === 1);
    expect(ravi.signals[0]).toEqual({ from: ashaId, sdp: OFFER });
    expect(meena.signals).toEqual([]);
    expect(guest.signals).toEqual([]);

    // watchers and guests can't join or be reached
    expect(await send(meena, 'voice:live', { on: true })).toMatchObject({ ok: false, error: 'Only players in the game can talk. Watchers just watch' });
    expect(await send(guest, 'voice:live', { on: true })).toMatchObject({ ok: false, error: 'Log in to talk' });
    expect(await send(asha, 'rtc:signal', { to: meenaId, sdp: OFFER })).toMatchObject({ ok: false, error: 'They left live voice' });
    expect(await send(guest, 'rtc:signal', { to: ashaId, sdp: OFFER })).toMatchObject({ ok: false, error: 'Turn live voice on first' });

    // leaving voice, or dropping off, takes them out for everyone
    expect((await send(ravi, 'voice:live', { on: false })).ok).toBe(true);
    await until(() => !liveIn(asha, raviId));
    expect(await send(asha, 'rtc:signal', { to: raviId, sdp: OFFER })).toMatchObject({ ok: false, error: 'They left live voice' });
    expect((await send(ravi, 'voice:live', { on: true })).ok).toBe(true);
    await until(() => liveIn(asha, raviId));
    ravi.socket.disconnect();
    await until(() => !liveIn(asha, raviId));

    // the host's voice switch turns it off for everyone
    expect((await send(asha, 'room:config', { ...asha.state!.config, voice: false })).ok).toBe(true);
    await until(() => asha.state?.config.voice === false);
    expect(liveIn(asha, ashaId)).toBe(false);
  });
});
