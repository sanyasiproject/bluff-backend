import { randomBytes, randomInt } from 'node:crypto';
import { computeAwards } from './awards.js';
import { describeClaim, ordinal } from './cards.js';
import { Game, GameError } from './game.js';
import type { GameEvent, GameRecord, Member, MemberAccount, WatchRequest } from './models.js';
import type { AnnounceKind, Announcement, ChatEvent, ChatKind, CoinResult, GameConfig, Phase, RoomView, ThrowEvent } from './types.js';

export const MAX_PLAYERS = 5;
/** seated players plus watchers */
export const MAX_MEMBERS = 12;
const MAX_ROOMS = 200;
const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
/** a disconnected player keeps their lobby seat this long */
const LOBBY_GRACE_MS = 2 * 60_000;
/** a room with nobody connected is deleted after this long */
const ROOM_IDLE_MS = 30 * 60_000;
/** minimum gap between one person's chat messages */
const CHAT_GAP_MS = 700;
/** people waiting for the host to let them watch */
const MAX_WATCH_REQUESTS = 10;
/** room creation per network (IP), so one script can't fill the server */
const CREATE_WINDOW_MS = 10 * 60_000;

export interface RoomLimits {
  /** new rooms one network may create per 10 minutes */
  createsPerIp: number;
  /** rooms one network may have open at once */
  liveRoomsPerIp: number;
}

export const DEFAULT_ROOM_LIMITS: RoomLimits = { createsPerIp: 10, liveRoomsPerIp: 5 };

export class Room {
  members: Member[] = [];
  hostId = '';
  config: GameConfig = { decks: 1, bluffRule: 'one', stake: 0, peeks: 0, bets: false, teams: false };
  game: Game | null = null;
  startedAt: Date | null = null;
  /** coin changes of the last finished game, filled once it's saved */
  coinResults: CoinResult[] | null = null;
  /** true while a staked start is checking balances */
  starting = false;
  /** the last game's save, still settling coins */
  saving: Promise<void> | null = null;
  /** players the host removed mid-game, kept so the saved game still has their name */
  private departed = new Map<string, Member>();
  /** 2v2 lobby: who asked whom to swap places, by the asked player's id */
  private swapAsks = new Map<string, string>();
  /** after the game has started, newcomers ask the host before they can watch */
  private watchRequests: WatchRequest[] = [];
  /** network that created the room, for the per-network room limit */
  creatorIp = '';
  private announceSeq = 0;
  private lastChat = new Map<string, number>();

  constructor(readonly code: string) {}

  get phase(): Phase {
    if (!this.game) return 'lobby';
    return this.game.over ? 'over' : 'playing';
  }

  /** members with a seat */
  players(): Member[] {
    return this.members.filter((m) => !m.watching);
  }

  member(id: string): Member {
    const m = this.members.find((x) => x.id === id);
    if (!m) throw new GameError('You are not in this room');
    return m;
  }

  addMember(name: string, account: MemberAccount | null = null): Member {
    if (this.members.length >= MAX_MEMBERS) throw new GameError(`Room is full (max ${MAX_MEMBERS})`);
    if (account && this.members.some((m) => m.userId === account.userId)) throw new GameError('Your account is already in this room');
    if (this.members.some((m) => m.name.toLowerCase() === name.toLowerCase())) {
      throw new GameError('That name is taken in this room');
    }
    const member: Member = {
      id: randomBytes(6).toString('hex'),
      token: randomBytes(16).toString('hex'),
      name,
      socketId: null,
      lastSeen: Date.now(),
      // late or extra people watch, and get a seat in the next game
      watching: this.phase === 'playing' || this.players().length >= MAX_PLAYERS,
      watchByChoice: false,
      slot: null,
      userId: account?.userId ?? null,
      coins: account?.coins ?? null,
      username: account?.username ?? null,
      level: account?.level ?? null,
    };
    this.members.push(member);
    if (!this.hostId) this.hostId = member.id;
    return member;
  }

  /** leaves the room; a player seated in a running game forfeits it. Returns any game events */
  removeMember(id: string): GameEvent[] {
    const leaving = this.member(id);
    let events: GameEvent[] = [];
    if (this.phase === 'playing' && this.game?.order.includes(id)) {
      events = this.game.leave(id);
      // kept so the saved game still has their name
      this.departed.set(id, leaving);
    }
    this.members = this.members.filter((m) => m.id !== id);
    this.lastChat.delete(id);
    this.forgetSwaps(id);
    if (this.phase === 'lobby') this.fillSeats();
    if (this.hostId === id) this.hostId = (this.players()[0] ?? this.members[0])?.id ?? '';
    return events;
  }

