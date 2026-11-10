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
  /** 2v2 slot 0-3 (🔵 0 & 2, 🟠 1 & 3); null when not in a team slot */
  slot: number | null;
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

/** someone asking to watch a game in progress; the host lets them in or not */
export interface WatchRequest {
  id: string;
  name: string;
  account: MemberAccount | null;
  socketId: string;
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
  /** 1st place, or on the winning team */
  won: boolean;
  stats: PlayerStats;
}

/** a bet on a bluff call: the loser of the call pays the winner when the game is saved */
export interface BetResult {
  from: string;
  to: string;
  amount: number;
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
  /** bets on bluff calls, by member id */
  bets: BetResult[];
}

/** optional server features wired in by server.ts (accounts, coins, friends) */
export interface SocketHooks {
  resolveUser?: (token: string) => Promise<SocketUser | null>;
  /** current balance and level by user id */
  getAccounts?: (userIds: string[]) => Promise<Map<string, { coins: number; level: number }>>;
  /** saves the game, moves stake coins, pays daily game rewards; resolves with each player's coin change */
  onGameEnd?: (record: GameRecord) => Promise<CoinResult[]>;
  areFriends?: (a: string, b: string) => Promise<boolean>;
  /** false when an admin turned guest play off: guests can't create or join rooms */
  guestsAllowed?: () => boolean;
  /** moves coins to a friend within the daily gift limit; throws GameError with a reason players can read */
  giftCoins?: (fromUserId: string, toUserId: string, amount: number) => Promise<GiftResult>;
}

/** balances after a gift between friends */
export interface GiftResult {
  fromCoins: number;
  giftLeft: number;
  toCoins: number;
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
  | { kind: 'bluff'; callerId: string; playerId: string; bluff: boolean; loserId: string; pileCount: number; bet: number }
  | { kind: 'newRound'; starterId: string }
  | { kind: 'roundEnd'; starterId: string; discarded: number }
  | { kind: 'finish'; playerId: string; place: number }
  | { kind: 'gameOver'; loserId: string | null };
