import type { Server, Socket } from 'socket.io';
import { BotDriver } from './bots/driver.js';
import { Crazy7Auto } from './crazy7/auto.js';
import { TurnClock } from './turnClock.js';
import { Crazy7Bots } from './crazy7/driver.js';
import { RangAuto } from './rang/auto.js';
import { RangBots } from './rang/driver.js';
import { RangClock } from './rang/clock.js';
import { PluggedDriver } from './games/driver.js';
import { moduleOf } from './games/registry.js';
import { applySettlement, chessFinishOf, chessOf, loadChessBadges } from './games/chess/settle.js';
import { rankPlural } from './cards.js';
import { GameError } from './game.js';
import type { AccountInfo, GameEvent, GameRecord, Member, MemberAccount, PlayerLook, SocketHooks, SocketUser, WatchRequest } from './models.js';
import { RTC_ICE_SERVERS } from './config.js';
import { Presence } from './presence.js';
import { botStakeText, type Room, type RoomManager } from './rooms.js';
import {
  BOT_LEVEL_NAMES,
  QUICK_MESSAGES,
  botStakeCap,
  DEFAULT_CARD_BACK,
  DEFAULT_TABLE_THEME,
  type Announcement,
  type FriendOnlineEvent,
  type GiftEvent,
  type GiftReceived,
  type InviteEvent,
  type LiveVoiceJoin,
  type RtcSignal,
  type ServerInfo,
  stakeLevelOf,
  GAME_CATALOG,
  chatSetOf,
  ludoLookOk,
  isPlugged,
  type GameKind,
} from './types.js';
import {
  asPayload,
  parseBet,
  parseCardId,
  parseCardIds,
  parseCardIndex,
  parseChat,
  parseRoomText,
  parseCode,
  parseConfig,
  parseFlag,
  parseGames,
  parsePluggedMove,
  parseGift,
  parseMemberId,
  parseName,
  parsePlayId,
  parseRank,
  parseSuit,
  parseRangCardId,
  parseRangCardIds,
  parseRangColor,
  parseTargetId,
  parseShield,
  parseRtcSignal,
  parseSaza,
  parseSlot,
  parseThrow,
  parseToken,
  parseUserId,
  type Payload,
} from './validate.js';

const RATE_WINDOW_MS = 10_000;
/** the most a guest connection may send at once: every guest event is far smaller */
const GUEST_MAX_PACKET = 16 * 1024;
const RATE_MAX_EVENTS = 40;
const SWEEP_EVERY_MS = 30_000;
/** open connections allowed per network (IP) by default; friends on one Wi-Fi share an address */
export const MAX_CONNECTIONS_PER_IP = 50;
/** the same friend can be invited again after this long */
const INVITE_GAP_MS = 30_000;

/** when friends hear "came online" */
export interface OnlineAlertTimes {
  /** only after being away at least this long, so a quick reconnect says nothing */
  awayMs: number;
  /** a restart brings everyone back at once: no alerts this soon after the server starts */
  quietMs: number;
}

const ONLINE_ALERTS: OnlineAlertTimes = { awayMs: 15_000, quietMs: 2 * 60_000 };
/** forget when someone went offline after this long (they count as long gone anyway) */
const OFFLINE_MEMORY_MS = 24 * 60 * 60_000;

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

/** said when the bots at the table brought the stake down */
const stakeLoweredText = (room: Room) => {
  const level = BOT_LEVEL_NAMES[stakeLevelOf(room.config)];
  return room.config.stake > 0 ? `Stake lowered to ${formatCoins(room.config.stake)} for ${level} bots` : `${level} bots play only free games, so this game is now free`;
};