  /** a game is running: newcomers ask the host instead of joining straight away */
  get needsApproval(): boolean {
    return this.phase === 'playing';
  }

  requestWatch(name: string, account: MemberAccount | null, socketId: string): WatchRequest {
    if (this.members.length >= MAX_MEMBERS) throw new GameError(`Room is full (max ${MAX_MEMBERS})`);
    if (this.watchRequests.length >= MAX_WATCH_REQUESTS) throw new GameError('The host has a lot of requests, try again soon');
    if (account && this.members.some((m) => m.userId === account.userId)) throw new GameError('Your account is already in this room');
    const taken = [...this.members.map((m) => m.name), ...this.watchRequests.map((r) => r.name)];
    if (taken.some((n) => n.toLowerCase() === name.toLowerCase())) throw new GameError('That name is taken in this room');
    this.dropWatchRequests(socketId);
    const req: WatchRequest = { id: randomBytes(6).toString('hex'), name, account, socketId };
    this.watchRequests.push(req);
    return req;
  }

  /** the host answers one request; it's removed either way */
  takeWatchRequest(by: string, id: string): WatchRequest {
    this.assertHost(by);
    const req = this.watchRequests.find((r) => r.id === id);
    if (!req) throw new GameError('That request was cancelled');
    this.watchRequests = this.watchRequests.filter((r) => r !== req);
    return req;
  }

  /** returns true if that connection had a request here */
  dropWatchRequests(socketId: string): boolean {
    const before = this.watchRequests.length;
    this.watchRequests = this.watchRequests.filter((r) => r.socketId !== socketId);
    return this.watchRequests.length !== before;
  }

  /** back in the lobby, everyone still waiting just comes in */
  takeAllWatchRequests(): WatchRequest[] {
    const all = this.watchRequests;
    this.watchRequests = [];
    return all;
  }

  /** host removes someone; mid-game their cards leave the game. Returns who left and any game events */
  kick(by: string, targetId: string): { kicked: Member; events: GameEvent[] } {
    this.assertHost(by);
    if (targetId === by) throw new GameError("You can't remove yourself");
    const target = this.member(targetId);
    let events: GameEvent[] = [];
    if (this.phase === 'playing' && this.game?.order.includes(targetId)) {
      events = this.game.removePlayer(targetId);
      this.departed.set(targetId, target);
    }
    this.members = this.members.filter((m) => m.id !== targetId);
    this.lastChat.delete(targetId);
    this.forgetSwaps(targetId);
    if (this.phase === 'lobby') this.fillSeats();
    return { kicked: target, events };
  }

  /** host hands the host role to someone else who is here, in the lobby */
  transferHost(by: string, targetId: string): Member {
    this.assertHost(by);
    if (this.phase !== 'lobby') throw new GameError('The host can only be changed in the lobby');
    if (targetId === by) throw new GameError("You're already the host");
    const target = this.member(targetId);
    if (!target.socketId) throw new GameError(`${target.name} is offline`);
    this.hostId = target.id;
    return target;
  }

  /** in the lobby anyone can sit out and watch, or take a free seat again; the host can move anyone */
  setWatching(by: string, targetId: string, watching: boolean): Member {
    if (targetId !== by) this.assertHost(by);
    if (this.phase !== 'lobby') throw new GameError('You can switch between playing and watching in the lobby');
    const m = this.member(targetId);
    if (watching) {
      m.watching = true;
      m.watchByChoice = true;
      // someone waiting for a seat gets the one just freed
      this.fillSeats();
      return m;
    }
    if (m.watching && this.players().length >= MAX_PLAYERS) throw new GameError(`All ${MAX_PLAYERS} seats are taken`);
    m.watching = false;
    m.watchByChoice = false;
    return m;
  }

  setConfig(by: string, config: GameConfig): void {
    this.assertHost(by);
    if (this.phase !== 'lobby') throw new GameError('Settings can only change in the lobby');
    this.config = config;
    if (!config.teams) this.swapAsks.clear();
  }

