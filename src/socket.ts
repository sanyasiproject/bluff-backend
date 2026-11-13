import type { Server, Socket } from 'socket.io';
import { BotDriver } from './bots/driver.js';
import { Crazy7Bots } from './crazy7/driver.js';
import { GameError } from './game.js';
import type { AccountInfo, GameEvent, GameRecord, Member, MemberAccount, SocketHooks, SocketUser, WatchRequest } from './models.js';
import { Presence } from './presence.js';
import type { Room, RoomManager } from './rooms.js';
import { BOT_MAX_STAKE, type Announcement, type GiftEvent, type GiftReceived, type InviteEvent, type ServerInfo } from './types.js';
import {
  asPayload,
  parseBet,
  parseCardId,
  parseCardIds,
  parseCardIndex,
  parseChat,
  parseCode,
  parseConfig,
  parseFlag,
  parseGift,
  parseMemberId,
  parseName,
  parsePlayId,
  parseRank,
  parseSlot,
  parseThrow,
  parseToken,
  parseUserId,
  type Payload,
} from './validate.js';

const RATE_WINDOW_MS = 10_000;
const RATE_MAX_EVENTS = 40;
const SWEEP_EVERY_MS = 30_000;
/** open connections allowed per network (IP) by default; friends on one Wi-Fi share an address */
export const MAX_CONNECTIONS_PER_IP = 50;

