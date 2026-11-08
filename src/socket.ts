import type { Server } from 'socket.io';
import { GameError } from './game.js';
import type { Member } from './models.js';
import type { Room, RoomManager } from './rooms.js';
import type { Announcement } from './types.js';
import {
  asPayload,
  parseCardIds,
  parseCardIndex,
  parseChat,
  parseCode,
  parseConfig,
  parseName,
  parsePlayId,
  parseRank,
  parseToken,
  type Payload,
} from './validate.js';

const RATE_WINDOW_MS = 10_000;
const RATE_MAX_EVENTS = 40;
const SWEEP_EVERY_MS = 30_000;

type Reply = (res: object) => void;
type Seat = { room: Room; member: Member };

/** Wires socket events to rooms; returns a stop function for the sweep timer */
export function registerHandlers(io: Server, rooms: RoomManager): () => void {
  // every player gets their own view so hands stay private
  const broadcast = (room: Room) => {
    for (const m of room.members) if (m.socketId) io.to(m.socketId).emit('state', room.view(m.id));
  };

  const publish = (room: Room, notes: Announcement[]) => {
    broadcast(room);
    for (const note of notes) io.to(room.code).emit('announce', note);
  };

  io.on('connection', (socket) => {
    const hits: number[] = [];
    let seat: Seat | null = null;

    const detach = (): Room | null => {
      if (!seat) return null;
      const { room, member } = seat;
      socket.leave(room.code);
      if (member.socketId === socket.id) {
        member.socketId = null;
        member.lastSeen = Date.now();
      }
      seat = null;
      return room;
    };

    const attach = (next: Seat) => {
      const prev = detach();
      if (prev && prev !== next.room) broadcast(prev);
      const { room, member } = next;
      // same seat opened on another tab or device: the newest one wins
      if (member.socketId && member.socketId !== socket.id) {
        const old = io.sockets.sockets.get(member.socketId);
        old?.emit('session:replaced');
        old?.disconnect(true);
      }
      member.socketId = socket.id;
      member.lastSeen = Date.now();
      socket.join(room.code);
      seat = next;
    };

    const current = (): Seat => {
      if (!seat) throw new GameError('Join a room first');
      return seat;
    };

    const on = (event: string, handler: (p: Payload) => object | void) => {
      socket.on(event, (raw: unknown, ack?: unknown) => {
        const reply: Reply = typeof ack === 'function' ? (ack as Reply) : () => {};
        try {
          const now = Date.now();
          while (hits.length > 0 && now - hits[0] > RATE_WINDOW_MS) hits.shift();
          if (hits.push(now) > RATE_MAX_EVENTS) throw new GameError('Too fast, slow down');
          reply({ ok: true, ...(handler(asPayload(raw)) ?? {}) });
        } catch (err) {
          if (!(err instanceof GameError)) console.error(`[${event}]`, err);
          reply({ ok: false, error: err instanceof GameError ? err.message : 'Something went wrong' });
        }
      });
    };

    on('room:create', (p) => {
      const next = rooms.create(parseName(p.name));
      attach(next);
      publish(next.room, [next.room.note('room', `${next.member.name} created the room`)]);
      return { code: next.room.code, token: next.member.token };
    });

    on('room:join', (p) => {
      const next = rooms.join(parseCode(p.code), parseName(p.name));
      attach(next);
      const joined = next.member.watching ? `${next.member.name} is watching` : `${next.member.name} joined`;
      publish(next.room, [next.room.note('room', joined)]);
      return { code: next.room.code, token: next.member.token };
    });

    on('room:rejoin', (p) => {
      const next = rooms.rejoin(parseCode(p.code), parseToken(p.token));
      attach(next);
      broadcast(next.room);
      return { code: next.room.code };
    });

    on('room:leave', () => {
      const { room, member } = current();
      room.removeMember(member.id);
      detach();
      publish(room, [room.note('room', `${member.name} left`)]);
    });

    on('room:config', (p) => {
      const { room, member } = current();
      room.setConfig(member.id, parseConfig(p));
      broadcast(room);
    });

    on('room:start', () => {
      const { room, member } = current();
      room.start(member.id);
      const first = room.member(room.game!.turnId!).name;
      publish(room, [room.note('round', `Game started. ${first} goes first`)]);
    });

    on('room:lobby', () => {
      const { room, member } = current();
      const wasPlaying = room.phase === 'playing';
      room.backToLobby(member.id);
      publish(room, wasPlaying ? [room.note('room', `${member.name} ended the game`)] : []);
    });

    on('game:play', (p) => {
      const { room, member } = current();
      const events = room.requireGame().play(member.id, parseCardIds(p.cardIds), parseRank(p.rank));
      publish(room, room.announce(events));
    });

    on('game:pass', () => {
      const { room, member } = current();
      publish(room, room.announce(room.requireGame().pass(member.id)));
    });

    on('game:bluff', (p) => {
      const { room, member } = current();
      const events = room.requireGame().callBluff(member.id, parsePlayId(p.playId), parseCardIndex(p.cardIndex));
      publish(room, room.announce(events));
    });

    on('chat:send', (p) => {
      const { room, member } = current();
      const { kind, index } = parseChat(p);
      io.to(room.code).emit('chat', room.chat(member.id, kind, index));
    });

    socket.on('disconnect', () => {
      const room = detach();
      if (room) broadcast(room);
    });
  });

  const timer = setInterval(() => rooms.sweep().forEach(broadcast), SWEEP_EVERY_MS);
  timer.unref();
  return () => clearInterval(timer);
}