  /** 2v2: move yourself into a free team slot, which also picks your team and partner */
  moveToSlot(by: string, slot: number): void {
    const m = this.teamLobbyMember(by);
    this.syncSlots();
    if (this.players().some((p) => p.slot === slot && p !== m)) throw new GameError('That slot is taken. Ask them to swap instead');
    m.slot = slot;
    this.forgetSwaps(by);
  }

  /** 2v2: ask another player to swap places with you; they answer in the app */
  askSwap(by: string, targetId: string): Member {
    if (targetId === by) throw new GameError("That's your own place");
    this.teamLobbyMember(by);
    const target = this.teamLobbyMember(targetId);
    this.swapAsks.set(targetId, by);
    return target;
  }

  /** the asked player says yes (places swap) or no; returns who asked */
  answerSwap(by: string, fromId: string, accept: boolean): Member {
    if (this.swapAsks.get(by) !== fromId) throw new GameError('That swap request has expired');
    this.swapAsks.delete(by);
    const from = this.teamLobbyMember(fromId);
    const me = this.teamLobbyMember(by);
    if (accept) {
      this.syncSlots();
      [from.slot, me.slot] = [me.slot, from.slot];
      this.forgetSwaps(fromId);
      this.forgetSwaps(by);
    }
    return from;
  }

  /** a seated player in a 2v2 lobby */
  private teamLobbyMember(id: string): Member {
    if (this.phase !== 'lobby') throw new GameError('Teams can only change in the lobby');
    if (!this.config.teams) throw new GameError('Turn on 2 vs 2 teams first');
    const m = this.member(id);
    if (m.watching) throw new GameError(`${m.name} is watching, not playing`);
    return m;
  }

  private forgetSwaps(id: string): void {
    this.swapAsks.delete(id);
    for (const [to, from] of this.swapAsks) if (from === id) this.swapAsks.delete(to);
  }

  /** keeps 2v2 slots valid: watchers have none, each slot has at most one player, and empty ones fill in join order */
  private syncSlots(): void {
    for (const m of this.members) if (m.watching) m.slot = null;
    if (!this.config.teams) return;
    const taken = new Set<number>();
    for (const m of this.players()) {
      if (m.slot !== null && !taken.has(m.slot)) taken.add(m.slot);
      else m.slot = null;
    }
    for (const m of this.players()) {
      if (m.slot !== null) continue;
      const free = [0, 1, 2, 3].find((s) => !taken.has(s));
      if (free === undefined) break;
      m.slot = free;
      taken.add(free);
    }
  }

  /** member id in each 2v2 slot, null when empty */
  private slotIds(): (string | null)[] {
    this.syncSlots();
    return [0, 1, 2, 3].map((s) => this.players().find((m) => m.slot === s)?.id ?? null);
  }

  /** host, lobby and player-count checks; staked checks need coin balances and run in socket.ts */
  assertCanStart(by: string): void {
    this.assertHost(by);
    if (this.phase !== 'lobby') throw new GameError('Game already started');
    if (this.players().length < 2) throw new GameError('Need at least 2 players');
    if (this.config.teams && this.players().length !== 4) throw new GameError('Teams need exactly 4 players');
  }

  /** host swaps partners: the 1st player gets a different partner (the 2nd or the 4th seat, at random) */
  shuffleTeams(by: string): void {
    this.assertHost(by);
    if (this.phase !== 'lobby') throw new GameError('Teams can only change in the lobby');
    const slots = this.slotIds();
    if (!this.config.teams || slots.includes(null) || this.players().length !== 4) throw new GameError('Teams need exactly 4 players');
    // partners hold slots 0 & 2; swapping slot 2 with slot 1 or 3 pairs slot 0 with someone new
    const a = this.member(slots[2]!);
    const b = this.member(slots[randomInt(2) === 0 ? 1 : 3]!);
    [a.slot, b.slot] = [b.slot, a.slot];
    this.swapAsks.clear();
  }

  /** a bet must be one of the steps, at most the stake, and covered by what the caller can still lose */
  checkBet(member: Member, bet: number): number {
    if (bet === 0) return 0;
    const g = this.requireGame();
    if (!g.config.bets) throw new GameError('Bets are off in this room');
    if (bet > g.config.stake) throw new GameError(`You can bet up to the stake (${g.config.stake.toLocaleString('en-IN')})`);
    if (bet > this.betRoom(member)) throw new GameError("You don't have enough coins for that bet");
    return bet;
  }