/** the caller's network address: Cloudflare's header on Render, else the last proxy hop (earlier ones can be forged) */
export function clientIp(socket: Socket): string {
  const h = socket.handshake.headers;
  const cf = h['cf-connecting-ip'];
  if (typeof cf === 'string' && cf.trim()) return cf.trim();
  const xff = Array.isArray(h['x-forwarded-for']) ? h['x-forwarded-for'].join(',') : (h['x-forwarded-for'] ?? '');
  return xff.split(',').map((s) => s.trim()).filter(Boolean).pop() || socket.handshake.address;
}

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
  maxConnectionsPerIp = MAX_CONNECTIONS_PER_IP,
  /** bots' thinking pace: 1 = human-like; tests use a small number */
  botSpeed = 1,
): () => void {
  // every player gets their own view so hands stay private; bots then plan their next move
  const broadcast = (room: Room) => {
    for (const m of room.members) if (m.socketId) io.to(m.socketId).emit('state', room.view(m.id));
    bots.wake(room);
    c7bots.wake(room);
  };

  const publish = (room: Room, notes: Announcement[]) => {
    broadcast(room);
    for (const note of notes) io.to(room.code).emit('announce', note);
  };

  /** saves in the background, then shows everyone the coin changes */
  const saveGame = (room: Room, record: GameRecord | null) => {
    if (!record || !hooks.onGameEnd) return;
    const game = room.table;
    // a quick rematch waits for this, so coin balances are settled before they're checked
    room.saving = hooks
      .onGameEnd(record)
      .then((results) => {
        for (const r of results) {
          const m = room.members.find((x) => x.id === r.playerId);
          if (m && r.coins !== null) m.coins = r.coins;
          if (m && r.level !== null) m.level = r.level;
        }
        if (room.table === game) room.coinResults = results;
        broadcast(room);
      })
      .catch((err: Error) => console.error('[games] could not save game:', err.message));
  };

  const afterMove = (room: Room, events: GameEvent[], notes: Announcement[] = []) => {
    // once no person holds cards against the bots, the result is settled
    const all = [...events, ...room.endIfOnlyBots()];
    bots.observe(room, all);
    c7bots.observe(room, all);
    publish(room, [...notes, ...room.announce(all)]);
    if (all.some((e) => e.kind === 'gameOver')) saveGame(room, room.snapshot(room.table?.aborted ? 'ended_early' : 'finished'));
  };

  /** after someone leaves: a room with no person left never carries on with bots alone */
  const afterExit = (room: Room, events: GameEvent[], notes: Announcement[]) => {
    if (room.hasPeople) return afterMove(room, events, notes);
    const all = [...events, ...room.endGameNow()];
    if (all.some((e) => e.kind === 'gameOver')) saveGame(room, room.snapshot('finished'));
    room.clearBots();
    bots.forget(room);
    c7bots.forget(room);
    rooms.dropIfEmpty(room);
  };

  const bots = new BotDriver(
    {
      onMove: (room, events) => afterMove(room, events),
      onPeek: (room, bot) => publish(room, [room.note('room', `${bot.name} used a peek 🔍`)]),
      onChat: (room, chat) => io.to(room.code).emit('chat', chat),
    },
    (room) => rooms.isOpen(room),
    botSpeed,
  );

  // Crazy 7 bots: same table, their own brain
  const c7bots = new Crazy7Bots(
    {
      onMove: (room, events) => afterMove(room, events),
      onChat: (room, chat) => io.to(room.code).emit('chat', chat),
    },
    (room) => rooms.isOpen(room),
    botSpeed,
  );

  /** coin checks for a staked game, then deal; shared by Start and Play again */
  const startGame = async (room: Room, member: Member, label: string) => {
    const stake = room.config.stake;
    if (stake > 0) {
      if (room.starting) throw new GameError('Already starting');
      const seated = room.players();
      if (stake > BOT_MAX_STAKE && seated.some((m) => m.bot)) throw new GameError(`With bots at the table the stake can be up to ${BOT_MAX_STAKE}`);
      // bots have no coins: only the people pay in
      const people = seated.filter((m) => !m.bot);
      const guests = people.filter((m) => !m.userId);
      if (guests.length > 0) {
        throw new GameError(`${listNames(guests)}: guests can only play Free games. Log in or set the stake to Free`);
      }
      if (!hooks.getAccounts) throw new GameError('Coins are not available on this server');
      room.starting = true;
      try {
        await room.saving;
        // coins only move at the end; here we just make sure everyone can pay
        const accounts = await hooks.getAccounts(people.map((m) => m.userId!));
        for (const m of people) {
          const a = accounts.get(m.userId!);
          m.coins = a?.coins ?? 0;
          if (a) m.stats = a.stats;
        }
        const short = people.filter((m) => (m.coins ?? 0) < stake);
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
    const table = room.table!;
    const first = table.turnId ? room.member(table.turnId).name : 'Someone';
    const pot = stake > 0 ? `. Pot: ${formatCoins(stake * table.order.length)} coins` : '';
    // Crazy 7's first turn may already have picked a card for that player
    const opening = room.c7?.opening ?? [];
    c7bots.observe(room, opening);
    publish(room, [room.note('round', `${label}. ${first} goes first${pot}`), ...room.announce(opening)]);
  };

  /** the account a logged-in socket joins with; balance and level are read fresh */
  /** let a waiting person in (watching mid-game, a seat back in the lobby); their app rejoins with the seat token */
  const admit = (room: Room, req: WatchRequest) => {
    // they closed the app while waiting
    if (!io.sockets.sockets.get(req.socketId)) {
      broadcast(room);
      return;
    }
    try {
      const added = room.addMember(req.name, req.account);
      io.to(req.socketId).emit('watch:admitted', { code: room.code, token: added.token, name: added.name });
      publish(room, [room.note('room', added.watching ? `${added.name} is watching` : `${added.name} joined`)]);
    } catch (err) {
      io.to(req.socketId).emit('watch:denied', { code: room.code, reason: err instanceof GameError ? err.message : undefined });
      broadcast(room);
    }
  };

  const accountOf = async (u: SocketUser | undefined): Promise<MemberAccount | null> => {
    if (!u) return null;
    let fresh: AccountInfo | undefined;
    try {
      fresh = (await hooks.getAccounts?.([u.id]))?.get(u.id);
    } catch {
      // shown as unknown until the next game ends
    }
    return { userId: u.id, username: u.username, coins: fresh?.coins ?? null, level: fresh?.level ?? null, stats: fresh?.stats ?? null };
  };

  /** accounts on or off, and whether guests may play right now */
  const serverInfo = (): ServerInfo => ({ accounts: !!hooks.resolveUser, guestsAllowed: hooks.guestsAllowed ? hooks.guestsAllowed() : true });

  // a login token in the handshake makes this socket that account; no or bad token means guest
  const connections = new Map<string, number>();
  io.use((socket, next) => {
    const ip = clientIp(socket);
    if ((connections.get(ip) ?? 0) >= maxConnectionsPerIp) return next(new Error('Too many connections from your network'));
    socket.data.ip = ip;
    next();
  });

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
    const ip = socket.data.ip as string;
    connections.set(ip, (connections.get(ip) ?? 0) + 1);
    if (user) presence.add(user.id, socket.id);
    // the app shows Log in and the guest lock from this even when its /health check is blocked
    socket.emit('server:info', serverInfo());
    /** a room this connection asked to watch, waiting for the host */
    let pendingIn: Room | null = null;
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

    /** one room at a time: an old lobby or watcher seat elsewhere is given up; a game you're playing must be finished or left */
    const releaseOthers = (target: Room | null) => {
      const old: Seat[] = [];
      if (seat && seat.room !== target) old.push(seat);
      const other = user ? rooms.roomOfUser(user.id) : null;
      if (other && other !== target && !old.some((o) => o.room === other)) {
        old.push({ room: other, member: other.members.find((m) => m.userId === user!.id)! });
      }
      for (const { room, member } of old) {
        if (member.socketId && member.socketId !== socket.id) {
          throw new GameError(`You're already in room ${room.code} on another device or tab. Leave it there first`);
        }
        if (room.phase === 'playing' && room.table?.order.includes(member.id) && room.table.hand(member.id).length > 0) {
          throw new GameError(`You're in a game in room ${room.code}. Finish it or leave it first`);
        }
      }
      for (const { room, member } of old) {
        if (seat?.member === member) detach();
        afterExit(room, room.removeMember(member.id), [room.note('room', `${member.name} left`)]);
      }
      if (pendingIn && pendingIn !== target && pendingIn.dropWatchRequests(socket.id)) broadcast(pendingIn);
    };

    // an admin can turn guest play off; guests already in a room keep their seat
    const assertMayPlay = () => {
      if (!user && hooks.guestsAllowed && !hooks.guestsAllowed()) {
        // this app may have missed the switch: it shows the log-in card straight away
        socket.emit('server:info', serverInfo());
        throw new GameError('Guest play is off right now. Log in to play');
      }
    };

    on('room:create', async (p) => {
      assertMayPlay();
      const name = nameFrom(p);
      releaseOthers(null);
      const next = rooms.create(name, await accountOf(user), ip);
      attach(next);
      // nobody else is in a new room yet, so there is nothing to announce
      publish(next.room, []);
      return { code: next.room.code, token: next.member.token };
    });

    /** an account waits by account before asking again; a guest by network and name */
    const requestKey = (name: string) => (user ? `u:${user.id}` : `g:${ip}:${name.toLowerCase()}`);
    const watchFlag = (p: Payload) => (p.watch === undefined ? false : parseFlag(p.watch, 'Watch'));

    /** watch: sit out and watch (lobby); once a game is on, every join is a request to the host */
    const joinRoom = async (room: Room, name: string, watch: boolean) => {
      releaseOthers(room);
      const account = await accountOf(user);
      // a game is running: ask the host first; they answer from their requests list
      if (room.needsApproval) {
        room.requestWatch(name, account, socket.id, requestKey(name));
        pendingIn = room;
        broadcast(room);
        return { code: room.code, pending: true };
      }
      const next = rooms.join(room.code, name, account, watch);
      attach(next);
      const joined = next.member.watching ? `${next.member.name} is watching` : `${next.member.name} joined`;
      publish(next.room, [next.room.note('room', joined)]);
      return { code: next.room.code, token: next.member.token };
    };

    on('room:join', async (p) => {
      assertMayPlay();
      const code = parseCode(p.code);
      const name = nameFrom(p);
      return joinRoom(rooms.get(code), name, watchFlag(p));
    });

    // straight from the Friends list: join or watch their room in the lobby, ask the host once a game is on
    on('friend:join', async (p) => {
      if (!user) throw new GameError('Log in to join friends');
      const friendId = parseUserId(p.userId);
      const watch = watchFlag(p);
      if (!hooks.areFriends || !(await hooks.areFriends(user.id, friendId))) throw new GameError('You can only join friends');
      const room = rooms.roomOfUser(friendId);
      if (!room) throw new GameError('Your friend is not in a room right now');
      if (room === seat?.room) throw new GameError("You're already in this room");
      return joinRoom(room, user.displayName, watch);
    });

    on('room:rejoin', (p) => {
      const next = rooms.rejoin(parseCode(p.code), parseToken(p.token));
      attach(next);
      broadcast(next.room);
      return { code: next.room.code };
    });

    // mid-game this is a forfeit: the player loses and still pays a stake
    on('room:leave', () => {
      const { room, member } = current();
      const inGame = room.phase === 'playing' && !!room.table?.order.includes(member.id);
      const events = room.removeMember(member.id);
      detach();
      afterExit(room, events, [room.note('room', inGame ? `${member.name} left the game` : `${member.name} left`)]);
    });

    on('room:cancelRequest', () => {
      if (pendingIn?.dropWatchRequests(socket.id)) broadcast(pendingIn);
      pendingIn = null;
    });

    // the host lets someone watch the game in progress, or not
    on('room:admit', (p) => {
      const { room, member } = current();
      const accept = parseFlag(p.accept, 'Answer');
      const req = room.takeWatchRequest(member.id, parseMemberId(p.requestId), accept);
      if (!accept) {
        io.to(req.socketId).emit('watch:denied', { code: room.code });
        broadcast(room);
        return;
      }
      admit(room, req);
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
      // anyone still waiting to watch can simply come in now
      for (const req of room.takeAllWatchRequests()) admit(room, req);
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

    // the host seats a bot; with bots the stake is capped
    on('room:addBot', () => {
      const { room, member } = current();
      const { bot, stakeLowered } = bots.add(room, member.id);
      const notes = [room.note('room', `${member.name} added ${bot.name} 🤖`)];
      if (stakeLowered) notes.push(room.note('room', `With bots at the table the stake is now ${BOT_MAX_STAKE}`));
      publish(room, notes);
    });

    on('room:slot', (p) => {
      const { room, member } = current();
      room.moveToSlot(member.id, parseSlot(p.slot));
      broadcast(room);
    });

    on('room:swap', (p) => {
      const { room, member } = current();
      const target = room.askSwap(member.id, parseMemberId(p.memberId));
      // bots always say yes
      if (target.bot) {
        room.answerSwap(target.id, member.id, true);
        publish(room, [room.note('room', `${member.name} and ${target.name} swapped places`)]);
        return;
      }
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
      afterExit(room, events, [room.note('room', `${kicked.name} was removed by the host`)]);
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

    // Crazy 7: one card on the pile, pick from the deck, end the turn, or say last card
    on('c7:play', (p) => {
      const { room, member } = current();
      afterMove(room, room.requireCrazy7().play(member.id, parseCardId(p.cardId)));
    });

    on('c7:pick', () => {
      const { room, member } = current();
      afterMove(room, room.requireCrazy7().pick(member.id));
    });

    on('c7:pass', () => {
      const { room, member } = current();
      afterMove(room, room.requireCrazy7().pass(member.id));
    });

    on('c7:call', () => {
      const { room, member } = current();
      afterMove(room, room.requireCrazy7().call(member.id));
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

    // an emoji flies from one person to another; everyone in the room sees it
    on('chat:throw', (p) => {
      const { room, member } = current();
      const { to, index } = parseThrow(p);
      io.to(room.code).emit('throw', room.throwAt(member.id, to, index));
    });

    // coins for a friend, picked in the friends list (userId) or in this room (memberId)
    on('friend:gift', async (p) => {
      if (!user) throw new GameError('Log in to send coins');
      if (!hooks.giftCoins || !hooks.areFriends) throw new GameError('Coins are not available on this server');
      const amount = parseGift(p.amount);
      let friendId: string;
      if (p.memberId !== undefined) {
        const target = current().room.members.find((m) => m.id === parseMemberId(p.memberId));
        if (!target?.userId) throw new GameError('Only logged-in friends can get coins');
        friendId = target.userId;
      } else {
        friendId = parseUserId(p.userId);
      }
      if (!(await hooks.areFriends(user.id, friendId))) throw new GameError('You can only send coins to friends');
      const res = await hooks.giftCoins(user.id, friendId, amount);
      // rooms show the new balances at once; in a shared room everyone sees the coins fly
      const fromRoom = rooms.roomOfUser(user.id);
      const toRoom = rooms.roomOfUser(friendId);
      const giver = fromRoom?.members.find((m) => m.userId === user.id);
      const taker = toRoom?.members.find((m) => m.userId === friendId);
      if (giver) giver.coins = res.fromCoins;
      if (taker) taker.coins = res.toCoins;
      for (const r of new Set([fromRoom, toRoom])) if (r) broadcast(r);
      if (fromRoom && fromRoom === toRoom && giver && taker) {
        const gift: GiftEvent = { from: giver.id, to: taker.id, amount };
        io.to(fromRoom.code).emit('gift', gift);
      }
      const received: GiftReceived = { fromName: user.displayName, amount };
      for (const id of presence.socketsOf(friendId)) io.to(id).emit('gift:received', received);
      return { coins: res.fromCoins, giftLeft: res.giftLeft };
    });

    socket.on('disconnect', () => {
      if (user) presence.remove(user.id, socket.id);
      const left = (connections.get(ip) ?? 1) - 1;
      if (left > 0) connections.set(ip, left);
      else connections.delete(ip);
      if (pendingIn?.dropWatchRequests(socket.id)) broadcast(pendingIn);
      const room = detach();
      if (room) broadcast(room);
    });
  });

  const timer = setInterval(() => {
    rooms.sweep().forEach(broadcast);
    bots.prune();
    c7bots.prune();
  }, SWEEP_EVERY_MS);
  timer.unref();
  return () => {
    clearInterval(timer);
    bots.stop();
    c7bots.stop();
  };
}
