import type { Award, Card, CoinResult, GameConfig, LifetimeStats, Rank } from './types.js';

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
  /** lifetime stats read when they joined, so bots can size up the player without the database; null for guests and bots */
  stats: LifetimeStats | null;
  /** played by the server */
  bot: boolean;
}

/** the account behind a logged-in member */
export interface MemberAccount {
  userId: string;
  username: string;
  coins: number | null;
  level: number | null;
  stats: LifetimeStats | null;
}

/** someone asking to watch a game in progress; the host lets them in or not */
export interface WatchRequest {
  id: string;
  name: string;
  account: MemberAccount | null;
  socketId: string;
  /** the account, or a guest's network and name, for the wait before asking again */
  key: string;
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
  bot: boolean;
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
  /** current balance, level and lifetime stats by user id */
  getAccounts?: (userIds: string[]) => Promise<Map<string, AccountInfo>>;
  /** saves the game, moves stake coins, pays daily game rewards; resolves with each player's coin change */
  onGameEnd?: (record: GameRecord) => Promise<CoinResult[]>;
  areFriends?: (a: string, b: string) => Promise<boolean>;
  /** false when an admin turned guest play off: guests can't create or join rooms */
  guestsAllowed?: () => boolean;
  /** moves coins to a friend within the daily gift limit; throws GameError with a reason players can read */
  giftCoins?: (fromUserId: string, toUserId: string, amount: number) => Promise<GiftResult>;
}

/** what a room needs to know about an account */
export interface AccountInfo {
  coins: number;
  level: number;
  stats: LifetimeStats;
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
  plays: number;
  /** plays by others this player could have called bluff on */
  chances: number;
  /** Crazy 7: sevens played */
  sevens?: number;
  /** Crazy 7: times they forgot to say last card */
  missedCalls?: number;
  /** Crazy 7: cards picked (kept apart from Bluff's pickedUp, which feeds the Collector achievement) */
  picks?: number;
}

/** what a room reads from whichever game is on (Bluff's Game or Crazy7Game) */
export interface TableGame {
  readonly order: string[];
  readonly config: GameConfig;
  readonly hands: Map<string, Card[]>;
  readonly stats: Map<string, PlayerStats>;
  readonly kicked: Set<string>;
  readonly forfeited: Set<string>;
  readonly teams: [string[], string[]] | null;
  readonly bets: BetResult[];
  readonly endedEarly: boolean;
  pile: Card[];
  places: string[];
  turnId: string | null;
  over: boolean;
  aborted: boolean;
  closed: boolean;
  hand(id: string): Card[];
  winners(): string[];
  losers(): string[];
  leave(id: string): GameEvent[];
  removePlayer(id: string): GameEvent[];
  close(): GameEvent[];
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
  | { kind: 'gameOver'; loserId: string | null }
  // Crazy 7
  | { kind: 'c7play'; playerId: string; card: Card; penalty: number }
  /** forced: picked automatically because nothing matched top */
  | { kind: 'c7pick'; playerId: string; count: number; forced: boolean; top: Card | null }
  /** missed: forgot last card; forced: had no 7 to answer with */
  | { kind: 'c7penalty'; playerId: string; count: number; missed: boolean; forced: boolean }
  | { kind: 'c7pass'; playerId: string; auto: boolean }
  | { kind: 'c7call'; playerId: string }
  | { kind: 'c7missed'; playerId: string }
  | { kind: 'c7shuffle'; count: number };