  /** coins a player can still risk: balance at the start, minus the stake, plus bets already won, minus bets lost */
  private betRoom(member: Member): number {
    const g = this.game;
    if (!g || member.coins === null) return 0;
    const net = g.bets.reduce((sum, b) => sum + (b.to === member.id ? b.amount : 0) - (b.from === member.id ? b.amount : 0), 0);
    return Math.max(0, member.coins - g.config.stake + net);
  }

  start(by: string): void {
    this.assertCanStart(by);
    this.game = new Game(
      // 2v2 plays in slot order, so the teams alternate turns
      this.config.teams ? (this.slotIds().filter((id) => id !== null) as string[]) : this.players().map((m) => m.id),
      this.config,
    );
    this.startedAt = new Date();
    this.swapAsks.clear();
    this.coinResults = null;
    this.departed.clear();
  }

  /** the current game as a record to save; take it before the game is cleared */
  snapshot(status: GameRecord['status']): GameRecord | null {
    const g = this.game;
    if (!g) return null;
    const member = (id: string) => this.members.find((m) => m.id === id) ?? this.departed.get(id);
    return {
      roomCode: this.code,
      config: g.config,
      status,
      startedAt: this.startedAt ?? new Date(),
      endedAt: new Date(),
      players: g.order.map((id) => ({
        memberId: id,
        userId: member(id)?.userId ?? null,
        name: member(id)?.name ?? 'Someone',
        place: g.places.indexOf(id) + 1 || null,
        loser: status === 'finished' && g.losers().includes(id),
        won: status === 'finished' && g.winners().includes(id),
        kicked: g.kicked.has(id),
        stats: { ...g.stats.get(id)! },
      })),
      awards: status === 'finished' ? computeAwards(g.stats) : [],
      bets: status === 'finished' ? [...g.bets] : [],
    };
  }

  /** after game over anyone can return; mid-game only the host (or anyone if the host is offline) */
  backToLobby(by: string): void {
    if (this.phase === 'playing' && by !== this.hostId && this.member(this.hostId).socketId) {
      throw new GameError('Only the host can end the game');
    }
    this.game = null;
    this.coinResults = null;
    this.departed.clear();
    this.fillSeats();
  }

  /** host ends the game once someone has won; 1st place wins and everyone else loses */
  endGame(by: string): GameEvent[] {
    this.assertHost(by);
    return this.requireGame().endEarly();
  }

  /** host clears the finished game so the same table can be dealt again */
  rematch(by: string): void {
    this.assertHost(by);
    if (this.phase !== 'over') throw new GameError('The game is not over yet');
    this.backToLobby(by);
  }

  requireGame(): Game {
    if (!this.game || this.game.over) throw new GameError('No game in progress');
    return this.game;
  }

  chat(by: string, kind: ChatKind, index: number): ChatEvent {
    this.member(by);
    const now = Date.now();
    if (now - (this.lastChat.get(by) ?? 0) < CHAT_GAP_MS) throw new GameError('Slow down');
    this.lastChat.set(by, now);
    return { from: by, kind, index };
  }

  /** an emoji thrown at someone else in the room; shares the chat speed limit */
  throwAt(by: string, to: string, index: number): ThrowEvent {
    this.member(by);
    if (by === to) throw new GameError('Pick someone else');
    if (!this.members.some((m) => m.id === to)) throw new GameError('That player has left');
    const now = Date.now();
    if (now - (this.lastChat.get(by) ?? 0) < CHAT_GAP_MS) throw new GameError('Slow down');
    this.lastChat.set(by, now);
    return { from: by, to, index };
  }

