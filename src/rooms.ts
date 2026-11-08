import { randomBytes, randomInt } from 'node:crypto';
import { computeAwards } from './awards.js';
import { describeClaim, ordinal } from './cards.js';
import { Game, GameError } from './game.js';
import type { GameEvent, GameRecord, Member } from './models.js';
import type { AnnounceKind, Announcement, ChatEvent, ChatKind, CoinResult, GameConfig, Phase, RoomView } from './types.js';

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

export class Room {
  members: Member[] = [];
  hostId = '';
  config: GameConfig = { decks: 1, bluffRule: 'all', stake: 0 };
  game: Game | null = null;
  startedAt: Date | null = null;
  /** coin changes of the last finished game, filled once it's saved */
  coinResults: CoinResult[] | null = null;
  /** true while a staked start is checking balances */
  starting = false;
  /** players the host removed mid-game, kept so the saved game still has their name */
  private departed = new Map<string, Member>();
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

  addMember(name: string, userId: string | null = null, coins: number | null = null): Member {
    if (this.members.length >= MAX_MEMBERS) throw new GameError(`Room is full (max ${MAX_MEMBERS})`);
    if (userId && this.members.some((m) => m.userId === userId)) throw new GameError('Your account is already in this room');
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
      userId,
      coins: userId ? coins : null,
    };
    this.members.push(member);
    if (!this.hostId) this.hostId = member.id;
    return member;
  }

  removeMember(id: string): void {
    const leaving = this.member(id);
    if (this.phase === 'playing' && !leaving.watching) throw new GameError('You cannot leave in the middle of a game');
    this.members = this.members.filter((m) => m.id !== id);
    this.lastChat.delete(id);
    if (this.phase === 'lobby') this.fillSeats();
    if (this.hostId === id) this.hostId = (this.players()[0] ?? this.members[0])?.id ?? '';
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
    if (this.phase === 'lobby') this.fillSeats();
    return { kicked: target, events };
  }

  setConfig(by: string, config: GameConfig): void {
    this.assertHost(by);
    if (this.phase !== 'lobby') throw new GameError('Settings can only change in the lobby');
    this.config = config;
  }

  /** host, lobby and player-count checks; staked checks need coin balances and run in socket.ts */
  assertCanStart(by: string): void {
    this.assertHost(by);
    if (this.phase !== 'lobby') throw new GameError('Game already started');
    if (this.players().length < 2) throw new GameError('Need at least 2 players');
  }

  start(by: string): void {
    this.assertCanStart(by);
    this.game = new Game(
      this.players().map((m) => m.id),
      this.config,
    );
    this.startedAt = new Date();
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
        loser: status === 'finished' && g.loserId === id,
        kicked: g.kicked.has(id),
        stats: { ...g.stats.get(id)! },
      })),
      awards: status === 'finished' ? computeAwards(g.stats) : [],
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

  view(meId: string): RoomView {
    const g = this.game;
    const lp = g?.lastPlay;
    // during a game the seats are that game's players; everyone else watches
    const seated = g ? g.order.flatMap((id) => this.members.filter((m) => m.id === id)) : this.players();
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
      })),
      watchers: this.members
        .filter((m) => !seatedIds.has(m.id))
        .map((m) => ({ id: m.id, name: m.name, connected: m.socketId !== null })),
      turnId: g?.turnId ?? null,
      roundRank: g?.roundRank ?? null,
      pileCount: g?.pile.length ?? 0,
      lastPlay: lp ? { id: lp.id, playerId: lp.playerId, count: lp.cards.length, rank: lp.rank } : null,
      passedIds: g ? [...g.passed] : [],
      reveal: g?.reveal ?? null,
      hand: [...(g?.hands.get(meId) ?? [])],
      loserId: g?.loserId ?? null,
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
          e.bluff
            ? `${n(e.callerId)} called bluff. Caught! ${n(e.playerId)} picks up ${e.pileCount} cards`
            : `${n(e.callerId)} called bluff. It was true! ${n(e.callerId)} picks up ${e.pileCount} cards`,
        ];
      case 'newRound':
        return ['round', `${n(e.starterId)} starts a new round`];
      case 'roundEnd':
        return ['round', `Everyone passed. ${n(e.starterId)} starts a new round`];
      case 'finish':
        return ['finish', `${n(e.playerId)} finished ${ordinal(e.place)}`];
      case 'gameOver': {
        if (this.game?.aborted) return ['over', 'Game stopped, not enough players left. No coins moved'];
        const liar =this.game ? computeAwards(this.game.stats).find((a) => a.title === 'Biggest liar') : undefined;
        const loser = e.loserId ? `Game over. ${n(e.loserId)} is the loser` : 'Game over';
        return ['over', liar ? `${loser}. Biggest liar: ${liar.playerIds.map(n).join(' and ')}` : loser];
      }
    }
  }

  /** watchers take free seats in the order they joined */
  private fillSeats(): void {
    for (const m of this.members) {
      if (m.watching && this.players().length < MAX_PLAYERS) m.watching = false;
    }
  }

  private assertHost(by: string): void {
    if (by !== this.hostId) throw new GameError('Only the host can do that');
  }
}

export class RoomManager {
  private rooms = new Map<string, Room>();

  create(name: string, userId: string | null = null, coins: number | null = null): { room: Room; member: Member } {
    if (this.rooms.size >= MAX_ROOMS) throw new GameError('Server is busy, try again later');
    let code = '';
    do {
      code = Array.from({ length: 4 }, () => CODE_LETTERS[randomInt(CODE_LETTERS.length)]).join('');
    } while (this.rooms.has(code));
    const room = new Room(code);
    this.rooms.set(code, room);
    return { room, member: room.addMember(name, userId, coins) };
  }

  join(code: string, name: string, userId: string | null = null, coins: number | null = null): { room: Room; member: Member } {
    const room = this.get(code);
    return { room, member: room.addMember(name, userId, coins) };
  }

  rejoin(code: string, token: string): { room: Room; member: Member } {
    const room = this.get(code);
    const member = room.members.find((m) => m.token === token);
    if (!member) throw new GameError('Your seat in this room is gone');
    return { room, member };
  }

  get(code: string): Room {
    const room = this.rooms.get(code);
    if (!room) throw new GameError(`Room ${code} not found`);
    return room;
  }

  /** drops stale lobby seats, stale watchers and idle rooms; returns rooms whose member list changed */
  sweep(now = Date.now()): Room[] {
    const changed: Room[] = [];
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
