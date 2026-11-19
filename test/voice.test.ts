import type { AddressInfo } from 'node:net';
import { MongoClient } from 'mongodb';
import { io as connect, type Socket } from 'socket.io-client';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MemberAccount } from '../src/models.js';
import { Room } from '../src/rooms.js';
import { createBluffServer } from '../src/server.js';
import { createStore, type Store } from '../src/services/store.js';
import { DEFAULT_CARD_BACK, DEFAULT_TABLE_THEME, VOICE_GAP_MS, VOICE_MAX_BYTES, VOICE_MAX_MS, type RoomView, type VoiceEvent } from '../src/types.js';
import { parseConfig, parseVoice } from '../src/validate.js';

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

const bytes = (n: number) => Buffer.alloc(n, 7);

describe('voice note settings and checks', () => {
  it('is on unless the host turns it off; older apps leave it on', () => {
    expect(parseConfig({ decks: 1, bluffRule: 'one' }).voice).toBe(true);
    expect(parseConfig({ decks: 1, bluffRule: 'one', voice: false }).voice).toBe(false);
    expect(() => parseConfig({ decks: 1, bluffRule: 'one', voice: 'yes' })).toThrow('Invalid settings');
    expect(new Room('VOIC').config.voice).toBe(true);
  });

  it('takes audio bytes in a known format, up to the size and length limits', () => {
    expect(parseVoice({ audio: bytes(2000), mime: 'audio/webm;codecs=opus', ms: 2400.4 })).toMatchObject({ mime: 'audio/webm;codecs=opus', ms: 2400 });
    expect(parseVoice({ audio: new Uint8Array(10), mime: 'audio/mp4', ms: 900 }).audio.length).toBe(10);
    expect(parseVoice({ audio: new ArrayBuffer(10), mime: 'audio/ogg; codecs="opus"', ms: 900 }).audio.length).toBe(10);
    expect(parseVoice({ audio: bytes(VOICE_MAX_BYTES), mime: 'audio/mp4', ms: VOICE_MAX_MS + 400 }).ms).toBe(VOICE_MAX_MS);
    expect(() => parseVoice({ audio: bytes(VOICE_MAX_BYTES + 1), mime: 'audio/mp4', ms: 900 })).toThrow('That voice note is too long');
    expect(() => parseVoice({ audio: bytes(0), mime: 'audio/mp4', ms: 900 })).toThrow('Invalid voice note');
    expect(() => parseVoice({ audio: 'aGVsbG8=', mime: 'audio/mp4', ms: 900 })).toThrow('Invalid voice note');
    expect(() => parseVoice({ audio: bytes(10), mime: 'text/html', ms: 900 })).toThrow('format is not supported');
    expect(() => parseVoice({ audio: bytes(10), mime: 'audio/webm"><script>', ms: 900 })).toThrow('format is not supported');
    expect(() => parseVoice({ audio: bytes(10), mime: 'audio/mp4', ms: 0 })).toThrow('Invalid voice note');
    expect(() => parseVoice({ audio: bytes(10), mime: 'audio/mp4', ms: 60_000 })).toThrow('Invalid voice note');
    expect(() => parseVoice({ audio: bytes(10), mime: 'audio/mp4' })).toThrow('Invalid voice note');
  });

  it('lets logged-in people send one every few seconds while the host allows it; guests only listen', () => {
    const r = new Room('VOIC');
    const host = r.addMember('Asha', account('Asha'));
    const guest = r.addMember('Ravi');
    const watcher = r.addMember('Meena', account('Meena'), true);
    const t = 1_000_000;
    expect(() => r.voice(guest.id, t)).toThrow('Log in to send voice notes');
    r.voice(host.id, t);
    expect(() => r.voice(host.id, t + 1_000)).toThrow(`Wait ${(VOICE_GAP_MS - 1_000) / 1000} s for your next voice note`);
    // each person has their own wait; watchers may send too
    r.voice(watcher.id, t + 1_000);
    r.voice(host.id, t + VOICE_GAP_MS);
    // leaving and joining again doesn't skip the wait
    r.removeMember(watcher.id);
    const back = r.addMember('Meena', account('Meena'), true);
    expect(() => r.voice(back.id, t + 2_000)).toThrow('for your next voice note');
    r.setConfig(host.id, { ...r.config, voice: false });
    expect(() => r.voice(back.id, t + 60_000)).toThrow('The host turned voice notes off');
    expect(() => r.voice('nobody', t)).toThrow('You are not in this room');
  });
});