  view(meId: string): RoomView {
    const g = this.game;
    const lp = g?.lastPlay;
    // during a game the seats are that game's players; everyone else watches
    const seated = g ? g.order.flatMap((id) => this.members.filter((m) => m.id === id)) : this.players();
    const me = this.members.find((m) => m.id === meId);
    // 2v2 lobby: who sits in which team slot
    const lobbySlots = !g && this.config.teams ? this.slotIds() : null;
    const seatedIds = new Set(seated.map((m) => m.id));
    return {
      code: this.code,
      meId,
      hostId: this.hostId,
      phase: this.phase,
      config: g?.config ?? this.config,
      players: seated.map((m) => ({
        id: m.id,
        name: m.name,
        connected: m.socketId !== null,
        cardCount: g?.hands.get(m.id)?.length ?? 0,
        place: g ? g.places.indexOf(m.id) + 1 || null : null,
        registered: m.userId !== null,
        coins: m.coins,
        username: m.username,
        level: m.level,
      })),
      watchers: this.members
        .filter((m) => !seatedIds.has(m.id))
        .map((m) => ({
          id: m.id,
          name: m.name,
          connected: m.socketId !== null,
          username: m.username,
          level: m.level,
          byChoice: m.watchByChoice,
        })),
      turnId: g?.turnId ?? null,
      roundRank: g?.roundRank ?? null,
      pileCount: g?.pile.length ?? 0,
      lastPlay: lp ? { id: lp.id, playerId: lp.playerId, count: lp.cards.length, rank: lp.rank } : null,
      passedIds: g ? [...g.passed] : [],
      reveal: g?.reveal ?? null,
      hand: [...(g?.hands.get(meId) ?? [])],
      loserId: g?.loserId ?? null,
      loserIds: g?.over ? g.losers() : [],
      endedEarly: g?.endedEarly ?? false,
      awards: g?.over ? computeAwards(g.stats) : [],
      // only people without a seat see the cards; seated players never get this
      watch:
        g && !seatedIds.has(meId)
          ? {
              hands: Object.fromEntries(g.order.map((id) => [id, [...(g.hands.get(id) ?? [])]])),
              lastPlayCards: lp ? [...lp.cards] : null,
            }
          : null,
      coinResults: this.coinResults,
      stopped: g?.aborted ?? false,
      bluffCallsLeft: g && seatedIds.has(meId) ? g.bluffCallsLeft(meId) : 0,
      peeksLeft: g && seatedIds.has(meId) ? g.peeksLeft(meId) : 0,
      betLimit: me && g?.config.bets && seatedIds.has(meId) ? Math.min(g.config.stake, this.betRoom(me)) : 0,
      // in the lobby, show who would pair up if the game started now
      teams: g ? g.teams : lobbySlots && !lobbySlots.includes(null) ? [[lobbySlots[0]!, lobbySlots[2]!], [lobbySlots[1]!, lobbySlots[3]!]] : null,
      winnerIds: g ? g.winners() : [],
      slots: lobbySlots,
      swapAsks: [...this.swapAsks].map(([toId, fromId]) => ({ fromId, toId })),
      // partners plan together: each sees the other's hand; nobody else gets it
      partnerHand: g?.teams && seatedIds.has(meId) ? [...(g.hands.get(g.partnerOf(meId) ?? '') ?? [])] : null,
      watchRequests:
        meId === this.hostId
          ? this.watchRequests.map((r) => ({ id: r.id, name: r.name, registered: r.account !== null, level: r.account?.level ?? null }))
          : [],
      leftPlayers: g
        ? g.order.flatMap((id) => {
            const m = g.forfeited.has(id) ? this.departed.get(id) : undefined;
            return m ? [{ id, name: m.name, registered: m.userId !== null, level: m.level }] : [];
          })
        : [],
    };
  }

  note(kind: AnnounceKind, text: string): Announcement {
    return { id: ++this.announceSeq, kind, text };
  }

  announce(events: GameEvent[]): Announcement[] {
    return events.map((e) => this.note(...this.describe(e)));
  }

  private describe(e: GameEvent): [AnnounceKind, string] {
    const n = (id: string | null) => this.members.find((m) => m.id === id)?.name ?? 'Someone';
    switch (e.kind) {
      case 'play':
        return ['play', `${n(e.playerId)} played ${describeClaim(e.count, e.rank)}`];
      case 'pass':
        return ['pass', `${n(e.playerId)} passed`];
      case 'bluff':
        return [
          'bluff',
          (e.bluff
            ? `${n(e.callerId)} called bluff. Caught! ${n(e.playerId)} picks up ${e.pileCount} cards`
            : `${n(e.callerId)} called bluff. It was true! ${n(e.callerId)} picks up ${e.pileCount} cards`) +
            (e.bet > 0 ? `. ${n(e.loserId)} pays ${e.bet} coins` : ''),
        ];
      case 'newRound':
        return ['round', `${n(e.starterId)} starts a new round`];
      case 'roundEnd':
        return ['round', `Everyone passed. ${n(e.starterId)} starts a new round`];
      case 'finish':
        return ['finish', `${n(e.playerId)} finished ${ordinal(e.place)}`];
      case 'gameOver': {
        if (this.game?.aborted) {
          return ['over', this.game.teams ? 'Game stopped, a team lost a player. No coins moved' : 'Game stopped, not enough players left. No coins moved'];
        }
        if (this.game?.teams) {
          const won = this.game.winners().map(n).join(' and ');
          return ['over', this.game.endedEarly ? `The host ended the game. ${won} win` : `Game over. ${won} win`];
        }
        if (this.game?.endedEarly) return ['over', `The host ended the game. ${n(this.game.places[0])} wins`];
        const liar =this.game ? computeAwards(this.game.stats).find((a) => a.title === 'Biggest liar') : undefined;
        const loser = e.loserId ? `Game over. ${n(e.loserId)} is the loser` : 'Game over';
        return ['over', liar ? `${loser}. Biggest liar: ${liar.playerIds.map(n).join(' and ')}` : loser];
      }
    }
  }

