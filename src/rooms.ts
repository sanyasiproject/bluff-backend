import { randomBytes, randomInt } from 'node:crypto';
import { computeAwards } from './awards.js';
import { cardName, describeClaim, ordinal } from './cards.js';
import { Crazy7Game } from './crazy7/game.js';
import { Game, GameError } from './game.js';
import type { GameEvent, GameRecord, Member, MemberAccount, TableGame, WatchRequest } from './models.js';
import { BOT_MAX_STAKE, type AnnounceKind, type Announcement, type ChatEvent, type ChatKind, type CoinResult, type Crazy7View, type GameConfig, type Phase, type RoomView, type ThrowEvent } from './types.js';

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
/** after asking to watch, or being turned down, wait this long before asking again */
export const WATCH_ASK_GAP_MS = 10_000;
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
  config: GameConfig = { game: 'bluff', decks: 1, bluffRule: 'one', stake: 0, peeks: 0, bets: false, teams: false, handSize: 7, maxPicks: 1, stack7: true };
  /** a Bluff game */
  game: Game | null = null;
  /** a Crazy 7 game */
  c7: Crazy7Game | null = null;
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
  /** when each requester last asked or was turned down, by WatchRequest.key */
  private askedAt = new Map<string, number>();
  /** network that created the room, for the per-network room limit */
  creatorIp = '';
  private announceSeq = 0;
  private lastChat = new Map<string, number>();

  constructor(readonly code: string) {}

  /** whichever game is on */
  get table(): TableGame | null {
    return this.game ?? this.c7;
  }

  get phase(): Phase {
    const g = this.table;
    if (!g) return 'lobby';
    return g.over ? 'over' : 'playing';
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

  /** watch: join as a watcher by choice (lobby) */
  addMember(name: string, account: MemberAccount | null = null, watch = false): Member {
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
      watching: watch || this.phase === 'playing' || this.players().length >= MAX_PLAYERS,
      watchByChoice: watch,
      slot: null,
      userId: account?.userId ?? null,
      coins: account?.coins ?? null,
      username: account?.username ?? null,
      level: account?.level ?? null,
      stats: account?.stats ?? null,
      bot: false,
    };
    this.members.push(member);
    if (!this.hostId) this.hostId = member.id;
    return member;
  }

  /** leaves the room; a player seated in a running game forfeits it. Returns any game events */
  removeMember(id: string): GameEvent[] {
    const leaving = this.member(id);
    let events: GameEvent[] = [];
    if (this.phase === 'playing' && this.table?.order.includes(id)) {
      events = this.table.leave(id);
      // kept so the saved game still has their name
      this.departed.set(id, leaving);
    }
    this.members = this.members.filter((m) => m.id !== id);
    this.lastChat.delete(id);
    this.forgetSwaps(id);
    if (this.phase === 'lobby') this.fillSeats();
    if (this.hostId === id) {
      // the host role only ever goes to a person
      const people = this.members.filter((m) => !m.bot);
      this.hostId = (people.find((m) => !m.watching) ?? people[0])?.id ?? '';
    }
    return events;
  }

  /** host seats a bot in the lobby; bots cap the stake. Returns the bot and whether the stake came down */
  addBot(by: string, name: string): { bot: Member; stakeLowered: boolean } {
    this.assertHost(by);
    if (this.phase !== 'lobby') throw new GameError('Bots can only join in the lobby');
    if (this.players().length >= MAX_PLAYERS) throw new GameError(`All ${MAX_PLAYERS} seats are taken`);
    const bot = this.addMember(name);
    bot.bot = true;
    const stakeLowered = this.config.stake > BOT_MAX_STAKE;
    if (stakeLowered) this.config = { ...this.config, stake: BOT_MAX_STAKE };
    return { bot, stakeLowered };
  }

  /** at least one person is here; a room is never left to bots alone */
  get hasPeople(): boolean {
    return this.members.some((m) => !m.bot);
  }

  get hasBots(): boolean {
    return this.members.some((m) => m.bot);
  }

  /** the last person left: the bots go with them */
  clearBots(): void {
    this.members = this.members.filter((m) => !m.bot);
  }

  /** the last person is leaving: a running game ends at once */
  endGameNow(): GameEvent[] {
    const g = this.table;
    return g && !g.over ? g.close() : [];
  }

  /** nobody but bots holds cards any more, so the result is settled: end the game now (2v2 plays on to find the team) */
  endIfOnlyBots(): GameEvent[] {
    const g = this.table;
    if (!g || g.over || g.teams) return [];
    const people = g.order.filter((id) => !this.isBot(id));
    return people.every((id) => g.hand(id).length === 0) ? g.close() : [];
  }

  isBot(id: string): boolean {
    return (this.members.find((m) => m.id === id) ?? this.departed.get(id))?.bot ?? false;
  }

  /** a game is running: newcomers ask the host instead of joining straight away */
  get needsApproval(): boolean {
    return this.phase === 'playing';
  }

  requestWatch(name: string, account: MemberAccount | null, socketId: string, key: string): WatchRequest {
    const now = Date.now();
    for (const [k, at] of this.askedAt) if (now - at >= WATCH_ASK_GAP_MS) this.askedAt.delete(k);
    const last = this.askedAt.get(key);
    if (last !== undefined) throw new GameError(`Wait ${Math.ceil((WATCH_ASK_GAP_MS - (now - last)) / 1000)} s before asking again`);
    if (this.members.length >= MAX_MEMBERS) throw new GameError(`Room is full (max ${MAX_MEMBERS})`);
    if (this.watchRequests.length >= MAX_WATCH_REQUESTS) throw new GameError('The host has a lot of requests, try again soon');
    if (account && this.members.some((m) => m.userId === account.userId)) throw new GameError('Your account is already in this room');
    const taken = [...this.members.map((m) => m.name), ...this.watchRequests.map((r) => r.name)];
    if (taken.some((n) => n.toLowerCase() === name.toLowerCase())) throw new GameError('That name is taken in this room');
    this.dropWatchRequests(socketId);
    const req: WatchRequest = { id: randomBytes(6).toString('hex'), name, account, socketId, key };
    this.watchRequests.push(req);
    this.askedAt.set(key, now);
    return req;
  }

  /** the host answers one request; it's removed either way, and a no starts the wait before asking again */
  takeWatchRequest(by: string, id: string, accept: boolean): WatchRequest {
    this.assertHost(by);
    const req = this.watchRequests.find((r) => r.id === id);
    if (!req) throw new GameError('That request was cancelled');
    this.watchRequests = this.watchRequests.filter((r) => r !== req);
    if (!accept) this.askedAt.set(req.key, Date.now());
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
    if (this.phase === 'playing' && this.table?.order.includes(targetId)) {
      events = this.table.removePlayer(targetId);
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
    if (target.bot) throw new GameError("A bot can't be the host");
    if (!target.socketId) throw new GameError(`${target.name} is offline`);
    this.hostId = target.id;
    return target;
  }

  /** in the lobby anyone can sit out and watch, or take a free seat again; the host can move anyone */
  setWatching(by: string, targetId: string, watching: boolean): Member {
    if (targetId !== by) this.assertHost(by);
    if (this.phase !== 'lobby') throw new GameError('You can switch between playing and watching in the lobby');
    const m = this.member(targetId);
    if (m.bot) throw new GameError('Bots always play. Remove the bot instead');
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
    if (this.hasBots && config.stake > BOT_MAX_STAKE) throw new GameError(`With bots at the table the stake can be up to ${BOT_MAX_STAKE}`);
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
    if (!this.players().some((m) => !m.bot)) throw new GameError('Someone has to play with the bots');
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
    this.startedAt = new Date();
    this.swapAsks.clear();
    this.coinResults = null;
    this.departed.clear();
    if (this.config.game === 'crazy7') {
      this.game = null;
      this.c7 = new Crazy7Game(this.players().map((m) => m.id), this.config);
      return;
    }
    this.c7 = null;
    this.game = new Game(
      // 2v2 plays in slot order, so the teams alternate turns
      this.config.teams ? (this.slotIds().filter((id) => id !== null) as string[]) : this.players().map((m) => m.id),
      this.config,
    );
  }

  /** the current game as a record to save; take it before the game is cleared */
  snapshot(status: GameRecord['status']): GameRecord | null {
    const g = this.table;
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
        bot: member(id)?.bot ?? false,
        stats: { ...g.stats.get(id)! },
      })),
      awards: status === 'finished' ? computeAwards(g.stats, g.config.game) : [],
      bets: status === 'finished' ? [...g.bets] : [],
    };
  }

  /** after game over anyone can return; mid-game only the host (or anyone if the host is offline) */
  backToLobby(by: string): void {
    if (this.phase === 'playing' && by !== this.hostId && this.member(this.hostId).socketId) {
      throw new GameError('Only the host can end the game');
    }
    this.game = null;
    this.c7 = null;
    this.coinResults = null;
    this.departed.clear();
    this.fillSeats();
  }

  /** host ends the game once someone has won; 1st place wins and everyone else loses */
  endGame(by: string): GameEvent[] {
    this.assertHost(by);
    if (this.c7) throw new GameError('In Crazy 7 the first player out wins. Use Stop game instead');
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

  requireCrazy7(): Crazy7Game {
    if (!this.c7 || this.c7.over) throw new GameError('No Crazy 7 game in progress');
    return this.c7;
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
    // g is whichever game is on; b only while it's Bluff
    const g = this.table;
    const b = this.game;
    const lp = b?.lastPlay;
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
        connected: m.bot || m.socketId !== null,
        cardCount: g?.hands.get(m.id)?.length ?? 0,
        place: g ? g.places.indexOf(m.id) + 1 || null : null,
        registered: m.userId !== null,
        coins: m.coins,
        username: m.username,
        level: m.level,
        bot: m.bot,
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
      roundRank: b?.roundRank ?? null,
      pileCount: g?.pile.length ?? 0,
      lastPlay: lp ? { id: lp.id, playerId: lp.playerId, count: lp.cards.length, rank: lp.rank } : null,
      passedIds: b ? [...b.passed] : [],
      reveal: b?.reveal ?? null,
      hand: [...(g?.hands.get(meId) ?? [])],
      loserId: b?.loserId ?? null,
      loserIds: g?.over ? g.losers() : [],
      endedEarly: g?.endedEarly ?? false,
      awards: g?.over ? computeAwards(g.stats, g.config.game) : [],
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
      bluffCallsLeft: b && seatedIds.has(meId) ? b.bluffCallsLeft(meId) : 0,
      peeksLeft: b && seatedIds.has(meId) ? b.peeksLeft(meId) : 0,
      betLimit: me && b?.config.bets && seatedIds.has(meId) ? Math.min(b.config.stake, this.betRoom(me)) : 0,
      // in the lobby, show who would pair up if the game started now
      teams: g ? g.teams : lobbySlots && !lobbySlots.includes(null) ? [[lobbySlots[0]!, lobbySlots[2]!], [lobbySlots[1]!, lobbySlots[3]!]] : null,
      winnerIds: g ? g.winners() : [],
      slots: lobbySlots,
      swapAsks: [...this.swapAsks].map(([toId, fromId]) => ({ fromId, toId })),
      // partners plan together: each sees the other's hand; nobody else gets it
      partnerHand: b?.teams && seatedIds.has(meId) ? [...(b.hands.get(b.partnerOf(meId) ?? '') ?? [])] : null,
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
      crazy7: this.c7 ? this.crazy7View(meId) : null,
    };
  }

  /** the Crazy 7 table as one member sees it: the my-turn fields are filled only for the player on turn */
  private crazy7View(meId: string): Crazy7View {
    const c = this.c7!;
    const seated = c.order.includes(meId);
    return {
      top: c.top(),
      under: c.pile.slice(-4, -1),
      pileCount: c.pile.length,
      deckCount: c.deck.length,
      penalty: c.penalty,
      picks: c.picks,
      playable: seated ? c.playable(meId).map((card) => card.id) : [],
      canPick: seated && c.canPick(meId),
      canPass: seated && c.canPass(meId),
      canCall: seated && c.canCall(meId),
      picked: seated && c.turnId === meId ? [...c.picked] : [],
      called: [...c.called],
      missed: [...c.missed],
      atRisk: c.atRisk,
      last: c.last ? { ...c.last } : null,
    };
  }

  note(kind: AnnounceKind, text: string): Announcement {
    return { id: ++this.announceSeq, kind, text };
  }

  announce(events: GameEvent[]): Announcement[] {
    return events.flatMap((e) => {
      const said = this.describe(e);
      return said ? [this.note(...said)] : [];
    });
  }

  /** what the table hears; null for moves that only show on the seats */
  private describe(e: GameEvent): [AnnounceKind, string] | null {
    const n = (id: string | null) => this.members.find((m) => m.id === id)?.name ?? 'Someone';
    if (this.c7) return this.describeCrazy7(e, n);
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
        if (this.game?.closed) {
          const first = this.game.places[0];
          return ['over', first ? `Game over. Only bots are left playing. ${n(first)} wins` : 'Game over. Only bots are left playing'];
        }
        const liar =this.game ? computeAwards(this.game.stats).find((a) => a.title === 'Biggest liar') : undefined;
        const loser = e.loserId ? `Game over. ${n(e.loserId)} is the loser` : 'Game over';
        return ['over', liar ? `${loser}. Biggest liar: ${liar.playerIds.map(n).join(' and ')}` : loser];
      }
      default:
        return null;
    }
  }

  private describeCrazy7(e: GameEvent, n: (id: string | null) => string): [AnnounceKind, string] | null {
    const c = this.c7!;
    switch (e.kind) {
      case 'c7play':
        return ['play', `${n(e.playerId)} played ${cardName(e.card)}` + (e.penalty > 0 ? `. Pick ${e.penalty}!` : '')];
      case 'c7penalty':
        return ['pass', e.missed ? `${n(e.playerId)} picks ${e.count} and misses a turn` : `${n(e.playerId)} picks ${e.count}`];
      case 'c7call':
        return ['round', `${n(e.playerId)}: last card!`];
      case 'c7missed':
        return ['bluff', `Caught! ${n(e.playerId)} didn't say last card`];
      case 'c7shuffle':
        return ['room', 'The pile was shuffled into a new deck'];
      case 'gameOver':
        if (c.aborted) return ['over', 'Game stopped, not enough players left. No coins moved'];
        if (c.closed) return ['over', 'Game over. Only bots are left playing'];
        return ['over', `Game over. ${n(c.places[0] ?? null)} wins`];
      default:
        // picks, passes and the winner's last card show on the table instead
        return null;
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
    if (!room.hasPeople) this.rooms.delete(room.code);
  }

  join(code: string, name: string, account: MemberAccount | null = null, watch = false): { room: Room; member: Member } {
    const room = this.get(code);
    return { room, member: room.addMember(name, account, watch) };
  }

  /** the room still exists (bots stop playing in one that's gone) */
  isOpen(room: Room): boolean {
    return this.rooms.get(room.code) === room;
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
      // bots never count as someone being here
      if (room.members.every((m) => m.bot || (!m.socketId && now - m.lastSeen > ROOM_IDLE_MS))) {
        this.rooms.delete(room.code);
        continue;
      }
      const stale = room.members.filter(
        (m) => !m.bot && !m.socketId && now - m.lastSeen > LOBBY_GRACE_MS && (room.phase === 'lobby' || m.watching),
      );
      if (stale.length === 0) continue;
      stale.forEach((m) => room.removeMember(m.id));
      if (!room.hasPeople) {
        this.rooms.delete(room.code);
        continue;
      }
      changed.push(room);
    }
    return changed;
  }

  get size(): number {
    return this.rooms.size;
  }
}
