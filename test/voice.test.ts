import type { AddressInfo } from 'node:net';
import { io as connect, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Room } from '../src/rooms.js';
import { createBluffServer } from '../src/server.js';
import { parseConfig } from '../src/validate.js';

const bytes = (n: number) => Buffer.alloc(n, 7);

describe('the voice switch', () => {
  it('is on unless the host turns it off; older apps leave it on', () => {
    expect(parseConfig({ decks: 1, bluffRule: 'one' }).voice).toBe(true);
    expect(parseConfig({ decks: 1, bluffRule: 'one', voice: false }).voice).toBe(false);
    expect(() => parseConfig({ decks: 1, bluffRule: 'one', voice: 'yes' })).toThrow('Invalid settings');
    expect(new Room('VOIC').config.voice).toBe(true);
  });
});

describe('oversized messages', () => {
  let server: ReturnType<typeof createBluffServer>;
  let url = '';
  const opened: Socket[] = [];

  beforeAll(async () => {
    server = createBluffServer({});
    await new Promise<void>((resolve) => server.httpServer.listen(0, resolve));
    url = `http://localhost:${(server.httpServer.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    opened.forEach((s) => s.disconnect());
    server.close();
  });

  async function client(): Promise<Socket> {
    const s = connect(url, { transports: ['websocket'], forceNew: true });
    await new Promise<void>((resolve) => s.once('connect', () => resolve()));
    opened.push(s);
    return s;
  }

  it('cuts off a guest connection that sends anything big, and messages with more than one binary part', async () => {
    const guest = await client();
    const closed = new Promise<string>((resolve) => guest.once('disconnect', (reason) => resolve(reason)));
    guest.emit('chat:send', { blob: bytes(20 * 1024) });
    expect(await closed).toBe('io server disconnect');

    const other = await client();
    const dropped = new Promise<string>((resolve) => other.once('disconnect', (reason) => resolve(reason)));
    other.emit('chat:send', { a: bytes(10), b: bytes(10) });
    expect(await dropped).not.toBe('io client disconnect');
  });

  it('no longer passes on old voice notes', async () => {
    const s = await client();
    const reply = (await s.timeout(3000).emitWithAck('voice:send', { audio: bytes(10), mime: 'audio/mp4', ms: 900 }).catch(() => null)) as unknown;
    // nothing handles it any more: no answer comes back
    expect(reply).toBe(null);
  });
});
