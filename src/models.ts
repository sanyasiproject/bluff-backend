import type { Award, Card, CoinResult, GameConfig, Rank } from './types.js';

// Server-only shapes, never sent to clients as-is
export interface Member {
  id: string;
  /** secret used to rejoin the same seat; never broadcast */
  token: string;
  name: string;
  socketId: string | null;
  lastSeen: number;
  /** no seat: joined mid-game, the room already had 5 players, or chose to watch */
  watching: boolean;
  /** chose to watch in the lobby; stays a watcher until they switch back, even when a seat frees up */
  watchByChoice: boolean;
  /** account id when logged in; null for guests */
  userId: string | null;
  /** coin balance as last seen (display only); null for guests */
  coins: number | null;
  /** null for guests */
  username: string | null;
  /** account level as last seen; null for guests */
  level: number | null;
}

/** the account behind a logged-in member */
export interface MemberAccount {
  userId: string;
  username: string;
  coins: number | null;
  level: number | null;
}

/** logged-in account attached to a socket */
export interface SocketUser {
  id: string;
  username: string;
  displayName: string;
}

export interface GameRecordPlayer {
  memberId: string;
  userId: string | null;
  name: string;
  place: number | null;
  loser: boolean;
  /** removed by the host mid-game: pays nothing, wins nothing */
  kicked: boolean;
  stats: PlayerStats;
}

/** a finished (or stopped) game, ready to be saved */
export interface GameRecord {
  roomCode: string;
  config: GameConfig;
  status: 'finished' | 'ended_early';
  startedAt: Date;
  endedAt: Date;
  players: GameRecordPlayer[];
  awards: Award[];
}

/** optional server features wired in by server.ts (accounts, coins, friends) */
export interface SocketHooks {
  resolveUser?: (token: string) => Promise<SocketUser | null>;
  /** current balance and level by user id */
  getAccounts?: (userIds: string[]) => Promise<Map<string, { coins: number; level: number }>>;
  /** saves the game, moves stake coins, pays daily game rewards; resolves with each player's coin change */
  onGameEnd?: (record: GameRecord) => Promise<CoinResult[]>;
  areFriends?: (a: string, b: string) => Promise<boolean>;
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
