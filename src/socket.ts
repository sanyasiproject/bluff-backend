import type { Server } from 'socket.io';
import { GameError } from './game.js';
import type { GameEvent, GameRecord, Member, MemberAccount, SocketHooks, SocketUser } from './models.js';
import { Presence } from './presence.js';
import type { Room, RoomManager } from './rooms.js';
import type { Announcement, InviteEvent } from './types.js';
import {
  asPayload,
  parseBet,
  parseCardIds,
  parseCardIndex,
  parseChat,
  parseCode,
  parseConfig,
  parseFlag,
  parseMemberId,
  parseName,
  parsePlayId,
  parseRank,
  parseSlot,
  parseToken,
  parseUserId,
  type Payload,
} from './validate.js';

const RATE_WINDOW_MS = 10_000;
const RATE_MAX_EVENTS = 40;
const SWEEP_EVERY_MS = 30_000;

type Reply = (res: object) => void;
type Seat = { room: Room; member: Member };

const formatCoins = (n: number) => n.toLocaleString('en-IN');
const listNames = (members: Member[]) => members.map((m) => m.name).join(', ');

/** Wires socket events to rooms; returns a stop function for the sweep timer */
export function registerHandlers(
  io: Server,
  rooms: RoomManager,
  hooks: SocketHooks = {},
  presence: Presence = new Presence(),
): () => void {
  // every player gets their own view so hands stay private
  const broadcast = (room: Room) => {
    for (const m of room.members) if (m.socketId) io.to(m.socketId).emit('state', room.view(m.id));
  };

  const publish = (room: Room, notes: Announcement[]) => {
    broadcast(room);
    for (const note of notes) io.to(room.code).emit('announce', note);
  };

  /** saves in the background, then shows everyone the coin changes */
  const saveGame = (room: Room, record: GameRecord | null) => {
    if (!record || !hooks.onGameEnd) return;
    const game = room.game;
    // a quick rematch waits for this, so coin balances are settled before they're checked
    room.saving = hooks
      .onGameEnd(record)
      .then((results) => {
        for (const r of results) {
          const m = room.members.find((x) => x.id === r.playerId);
          if (m && r.coins !== null) m.coins = r.coins;
          if (m && r.level !== null) m.level = r.level;
        }
        if (room.game === game) room.coinResults = results;
        broadcast(room);
      })
      .catch((err: Error) => console.error('[games] could not save game:', err.message));
  };

  const afterMove = (room: Room, events: GameEvent[]) => {
    publish(room, room.announce(events));
    if (events.some((e) => e.kind === 'gameOver')) saveGame(room, room.snapshot(room.game?.aborted ? 'ended_early' : 'finished'));
  };

  /** coin checks for a staked game, then deal; shared by Start and Play again */
  const startGame = async (room: Room, member: Member, label: string) => {
    const stake = room.config.stake;
    if (stake > 0) {
      if (room.starting) throw new GameError('Already starting');
      const seated = room.players();
      const guests = seated.filter((m) => !m.userId);
      if (guests.length > 0) {
        throw new GameError(`${listNames(guests)}: guests can only play Free games. Log in or set the stake to Free`);
      }
      if (!hooks.getAccounts) throw new GameError('Coins are not available on this server');
      room.starting = true;
      try {
        await room.saving;
        // coins only move at the end; here we just make sure everyone can pay
        const accounts = await hooks.getAccounts(seated.map((m) => m.userId!));
        for (const m of seated) m.coins = accounts.get(m.userId!)?.coins ?? 0;
        const short = seated.filter((m) => (m.coins ?? 0) < stake);
        if (short.length > 0) {
          broadcast(room);
          throw new GameError(`Not enough coins for a ${formatCoins(stake)} stake: ${listNames(short)}`);
        }
        const now = room.players();
        if (now.length !== seated.length || now.some((m, i) => m !== seated[i])) throw new GameError('Players changed, tap Start again');
      } finally {
        room.starting = false;
      }
    }
    room.start(member.id);
    const first = room.member(room.game!.turnId!).name;
    const pot = stake > 0 ? `. Pot: ${formatCoins(stake * room.game!.order.length)} coins` : '';
    publish(room, [room.note('round', `${label}. ${first} goes first${pot}`)]);
  };

  /** the account a logged-in socket joins with; balance and level are read fresh */
  const accountOf = async (u: SocketUser | undefined): Promise<MemberAccount | null> => {
    if (!u) return null;
    let fresh: { coins: number; level: number } | undefined;
    try {
      fresh = (await hooks.getAccounts?.([u.id]))?.get(u.id);
    } catch {
      // shown as unknown until the next game ends
    }
    return { userId: u.id, username: u.username, coins: fresh?.coins ?? null, level: fresh?.level ?? null };
  };

  // a login token in the handshake makes this socket that account; no or bad token means guest
  io.use((socket, next) => {
    const token = (socket.handshake.auth as { token?: unknown } | undefined)?.token;
    if (typeof token !== 'string' || !token || !hooks.resolveUser) return next();
    hooks
      .resolveUser(token)
      .then((user) => {
        if (user) socket.data.user = user;
      })
      .catch((err: Error) => console.error('[auth] token check failed:', err.message))
      .finally(() => next());
  });

  io.on('connection', (socket) => {
    const hits: number[] = [];
    const user = socket.data.user as SocketUser | undefined;
    if (user) presence.add(user.id, socket.id);
    // logged-in players always use their account name
    const nameFrom = (p: Payload) => user?.displayName ?? parseName(p.name);
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
      // the host may have removed this player since
      if (!seat.room.members.includes(seat.member)) {
        seat = null;
        throw new GameError('You were removed from this room');
      }
      return seat;
    };

    const on = (event: string, handler: (p: Payload) => object | void | Promise<object | void>) => {
      socket.on(event, async (raw: unknown, ack?: unknown) => {
        const reply: Reply = typeof ack === 'function' ? (ack as Reply) : () => {};
        try {
          const now = Date.now();
          while (hits.length > 0 && now - hits[0] > RATE_WINDOW_MS) hits.shift();
          if (hits.push(now) > RATE_MAX_EVENTS) throw new GameError('Too fast, slow down');
          reply({ ok: true, ...((await handler(asPayload(raw))) ?? {}) });
        } catch (err) {
          if (!(err instanceof GameError)) console.error(`[${event}]`, err);
          reply({ ok: false, error: err instanceof GameError ? err.message : 'Something went wrong' });
        }
      });
    };

    on('room:create', async (p) => {
      const name = nameFrom(p);
      const next = rooms.create(name, await accountOf(user));
      attach(next);
      // nobody else is in a new room yet, so there is nothing to announce
      publish(next.room, []);
      return { code: next.room.code, token: next.member.token };
    });

    on('room:join', async (p) => {
      const code = parseCode(p.code);
      const name = nameFrom(p);
      const next = rooms.join(code, name, await accountOf(user));
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

    on('room:start', async () => {
      const { room, member } = current();
      room.assertCanStart(member.id);
      await startGame(room, member, 'Game started');
    });

    on('room:rematch', async () => {
      const { room, member } = current();
      room.rematch(member.id);
      try {
        room.assertCanStart(member.id);
        await startGame(room, member, 'Rematch');
      } catch (err) {
        // can't deal again (e.g. someone is short of coins): everyone lands in the lobby instead
        broadcast(room);
        throw err;
      }
    });

    on('room:lobby', () => {
      const { room, member } = current();
      const wasPlaying = room.phase === 'playing';
      // snapshot before the game is cleared; a stopped game moves no coins
      const record = wasPlaying ? room.snapshot('ended_early') : null;
      saveGame(room, record);
      room.backToLobby(member.id);
      publish(room, wasPlaying ? [room.note('room', `${member.name} stopped the game. No coins moved`)] : []);
    });

    // yourself, or (host only) anyone else in the room
    on('room:watch', (p) => {
      const { room, member } = current();
      const watching = parseFlag(p.watching, 'Watching');
      const targetId = p.memberId === undefined ? member.id : parseMemberId(p.memberId);
      const target = room.setWatching(member.id, targetId, watching);
      const now = watching ? 'watching' : 'playing';
      const text = target === member ? `${target.name} is ${now}` : `${member.name} moved ${target.name} to ${now}`;
      publish(room, [room.note('room', text)]);
    });

    on('room:slot', (p) => {
      const { room, member } = current();
      room.moveToSlot(member.id, parseSlot(p.slot));
      broadcast(room);
    });

    on('room:swap', (p) => {
      const { room, member } = current();
      const target = room.askSwap(member.id, parseMemberId(p.memberId));
      publish(room, [room.note('room', `${member.name} asked ${target.name} to swap places`)]);
    });

    on('room:swapAnswer', (p) => {
      const { room, member } = current();
      const accept = parseFlag(p.accept, 'Answer');
      const from = room.answerSwap(member.id, parseMemberId(p.memberId), accept);
      publish(room, [room.note('room', accept ? `${from.name} and ${member.name} swapped places` : `${member.name} said no to swapping`)]);
    });

    on('room:teams', () => {
      const { room, member } = current();
      room.shuffleTeams(member.id);
      publish(room, [room.note('room', `${member.name} shuffled the teams`)]);
    });

    on('room:host', (p) => {
      const { room, member } = current();
      const target = room.transferHost(member.id, parseMemberId(p.memberId));
      publish(room, [room.note('room', `${member.name} made ${target.name} the host`)]);
    });

    on('room:end', () => {
      const { room, member } = current();
      afterMove(room, room.endGame(member.id));
    });

    on('room:kick', (p) => {
      const { room, member } = current();
      const { kicked, events } = room.kick(member.id, parseMemberId(p.memberId));
      if (kicked.socketId) {
        const target = io.sockets.sockets.get(kicked.socketId);
        target?.leave(room.code);
        target?.emit('room:kicked', { code: room.code });
      }
      publish(room, [room.note('room', `${kicked.name} was removed by the host`), ...room.announce(events)]);
      if (events.some((e) => e.kind === 'gameOver')) saveGame(room, room.snapshot(room.game?.aborted ? 'ended_early' : 'finished'));
    });

    on('friend:invite', async (p) => {
      const { room } = current();
      if (!user) throw new GameError('Log in to invite friends');
      const friendId = parseUserId(p.userId);
      if (!hooks.areFriends || !(await hooks.areFriends(user.id, friendId))) throw new GameError('You can only invite friends');
      // someone already in a room is never invited, whether it's this room or another one
      const theirRoom = rooms.roomOfUser(friendId);
      if (theirRoom === room) throw new GameError('Your friend is already in this room');
      if (theirRoom) throw new GameError('Your friend is already in another room');
      const sockets = presence.socketsOf(friendId);
      if (sockets.length === 0) throw new GameError('Your friend is offline. Send the WhatsApp link instead');
      const invite: InviteEvent = { fromId: user.id, fromName: user.displayName, code: room.code };
      for (const id of sockets) io.to(id).emit('invite', invite);
    });

    on('game:play', (p) => {
      const { room, member } = current();
      afterMove(room, room.requireGame().play(member.id, parseCardIds(p.cardIds), parseRank(p.rank)));
    });

    on('game:pass', () => {
      const { room, member } = current();
      afterMove(room, room.requireGame().pass(member.id));
    });

    on('game:bluff', (p) => {
      const { room, member } = current();
      const game = room.requireGame();
      const bet = room.checkBet(member, parseBet(p.bet));
      afterMove(room, game.callBluff(member.id, parsePlayId(p.playId), parseCardIndex(p.cardIndex), bet));
    });

    // the card goes back only to this player; everyone else just learns a peek happened
    on('game:peek', (p) => {
      const { room, member } = current();
      const card = room.requireGame().peek(member.id, parsePlayId(p.playId), parseCardIndex(p.cardIndex) ?? -1);
      publish(room, [room.note('room', `${member.name} used a peek 🔍`)]);
      return { card };
    });

    on('chat:send', (p) => {
      const { room, member } = current();
      const { kind, index } = parseChat(p);
      io.to(room.code).emit('chat', room.chat(member.id, kind, index));
    });

    socket.on('disconnect', () => {
      if (user) presence.remove(user.id, socket.id);
      const room = detach();
      if (room) broadcast(room);
    });
  });

  const timer = setInterval(() => rooms.sweep().forEach(broadcast), SWEEP_EVERY_MS);
  timer.unref();
  return () => clearInterval(timer);
}