/** Wires socket events to rooms; returns stop (the sweep timer) and live account updates */
export function registerHandlers(
  io: Server,
  rooms: RoomManager,
  hooks: SocketHooks = {},
  presence: Presence = new Presence(),
  maxConnectionsPerIp = MAX_CONNECTIONS_PER_IP,
  /** bots' thinking pace: 1 = human-like; tests use a small number */
  botSpeed = 1,
  alertTimes: Partial<OnlineAlertTimes> = {},
): { stop: () => void; lookChanged: (userId: string, look: PlayerLook) => void } {
  const alerts = { ...ONLINE_ALERTS, ...alertTimes };
  const startedAt = Date.now();
  /** when each account's last connection closed while this server ran */
  const wentOffline = new Map<string, number>();
  // every player gets their own view so hands stay private; bots then plan their next move
  /** real-time movement games: when views last went out, and a planned push that carries the moves since */
  const lastPush = new WeakMap<Room, number>();
  const livePush = new Map<Room, ReturnType<typeof setTimeout>>();
  const broadcast = (room: Room) => {
    // the turn clock first, so every view carries this turn's time left
    clock.wake(room);
    lastPush.set(room, Date.now());
    const pending = livePush.get(room);
    if (pending) clearTimeout(pending);
    livePush.delete(room);
    for (const m of room.members) if (m.socketId) io.to(m.socketId).emit('state', room.view(m.id));
    bots.wake(room);
    c7bots.wake(room);
    c7auto.wake(room);
    rangbots.wake(room);
    rangauto.wake(room);
    rangclock.wake(room);
    plugged.wake(room);
  };

  const publish = (room: Room, notes: Announcement[]) => {
    broadcast(room);
    for (const note of notes) io.to(room.code).emit('announce', note);
  };

  /** saves in the background, then shows everyone the coin changes */
  const saveGame = (room: Room, record: GameRecord | null) => {
    settleChess(room);
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
          // seats and lobby rows show the new rank straight away
          if (m && r.rank) m.rank = { division: r.rank.division, points: r.rank.after };
          if (m && typeof r.winStreak === 'number') m.streak = r.winStreak;
        }
        if (room.table === game) room.coinResults = results;
        broadcast(room);
      })
      .catch((err: Error) => console.error('[games] could not save game:', err.message));
  };

  /** a finished chess game: stored with its ratings moved (rated games), then the table shows the change */
  const settleChess = (room: Room) => {
    const g = chessOf(room);
    if (!g || !g.over || g.settling || !hooks.onChessEnd) return;
    g.settling = true;
    hooks
      .onChessEnd(chessFinishOf(room, g))
      .then((s) => {
        applySettlement(g, s);
        if (rooms.isOpen(room)) broadcast(room);
      })
      .catch((err: Error) => console.error('[chess] could not save game:', err.message));
  };

  /** live moves (positions) go out with the next view, at most one push every `ms` */
  const pushSoon = (room: Room, ms: number) => {
    plugged.wake(room);
    if (livePush.has(room)) return;
    const wait = Math.max(0, (lastPush.get(room) ?? 0) + ms - Date.now());
    const timer = setTimeout(() => {
      livePush.delete(room);
      if (rooms.isOpen(room)) broadcast(room);
    }, wait);
    livePush.set(room, timer);
  };

  /** the live part of the registry game on, if it has one */
  const liveOf = (room: Room) => {
    const g = room.plugged;
    return g && isPlugged(g.config.game) ? (moduleOf(g.config.game).live ?? null) : null;
  };

  const afterMove = (room: Room, events: GameEvent[], notes: Announcement[] = []) => {
    const live = liveOf(room);
    // only moves: no replay step, no announcer, a coalesced view push
    if (live && notes.length === 0 && events.length > 0 && events.every((e) => live.is(e))) return pushSoon(room, live.ms);
    // once no person holds cards against the bots, the result is settled
    const all = [...events, ...room.endIfOnlyBots()];
    const over = all.some((e) => e.kind === 'gameOver');
    bots.observe(room, all);
    c7bots.observe(room, all);
    rangbots.observe(room, all);
    plugged.observe(room, all);
    const said = [...notes, ...room.announce(all), ...(over ? room.settleSaza() : [])];
    // the replay keeps each move with what the table heard
    if (all.length > 0 || said.length > 0) room.recordStep(said.map((a) => a.text), all);
    publish(room, said);
    if (over) saveGame(room, room.snapshot(room.table?.aborted ? 'ended_early' : 'finished'));
  };

  /** after someone leaves: a room with no person left never carries on with bots alone */
  const afterExit = (room: Room, events: GameEvent[], notes: Announcement[]) => {
    if (room.hasPeople) return afterMove(room, events, notes);
    const all = [...events, ...room.endGameNow()];
    room.recordStep([...notes, ...room.announce(all)].map((a) => a.text), all);
    if (all.some((e) => e.kind === 'gameOver')) saveGame(room, room.snapshot('finished'));
    room.clearBots();
    bots.forget(room);
    c7bots.forget(room);
    c7auto.forget(room);
    rangbots.forget(room);
    rangauto.forget(room);
    rangclock.forget(room);
    plugged.forget(room);
    clock.forget(room);
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

  // turn timer: a safe move for a person whose time ran out
  const clock = new TurnClock(
    (room, events, notes) => afterMove(room, events, notes),
    (room) => rooms.isOpen(room),
    botSpeed,
    // the same brain the bots use plays the turn
    (room, id) => (room.plugged ? plugged.playFor(room, id) : room.rang ? rangbots.playFor(room, id) : room.c7 ? c7bots.playFor(room, id) : bots.playFor(room, id)),
  );

  // registry games (Ludo and every game after it): automatic steps, bots, game time and timed-out turns
  const plugged = new PluggedDriver(
    {
      onMove: (room, events) => afterMove(room, events),
      onChat: (room, chat) => io.to(room.code).emit('chat', chat),
    },
    (room) => rooms.isOpen(room),
    botSpeed,
  );

  // Crazy 7's automatic picks and passes, one at a time at a pace people can follow
  const c7auto = new Crazy7Auto((room, events) => afterMove(room, events), (room) => rooms.isOpen(room), botSpeed);

  // Rang's game time: ends the game when it runs out
  const rangclock = new RangClock((room, events) => afterMove(room, events), (room) => rooms.isOpen(room));

  // Rang's automatic picks and passes, and its bots, the same way
  const rangauto = new RangAuto((room, events) => afterMove(room, events), (room) => rooms.isOpen(room), botSpeed);
  const rangbots = new RangBots(
    {
      onMove: (room, events) => afterMove(room, events),
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
      if (stake > botStakeCap(room.config) && seated.some((m) => m.bot)) throw new GameError(botStakeText(room.config));
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
          if (a) {
            m.stats = a.stats;
            m.habits = a.habits;
          }
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
    } else if (room.players().some((m) => m.bot) && (room.config.game ?? 'bluff') === 'bluff') {
      // Bluff bots size people up from their latest record; staked games read it above with the balances
      if (room.starting) throw new GameError('Already starting');
      room.starting = true;
      try {
        await refreshReads(room);
      } finally {
        room.starting = false;
      }
    }
    room.start(member.id);
    const table = room.table!;
    // chess seats show each person's rating in this game's pool once it's read
    const chess = chessOf(room);
    if (chess && hooks.chessBadges) {
      void loadChessBadges(chess, hooks.chessBadges)
        .then((read) => {
          if (read && rooms.isOpen(room) && room.plugged === chess) broadcast(room);
        })
        .catch((err: Error) => console.error('[chess] could not read ratings:', err.message));
    }
    // games where everyone moves at once (Raja Mantri) have nobody going first
    const first = table.turnId ? `. ${room.member(table.turnId).name} goes first` : '';
    const pot = stake > 0 ? `. Pot: ${formatCoins(stake * table.order.length)} coins` : '';
    // Crazy 7's first turn may already have picked a card for that player
    const opening = room.c7?.opening ?? room.rang?.opening ?? (room.plugged as { opening?: GameEvent[] } | null)?.opening ?? [];
    c7bots.observe(room, opening);
    rangbots.observe(room, opening);
    // the Kismat card is read out with the deal, so nobody misses it
    const kismat = room.game?.kismat;
    const wild = kismat ? [room.note('round', `🍀 Kismat card: ${rankPlural(kismat)} are wild this game`)] : [];
    const said = [room.note('round', `${label}${first}${pot}`), ...wild, ...room.announce(opening)];
    room.replay?.addStartLines(said.map((a) => a.text));
    publish(room, said);
  };

  /** before a free deal with bots: each person's latest lifetime numbers and habits, so the bots size them up from their last games too */
  const refreshReads = async (room: Room) => {
    const people = room.players().filter((m) => !m.bot && m.userId);
    if (people.length === 0 || !hooks.getAccounts) return;
    try {
      const accounts = await hooks.getAccounts(people.map((m) => m.userId!));
      for (const m of people) {
        const a = accounts.get(m.userId!);
        if (!a) continue;
        m.stats = a.stats;
        m.habits = a.habits;
        m.level = a.level;
      }
    } catch {
      // the bots go with what they read when each person joined
    }
  };

  /** let a waiting person in (watching mid-game, a seat back in the lobby); their app rejoins with the seat token */
  const admit = (room: Room, req: WatchRequest) => {
    // they closed the app while waiting
    if (!io.sockets.sockets.get(req.socketId)) {
      broadcast(room);
      return;
    }
    try {
      // their choice when asking through a friend; mid-game everyone new watches anyway
      const added = room.addMember(req.name, req.account, req.watch ?? false);
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
    return {
      userId: u.id,
      username: u.username,
      coins: fresh?.coins ?? null,
      level: fresh?.level ?? null,
      stats: fresh?.stats ?? null,
      avatar: fresh?.avatar ?? null,
      back: fresh?.back ?? DEFAULT_CARD_BACK,
      table: fresh?.table ?? DEFAULT_TABLE_THEME,
      habits: fresh?.habits ?? null,
      shop: fresh?.shop,
      rank: fresh?.rank,
      streak: fresh?.streak,
    };
  };

  /** an account's app opened after a while away: its friends who are online hear about it */
  const cameOnline = async (u: SocketUser, seenBefore: Date | null) => {
    const now = Date.now();
    const left = wentOffline.get(u.id);
    wentOffline.delete(u.id);
    // right after a restart everyone comes back at once; that isn't news
    if (left === undefined && now - startedAt < alerts.quietMs) return;
    const away = left !== undefined ? now - left : seenBefore ? now - seenBefore.getTime() : Infinity;
    if (away < alerts.awayMs || !hooks.friendIdsOf) return;
    // friends already in the same room know: they share the table
    const sameRoom = (id: string) => {
      const here = rooms.roomOfUser(u.id);
      return here !== null && rooms.roomOfUser(id) === here;
    };
    const online = (await hooks.friendIdsOf(u.id)).filter((id) => presence.isOnline(id) && !sameRoom(id));
    // they may have closed the app again meanwhile
    if (online.length === 0 || !presence.isOnline(u.id)) return;
    let avatar: string | null = null;
    try {
      avatar = (await hooks.getAccounts?.([u.id]))?.get(u.id)?.avatar ?? null;
    } catch {
      // the first letter shows instead
    }
    const event: FriendOnlineEvent = { id: u.id, name: u.displayName, username: u.username, avatar };
    // checked again: someone may have joined the same table during the lookups
    for (const id of online) if (!sameRoom(id)) for (const sid of presence.socketsOf(id)) io.to(sid).emit('friend:online', event);
  };

  /** accounts on or off, and whether guests may play right now */
  const serverInfo = (): ServerInfo => ({
    accounts: !!hooks.resolveUser,
    guestsAllowed: hooks.guestsAllowed ? hooks.guestsAllowed() : true,
    pushInvites: hooks.pushInvitesOn ? hooks.pushInvitesOn() : false,
  });

  /** when each player last invited each friend, so nobody's phone gets spammed */
  const invitedAt = new Map<string, number>();

  // a login token in the handshake makes this socket that account; no or bad token means guest
  const connections = new Map<string, number>();
  io.use((socket, next) => {
    const ip = clientIp(socket);
    if ((connections.get(ip) ?? 0) >= maxConnectionsPerIp) return next(new Error('Too many connections from your network'));
    socket.data.ip = ip;
    // apps with the lobby's Ready button say so; older ones never hold up a start
    socket.data.hasReady = (socket.handshake.auth as { ready?: unknown } | undefined)?.ready === true;
    // apps that show the Kismat card and Seedhi claims say so too
    socket.data.hasTwists = (socket.handshake.auth as { twists?: unknown } | undefined)?.twists === true;
    // and apps with Rang and Crazy 7's power cards
    socket.data.hasRang = (socket.handshake.auth as { rang?: unknown } | undefined)?.rang === true;
    // and the registry games (Ludo and after) the app has
    socket.data.games = parseGames((socket.handshake.auth as { games?: unknown } | undefined)?.games);
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
    /** game:move in a real-time registry game (Fruit, Spikes) counts here, against that game's own allowance */
    const moveHits: number[] = [];
    const user = socket.data.user as SocketUser | undefined;
    const ip = socket.data.ip as string;
    connections.set(ip, (connections.get(ip) ?? 0) + 1);
    // every guest event is small: a guest connection sending anything big is cut off before it's read
    if (!user) {
      socket.conn.on('packet', (packet: { data?: unknown }) => {
        const d = packet.data;
        const size = typeof d === 'string' ? d.length : d instanceof ArrayBuffer || ArrayBuffer.isView(d) ? d.byteLength : 0;
        if (size > GUEST_MAX_PACKET) socket.disconnect(true);
      });
    }
    if (user) {
      const wasOnline = presence.isOnline(user.id);
      presence.add(user.id, socket.id);
      // in the background: a DB hiccup never blocks a connection
      if (!wasOnline) {
        void (hooks.markSeen?.(user.id) ?? Promise.resolve(null))
          .then((before) => cameOnline(user, before))
          .catch((err: Error) => console.error('[friends] online alert failed:', err.message));
      }
    }
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
      // a fresh connection starts with live voice off, so others never wait on a phone that isn't in it
      room.dropLive(member.id);
      member.hasReady = socket.data.hasReady === true;
      member.hasTwists = socket.data.hasTwists === true;
      member.hasRang = socket.data.hasRang === true;
      member.games = Array.isArray(socket.data.games) ? [...(socket.data.games as string[])] : [];
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

    /** the game on at this seat's table lets moves come faster than other events (null: the usual limit) */
    const fastMoveRate = (): number | null => {
      const g = seat?.room.plugged;
      return g && isPlugged(g.config.game) ? (moduleOf(g.config.game).moveRate ?? null) : null;
    };

    const on = (event: string, handler: (p: Payload) => object | void | Promise<object | void>) => {
      socket.on(event, async (raw: unknown, ack?: unknown) => {
        const reply: Reply = typeof ack === 'function' ? (ack as Reply) : () => {};
        try {
          const now = Date.now();
          const fast = event === 'game:move' ? fastMoveRate() : null;
          const log = fast ? moveHits : hits;
          while (log.length > 0 && now - log[0] > RATE_WINDOW_MS) log.shift();
          if (log.push(now) > (fast ?? RATE_MAX_EVENTS)) throw new GameError('Too fast, slow down');
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
        if (room.phase === 'playing' && room.table?.order.includes(member.id) && room.inPlay(member.id)) {
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
      // the game tapped on the home grid; older apps don't send it
      const game = (p as { game?: unknown } | undefined)?.game;
      if (typeof game === 'string' && GAME_CATALOG.some((g) => g.kind === game)) next.room.config = { ...next.room.config, game: game as GameKind };
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
      // never straight in: the friend gets a card and says yes or no (lobby or game)
      const friend = room.members.find((m) => m.userId === friendId);
      if (!friend) throw new GameError('Your friend is not in a room right now');
      releaseOthers(room);
      room.requestWatch(user.displayName, await accountOf(user), socket.id, requestKey(user.displayName), { askedOf: friend.id, watch });
      pendingIn = room;
      broadcast(room);
      return { code: room.code, pending: true, askedOf: friend.name };
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
      const wasRanked = room.isRanked;
      const { stakeLowered, readyAgain } = room.setConfig(member.id, parseConfig(p));
      const notes = stakeLowered ? [room.note('room', stakeLoweredText(room))] : [];
      // everyone hears when the table turns ranked or casual
      if (room.isRanked !== wasRanked) notes.push(room.note('room', room.isRanked ? `🏅 ${member.name} made this a ranked game` : `🎮 ${member.name} made this a casual game`));
      if (readyAgain) notes.push(room.note('room', 'Settings changed: tap Ready again'));
      publish(room, notes);
    });

    // lobby: ready to start, or not yet (wait a minute); the host's Start opens once every other person is ready
    // host buzzes the players who aren't ready: their phones vibrate (10 s cooldown)
    on('room:nudge', () => {
      const { room, member } = current();
      const waiting = room.nudge(member.id);
      for (const m of waiting) if (m.socketId) io.to(m.socketId).emit('room:nudged', { from: member.name });
      return { count: waiting.length };
    });

    on('room:ready', (p) => {
      const { room, member } = current();
      room.setReady(member.id, parseFlag(p.ready, 'Ready'));
      const others = room.players().filter((m) => !m.bot && m.id !== room.hostId);
      const everyone = member.ready && others.length > 0 && room.waitingFor().length === 0;
      publish(room, everyone ? [room.note('room', 'Everyone is ready ✅')] : []);
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
      if (wasPlaying) room.recordStep([`${member.name} stopped the game`], []);
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
      if (stakeLowered) notes.push(room.note('room', stakeLoweredText(room)));
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

    // game over: everything one player put down, for the lie reveal (refused while the game runs or when lies are secret)
    on('room:plays', (p) => {
      const { room } = current();
      return room.playsOf(parseMemberId(p.playerId));
    });

    on('room:saza', (p) => {
      const { room, member } = current();
      publish(room, room.pickSaza(member.id, parseSaza(p.badge)));
    });

    // Ludo looks picked on the phone: their gotis and dice for everyone, and the table's board when they're host; locked looks fall back to the free one
    on('ludo:look', (p) => {
      const { room, member } = current();
      const level = member.level ?? 1;
      const next = { board: ludoLookOk('board', p.board, level), goti: ludoLookOk('goti', p.goti, level), dice: ludoLookOk('dice', p.dice, level) };
      const was = member.ludoLook;
      if (was.board === next.board && was.goti === next.goti && was.dice === next.dice) return;
      member.ludoLook = next;
      broadcast(room);
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
      const now = Date.now();
      for (const [k, at] of invitedAt) if (now - at >= INVITE_GAP_MS) invitedAt.delete(k);
      const pair = `${user.id}:${friendId}`;
      if (invitedAt.has(pair)) throw new GameError('You just invited them. Try again in a few seconds');
      const invite: InviteEvent = { fromId: user.id, fromName: user.displayName, code: room.code };
      const sockets = presence.socketsOf(friendId);
      if (sockets.length > 0) {
        for (const id of sockets) io.to(id).emit('invite', invite);
        invitedAt.set(pair, now);
        return;
      }
      // offline: a notification on their phone, if they turned them on (and an admin hasn't switched them off)
      const on = hooks.pushInvitesOn?.() ?? false;
      const sent = on && hooks.pushInvite ? await hooks.pushInvite(friendId, invite) : 0;
      if (sent === 0) {
        throw new GameError(on ? "Your friend is offline and hasn't turned on notifications. Send the WhatsApp link instead" : 'Your friend is offline. Send the WhatsApp link instead');
      }
      invitedAt.set(pair, now);
      return { pushed: true };
    });

    on('game:play', (p) => {
      const { room, member } = current();
      room.markActive(member.id);
      afterMove(room, room.requireGame().play(member.id, parseCardIds(p.cardIds), parseRank(p.rank), parseShield(p.shield)));
    });

    on('game:pass', () => {
      const { room, member } = current();
      room.markActive(member.id);
      afterMove(room, room.requireGame().pass(member.id));
    });

    on('game:bluff', (p) => {
      const { room, member } = current();
      room.markActive(member.id);
      const game = room.requireGame();
      const bet = room.checkBet(member, parseBet(p.bet));
      afterMove(room, game.callBluff(member.id, parsePlayId(p.playId), parseCardIndex(p.cardIndex), bet));
    });

    // Rang: one card (a colour for a wild, a player for a 7 with 7-0 on), pick, end the turn, say last card, or challenge a +4
    on('rang:play', (p) => {
      const { room, member } = current();
      room.markActive(member.id);
      afterMove(room, room.requireRang().play(member.id, parseRangCardId(p.cardId), { color: parseRangColor(p.color), targetId: parseTargetId(p.targetId), extra: parseRangCardIds(p.extraIds) }));
    });

    on('rang:pick', () => {
      const { room, member } = current();
      room.markActive(member.id);
      afterMove(room, room.requireRang().pick(member.id));
    });

    on('rang:pass', () => {
      const { room, member } = current();
      room.markActive(member.id);
      afterMove(room, room.requireRang().pass(member.id));
    });

    on('rang:call', () => {
      const { room, member } = current();
      afterMove(room, room.requireRang().call(member.id));
    });

    on('rang:challenge', () => {
      const { room, member } = current();
      room.markActive(member.id);
      afterMove(room, room.requireRang().challenge(member.id));
    });

    // registry games (Ludo and after): one event for every move, { kind, move }; the game's module checks and plays it
    on('game:move', (p) => {
      const { room, member } = current();
      const g = room.requirePlugged();
      const kind = g.config.game as Parameters<typeof moduleOf>[0];
      const move = parsePluggedMove(p, kind);
      room.markActive(member.id);
      afterMove(room, moduleOf(kind).move(g, member.id, move));
    });

    // Crazy 7: one card on the pile, pick from the deck, end the turn, or say last card
    on('c7:play', (p) => {
      const { room, member } = current();
      room.markActive(member.id);
      afterMove(room, room.requireCrazy7().play(member.id, parseCardId(p.cardId), parseSuit(p.suit)));
    });

    on('c7:pick', () => {
      const { room, member } = current();
      room.markActive(member.id);
      afterMove(room, room.requireCrazy7().pick(member.id));
    });

    on('c7:pass', () => {
      const { room, member } = current();
      room.markActive(member.id);
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
      const { kind, index, on } = parseChat(p, room.config.game);
      io.to(room.code).emit('chat', room.chat(member.id, kind, index, on));
      // Quick Chat lines go into the room's chat list too
      if (kind === 'message' && !on) io.to(room.code).emit('room:msg', room.addMessage(member.id, chatSetOf(room.config.game).messages[index], true));
    });

    // room chat: type a line; everyone in the room gets it in their list
    on('room:say', (p) => {
      const { room, member } = current();
      io.to(room.code).emit('room:msg', room.addMessage(member.id, parseRoomText(p.text), false));
    });

    // the room's whole chat list, for someone who just came in or reconnected
    on('room:messages', () => {
      const { room } = current();
      return { messages: room.messages };
    });

    // an emoji flies from one person to another; everyone in the room sees it
    on('chat:throw', (p) => {
      const { room, member } = current();
      const { to, index } = parseThrow(p);
      io.to(room.code).emit('throw', room.throwAt(member.id, to, index));
    });

    // live voice on or off: everyone's state says who's in it, so phones connect to and drop each other by themselves
    on('voice:live', (p) => {
      const { room, member } = current();
      const live = parseFlag(p.on, 'Live voice');
      // whether their mic is on, so everyone's seat shows it (older apps don't say: off)
      const mic = p.mic === undefined ? false : parseFlag(p.mic, 'Mic');
      room.setLive(member.id, live, mic);
      broadcast(room);
      const join: LiveVoiceJoin = { iceServers: live ? RTC_ICE_SERVERS : [] };
      return join;
    });

    // a live voice connection message goes straight to the one player it's for; only between two players in live voice
    on('rtc:signal', (p) => {
      const { room, member } = current();
      const { to, sdp } = parseRtcSignal(p);
      if (!room.isLive(member.id)) throw new GameError('Turn live voice on first');
      const target = room.members.find((m) => m.id === to);
      if (!target?.socketId || !room.isLive(to)) throw new GameError('They left live voice');
      const signal: RtcSignal = { from: member.id, sdp };
      io.to(target.socketId).emit('rtc:signal', signal);
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
      if (user) {
        presence.remove(user.id, socket.id);
        if (!presence.isOnline(user.id)) {
          wentOffline.set(user.id, Date.now());
          hooks.markSeen?.(user.id).catch(() => {});
        }
      }
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
    const now = Date.now();
    for (const [id, at] of wentOffline) if (now - at > OFFLINE_MEMORY_MS) wentOffline.delete(id);
    bots.prune();
    c7bots.prune();
    c7auto.prune();
    rangbots.prune();
    rangauto.prune();
    rangclock.prune();
    plugged.prune();
    clock.prune();
  }, SWEEP_EVERY_MS);
  timer.unref();
  return {
    stop: () => {
      clearInterval(timer);
      bots.stop();
      c7bots.stop();
      c7auto.stop();
      rangbots.stop();
      rangauto.stop();
      rangclock.stop();
      plugged.stop();
      for (const t of livePush.values()) clearTimeout(t);
      livePush.clear();
      clock.stop();
    },
    /** a player changed their avatar, card back or table: their seat in any room shows it at once */
    lookChanged: (userId: string, look: PlayerLook) => {
      const room = rooms.roomOfUser(userId);
      const member = room?.members.find((m) => m.userId === userId);
      if (!room || !member) return;
      member.avatar = look.avatar;
      member.back = look.back;
      member.table = look.table;
      if (look.shop) member.shop = look.shop;
      broadcast(room);
    },
  };
}
