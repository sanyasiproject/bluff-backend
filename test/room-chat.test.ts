import type { AddressInfo } from 'node:net';
import { io as connect, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Room } from '../src/rooms.js';
import { createBluffServer } from '../src/server.js';
import { QUICK_MESSAGES, ROOM_CHAT_LENGTH, ROOM_CHAT_MAX, type RoomMessage } from '../src/types.js';
import { parseRoomText } from '../src/validate.js';

describe('room chat rules', () => {
  it('keeps the last ROOM_CHAT_MAX lines, oldest first, with the name at the time', () => {
    const r = new Room('CHAT');
    const asha = r.addMember('Asha');
    for (let i = 0; i < ROOM_CHAT_MAX + 20; i++) r.addMessage(asha.id, `line ${i}`, true);
    expect(r.messages).toHaveLength(ROOM_CHAT_MAX);
    expect(r.messages[0].text).toBe('line 20');
    expect(r.messages.at(-1)).toMatchObject({ from: asha.id, name: 'Asha', username: null, text: `line ${ROOM_CHAT_MAX + 19}`, quick: true });
    // ids keep growing, so the app can tell new lines apart
    expect(r.messages.at(-1)!.id).toBe(ROOM_CHAT_MAX + 20);
  });

  it('slows down typed lines and checks their length', () => {
    const r = new Room('CHAT');
    const asha = r.addMember('Asha');
    r.addMessage(asha.id, 'hi', false);
    expect(() => r.addMessage(asha.id, 'again', false)).toThrow('Slow down');
    expect(() => r.addMessage('nobody', 'hi', false)).toThrow('You are not in this room');
    expect(parseRoomText('  hello \n there  ')).toBe('hello there');
    expect(() => parseRoomText('   ')).toThrow('Type a message first');
    expect(() => parseRoomText(42)).toThrow('Type a message first');
    expect(parseRoomText('x'.repeat(ROOM_CHAT_LENGTH))).toHaveLength(ROOM_CHAT_LENGTH);
    expect(() => parseRoomText('x'.repeat(ROOM_CHAT_LENGTH + 1))).toThrow(`up to ${ROOM_CHAT_LENGTH}`);
  });
});

describe('room chat through the server', () => {
  let server: ReturnType<typeof createBluffServer>;
  let url = '';
  const opened: Socket[] = [];

  beforeAll(async () => {
    server = createBluffServer({ limits: { createsPerIp: 10_000, liveRoomsPerIp: 10_000, connectionsPerIp: 1_000 } });
    await new Promise<void>((resolve) => server.httpServer.listen(0, resolve));
    url = `http://localhost:${(server.httpServer.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    opened.forEach((s) => s.disconnect());
    server.close();
  });

  type Client = { socket: Socket; got: RoomMessage[] };
  async function client(): Promise<Client> {
    const c: Client = { socket: connect(url, { transports: ['websocket'], forceNew: true }), got: [] };
    c.socket.on('room:msg', (m: RoomMessage) => c.got.push(m));
    await new Promise<void>((resolve) => c.socket.once('connect', () => resolve()));
    opened.push(c.socket);
    return c;
  }
  const send = (c: Client, event: string, payload: object = {}) =>
    c.socket.timeout(2000).emitWithAck(event, payload) as Promise<{ ok: boolean; error?: string; code?: string; messages?: RoomMessage[] }>;
  async function until(check: () => boolean) {
    const end = Date.now() + 2000;
    while (!check()) {
      if (Date.now() > end) throw new Error('timed out');
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  it('sends typed and Quick Chat lines to everyone, and gives a late joiner the whole list', async () => {
    const [a, b] = [await client(), await client()];
    const { code } = await send(a, 'room:create', { name: 'Asha' });
    expect((await send(b, 'room:join', { code, name: 'Ravi' })).ok).toBe(true);
    expect((await send(a, 'room:say', { text: 'Kaun aa raha hai?' })).ok).toBe(true);
    expect((await send(b, 'chat:send', { kind: 'message', index: 0 })).ok).toBe(true);
    // emoji reactions stay out of the list
    await new Promise((r) => setTimeout(r, 750));
    expect((await send(b, 'chat:send', { kind: 'reaction', index: 0 })).ok).toBe(true);
    await until(() => a.got.length === 2 && b.got.length === 2);
    expect(a.got.map((m) => [m.name, m.text, m.quick])).toEqual([
      ['Asha', 'Kaun aa raha hai?', false],
      ['Ravi', QUICK_MESSAGES[0], true],
    ]);
    expect((await send(a, 'room:say', { text: '' })).error).toBe('Type a message first');

    const late = await client();
    expect((await send(late, 'room:join', { code, name: 'Meena' })).ok).toBe(true);
    const { messages } = await send(late, 'room:messages');
    expect(messages!.map((m) => m.text)).toEqual(['Kaun aa raha hai?', QUICK_MESSAGES[0]]);
    // nobody outside a room gets a list
    const outside = await client();
    expect((await send(outside, 'room:messages')).ok).toBe(false);
  });
});
