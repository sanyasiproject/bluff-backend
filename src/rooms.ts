import { randomBytes, randomInt } from 'node:crypto';
import { describeClaim, ordinal } from './cards.js';
import { Game, GameError } from './game.js';
import type { GameEvent, Member } from './models.js';
import type { AnnounceKind, Announcement, GameConfig, Phase, RoomView } from './types.js';

export const MAX_PLAYERS = 5;
const MAX_ROOMS = 200;
const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
/** a disconnected player keeps their lobby seat this long */
const LOBBY_GRACE_MS = 2 * 60_000;
/** a room with nobody connected is deleted after this long */
const ROOM_IDLE_MS = 30 * 60_000;

export class Room {
  members: Member[] = [];
  hostId = '';
  config: GameConfig = { decks: 1, bluffRule: 'all' };
  game: Game | null = null;
  private announceSeq = 0;

  constructor(readonly code: string) {}

  get phase(): Phase {
    if (!this.game) return 'lobby';
    return this.game.over ? 'over' : 'playing';
  }

  member(id: string): Member {
    const m = this.members.find((x) => x.id === id);
    if (!m) throw new GameError('You are not in this room');
    return m;
  }

  addMember(name: string): Member {
    if (this.phase === 'playing') throw new GameError('Game already started in this room');
    if (this.members.length >= MAX_PLAYERS) throw new GameError(`Room is full (max ${MAX_PLAYERS})`);
    if (this.members.some((m) => m.name.toLowerCase() === name.toLowerCase())) {
      throw new GameError('That name is taken in this room');
    }
    const member: Member = {
      id: randomBytes(6).toString('hex'),
      token: randomBytes(16).toString('hex'),
      name,
      socketId: null,
      lastSeen: Date.now(),
    };
    this.members.push(member);
    if (!this.hostId) this.hostId = member.id;
    return member;
  }

  removeMember(id: string): void {
    if (this.phase === 'playing') throw new GameError('You cannot leave in the middle of a game');
    this.members = this.members.filter((m) => m.id !== id);
    if (this.hostId === id) this.hostId = this.members[0]?.id ?? '';
  }

  setConfig(by: string, config: GameConfig): void {
    this.assertHost(by);
    if (this.phase !== 'lobby') throw new GameError('Settings can only change in the lobby');
    this.config = config;
  }

  start(by: string): void {
    this.assertHost(by);
    if (this.phase !== 'lobby') throw new GameError('Game already started');
    if (this.members.length < 2) throw new GameError('Need at least 2 players');
    this.game = new Game(
      this.members.map((m) => m.id),
      this.config,
    );
  }

  /** after game over anyone can return; mid-game only the host (or anyone if the host is offline) */
  backToLobby(by: string): void {
    if (this.phase === 'playing' && by !== this.hostId && this.member(this.hostId).socketId) {
      throw new GameError('Only the host can end the game');
    }
    this.game = null;
  }

  requireGame(): Game {
    if (!this.game || this.game.over) throw new GameError('No game in progress');
    return this.game;
  }

  view(meId: string): RoomView {
    const g = this.game;
    const lp = g?.lastPlay;
    return {
      code: this.code,
      meId,
      hostId: this.hostId,
      phase: this.phase,
      config: g?.config ?? this.config,
      players: this.members.map((m) => ({
        id: m.id,
        name: m.name,
        connected: m.socketId !== null,
        cardCount: g?.hands.get(m.id)?.length ?? 0,
        place: g ? g.places.indexOf(m.id) + 1 || null : null,
      })),
      turnId: g?.turnId ?? null,
      roundRank: g?.roundRank ?? null,
      pileCount: g?.pile.length ?? 0,
      lastPlay: lp ? { id: lp.id, playerId: lp.playerId, count: lp.cards.length, rank: lp.rank } : null,
      passedIds: g ? [...g.passed] : [],
      reveal: g?.reveal ?? null,
      hand: [...(g?.hands.get(meId) ?? [])],
      loserId: g?.loserId ?? null,
      maxPerPlay: 4 * (g?.config ?? this.config).decks,
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
      case 'gameOver':
        return ['over', e.loserId ? `Game over. ${n(e.loserId)} is the loser` : 'Game over'];
    }
  }

  private assertHost(by: string): void {
    if (by !== this.hostId) throw new GameError('Only the host can do that');
  }
}

export class RoomManager {
  private rooms = new Map<string, Room>();

  create(name: string): { room: Room; member: Member } {
    if (this.rooms.size >= MAX_ROOMS) throw new GameError('Server is busy, try again later');
    let code = '';
    do {
      code = Array.from({ length: 4 }, () => CODE_LETTERS[randomInt(CODE_LETTERS.length)]).join('');
    } while (this.rooms.has(code));
    const room = new Room(code);
    this.rooms.set(code, room);
    return { room, member: room.addMember(name) };
  }

  join(code: string, name: string): { room: Room; member: Member } {
    const room = this.get(code);
    return { room, member: room.addMember(name) };
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

  /** drops stale lobby seats and idle rooms; returns rooms whose player list changed */
  sweep(now = Date.now()): Room[] {
    const changed: Room[] = [];
    for (const room of this.rooms.values()) {
      if (room.members.every((m) => !m.socketId && now - m.lastSeen > ROOM_IDLE_MS)) {
        this.rooms.delete(room.code);
        continue;
      }
      if (room.phase !== 'lobby') continue;
      const stale = room.members.filter((m) => !m.socketId && now - m.lastSeen > LOBBY_GRACE_MS);
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