// run with TEST_MONGODB_URI=mongodb://127.0.0.1:27099 (a throwaway database is created and dropped)
const MONGO = process.env.TEST_MONGODB_URI;
const DB = `bluff_voice_test_${Date.now()}`;

describe.skipIf(!MONGO)('voice notes through the server', () => {
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
    server = createBluffServer({ store, adminApiKey: 'test-admin-key-voice', authAttempts: 1000 });
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

  type Client = { socket: Socket; state: RoomView | null; heard: VoiceEvent[] };
  async function client(auth: string | null): Promise<Client> {
    const c: Client = { socket: connect(url, { transports: ['websocket'], forceNew: true, auth: auth ? { token: auth } : {} }), state: null, heard: [] };
    c.socket.on('state', (s: RoomView) => (c.state = s));
    c.socket.on('voice', (v: VoiceEvent) => c.heard.push(v));
    await new Promise<void>((resolve) => c.socket.once('connect', () => resolve()));
    opened.push(c.socket);
    return c;
  }
  const send = (c: Client, event: string, payload: object = {}) =>
    c.socket.timeout(3000).emitWithAck(event, payload) as Promise<{ ok: boolean; code?: string; error?: string }>;
  async function until(check: () => boolean) {
    const end = Date.now() + 2000;
    while (!check()) {
      if (Date.now() > end) throw new Error('timed out');
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  it('passes a note to everyone else in the room as sent, refuses guests, and stops when the host turns it off', async () => {
    const [asha, ravi] = [await client(await token('voice_asha')), await client(await token('voice_ravi'))];
    const guest = await client(null);
    const { code } = await send(asha, 'room:create', {});
    expect((await send(ravi, 'room:join', { code })).ok).toBe(true);
    expect((await send(guest, 'room:join', { code, name: 'Guesty' })).ok).toBe(true);
    await until(() => asha.state?.players.length === 3 && asha.state.config.voice === true);

    const clip = Buffer.from(Array.from({ length: 3000 }, (_, i) => i % 251));
    expect(await send(asha, 'voice:send', { audio: clip, mime: 'audio/webm;codecs=opus', ms: 2100 })).toEqual({ ok: true });
    await until(() => ravi.heard.length === 1 && guest.heard.length === 1);
    const heard = ravi.heard[0];
    expect({ ...heard, audio: null }).toEqual({ from: asha.state!.meId, audio: null, mime: 'audio/webm;codecs=opus', ms: 2100 });
    expect(Buffer.from(heard.audio).equals(clip)).toBe(true);
    // the sender doesn't get their own note back
    expect(asha.heard).toEqual([]);

    expect(await send(asha, 'voice:send', { audio: clip, mime: 'audio/mp4', ms: 900 })).toMatchObject({ ok: false, error: expect.stringMatching(/^Wait \d+ s/) });
    expect(await send(guest, 'voice:send', { audio: clip, mime: 'audio/mp4', ms: 900 })).toEqual({ ok: false, error: 'Log in to send voice notes' });
    expect(await send(ravi, 'voice:send', { audio: bytes(VOICE_MAX_BYTES + 1), mime: 'audio/mp4', ms: 900 })).toEqual({ ok: false, error: 'That voice note is too long' });

    expect((await send(asha, 'room:config', { ...asha.state!.config, voice: false })).ok).toBe(true);
    await until(() => ravi.state?.config.voice === false);
    expect(await send(ravi, 'voice:send', { audio: clip, mime: 'audio/mp4', ms: 900 })).toEqual({ ok: false, error: 'The host turned voice notes off' });
    expect(asha.heard).toEqual([]);
  });

  it('cuts off a guest connection that sends anything big, and messages with more than one binary part', async () => {
    const guest = await client(null);
    const closed = new Promise<string>((resolve) => guest.socket.once('disconnect', (reason) => resolve(reason)));
    guest.socket.emit('voice:send', { audio: bytes(20 * 1024), mime: 'audio/mp4', ms: 900 });
    expect(await closed).toBe('io server disconnect');

    const ravi = await client(await token('voice_two'));
    const dropped = new Promise<string>((resolve) => ravi.socket.once('disconnect', (reason) => resolve(reason)));
    ravi.socket.emit('voice:send', { audio: bytes(10), mime: 'audio/mp4', ms: 900, extra: bytes(10) });
    expect(await dropped).not.toBe('io client disconnect');
  });
});