  /** watchers waiting for a seat take free ones in the order they joined; those who chose to watch stay put */
  private fillSeats(): void {
    for (const m of this.members) {
      if (m.watching && !m.watchByChoice && this.players().length < MAX_PLAYERS) m.watching = false;
    }
  }

  private assertHost(by: string): void {
    if (by !== this.hostId) throw new GameError('Only the host can do that');
  }
}

export class RoomManager {
  private rooms = new Map<string, Room>();
  /** when each network created rooms, for the creation limit */
  private created = new Map<string, number[]>();

  constructor(private readonly limits: RoomLimits = DEFAULT_ROOM_LIMITS) {}

  create(name: string, account: MemberAccount | null = null, ip = ''): { room: Room; member: Member } {
    if (this.rooms.size >= MAX_ROOMS) throw new GameError('Server is busy, try again later');
    if (ip) {
      const now = Date.now();
      const recent = (this.created.get(ip) ?? []).filter((t) => now - t < CREATE_WINDOW_MS);
      if (recent.length >= this.limits.createsPerIp) throw new GameError('Too many new rooms from your network. Try again in a few minutes');
      const live = [...this.rooms.values()].filter((r) => r.creatorIp === ip).length;
      if (live >= this.limits.liveRoomsPerIp) throw new GameError('Your network already has several rooms open. Use one of them');
      recent.push(now);
      this.created.set(ip, recent);
    }
    let code = '';
    do {
      code = Array.from({ length: 4 }, () => CODE_LETTERS[randomInt(CODE_LETTERS.length)]).join('');
    } while (this.rooms.has(code));
    const room = new Room(code);
    room.creatorIp = ip;
    this.rooms.set(code, room);
    return { room, member: room.addMember(name, account) };
  }

  /** a room nobody is in any more goes away at once */
  dropIfEmpty(room: Room): void {
    if (room.members.length === 0) this.rooms.delete(room.code);
  }

  join(code: string, name: string, account: MemberAccount | null = null): { room: Room; member: Member } {
    const room = this.get(code);
    return { room, member: room.addMember(name, account) };
  }

  rejoin(code: string, token: string): { room: Room; member: Member } {
    const room = this.get(code);
    const member = room.members.find((m) => m.token === token);
    if (!member) throw new GameError('Your seat in this room is gone');
    return { room, member };
  }

  /** the room a logged-in player is in (seated, watching, or holding a seat while offline) */
  roomOfUser(userId: string): Room | null {
    for (const room of this.rooms.values()) {
      if (room.members.some((m) => m.userId === userId)) return room;
    }
    return null;
  }

  get(code: string): Room {
    const room = this.rooms.get(code);
    if (!room) throw new GameError(`Room ${code} not found`);
    return room;
  }

  /** drops stale lobby seats, stale watchers and idle rooms; returns rooms whose member list changed */
  sweep(now = Date.now()): Room[] {
    const changed: Room[] = [];
    for (const [ip, times] of this.created) {
      const recent = times.filter((t) => now - t < CREATE_WINDOW_MS);
      if (recent.length > 0) this.created.set(ip, recent);
      else this.created.delete(ip);
    }
    for (const room of this.rooms.values()) {
      if (room.members.every((m) => !m.socketId && now - m.lastSeen > ROOM_IDLE_MS)) {
        this.rooms.delete(room.code);
        continue;
      }
      const stale = room.members.filter(
        (m) => !m.socketId && now - m.lastSeen > LOBBY_GRACE_MS && (room.phase === 'lobby' || m.watching),
      );
      if (stale.length === 0) continue;
      stale.forEach((m) => room.removeMember(m.id));
      changed.push(room);
    }
    return changed;
  }

  get size(): number {
    return this.rooms.size;
  }
}
