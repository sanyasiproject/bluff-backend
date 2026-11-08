import type { Award, Card, GameConfig, Rank } from './types.js';

// Server-only shapes, never sent to clients as-is
export interface Member {
  id: string;
  /** secret used to rejoin the same seat; never broadcast */
  token: string;
  name: string;
  socketId: string | null;
  lastSeen: number;
  /** no seat: joined mid-game or the room already had 5 players */
  watching: boolean;
  /** account id when logged in; null for guests */
  userId: string | null;
}

/** logged-in account attached to a socket */
export interface SocketUser {
  id: string;
  displayName: string;
}

/** a finished (or host-ended) game, ready to be saved */
export interface GameRecord {
  roomCode: string;
  config: GameConfig;
  status: 'finished' | 'ended_early';
  startedAt: Date;
  endedAt: Date;
  players: { memberId: string; userId: string | null; name: string; place: number | null; loser: boolean; stats: PlayerStats }[];
  awards: Award[];
}

/** optional server features wired in by server.ts (accounts, saving games) */
export interface SocketHooks {
  resolveUser?: (token: string) => Promise<SocketUser | null>;
  onGameEnd?: (record: GameRecord) => void;
}

/** per-player counts behind the end-of-game awards */
export interface PlayerStats {
  bluffs: number;
  caught: number;
  goodCalls: number;
  wrongCalls: number;
  pickedUp: number;
}

export interface PlayRecord {
  id: string;
  playerId: string;
  cards: Card[];
  rank: Rank;
}

export type GameEvent =
  | { kind: 'play'; playerId: string; count: number; rank: Rank }
  | { kind: 'pass'; playerId: string }
  | { kind: 'bluff'; callerId: string; playerId: string; bluff: boolean; loserId: string; pileCount: number }
  | { kind: 'newRound'; starterId: string }
  | { kind: 'roundEnd'; starterId: string; discarded: number }
  | { kind: 'finish'; playerId: string; place: number }
  | { kind: 'gameOver'; loserId: string | null };
