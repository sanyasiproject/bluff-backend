import type { Collection, ObjectId } from 'mongodb';
import type { PlayerStats } from '../models.js';
import type { GameConfig, LifetimeStats, Role } from '../types.js';

/** database and collection names, all overridable from env */
export interface DbNames {
  db: string;
  users: string;
  sessions: string;
  games: string;
  audit: string;
  friends: string;
}

export interface UserDoc {
  _id: ObjectId;
  /** lowercase, unique */
  username: string;
  displayName: string;
  /** scrypt$N$r$p$salt$hash */
  passwordHash: string;
  role: Role;
  coins: number;
  stats: LifetimeStats;
  createdAt: Date;
  lastLoginAt: Date | null;
  /** IST day (YYYY-MM-DD) the daily login bonus was last given */
  lastLoginBonusDay?: string;
  /** IST day the first-game bonus was last given */
  lastGameBonusDay?: string;
}

export interface SessionDoc {
  _id: ObjectId;
  userId: ObjectId;
  /** sha256 of the bearer token; the token itself is never stored */
  tokenHash: string;
  createdAt: Date;
  /** TTL index removes the session after this */
  expiresAt: Date;
}

export interface GamePlayerDoc {
  /** null for guests */
  userId: ObjectId | null;
  name: string;
  guest: boolean;
  place: number | null;
  won: boolean;
  loser: boolean;
  kicked: boolean;
  /** stake won (+) or paid (-) */
  coinChange: number;
  /** first-game-of-the-day bonus */
  bonus: number;
  stats: PlayerStats;
}

export interface GameDoc {
  _id: ObjectId;
  roomCode: string;
  config: GameConfig;
  status: 'finished' | 'ended_early';
  startedAt: Date;
  endedAt: Date;
  durationSec: number;
  stake: number;
  /** coins collected from everyone and paid to the winner */
  pot: number;
  players: GamePlayerDoc[];
  winnerName: string | null;
  loserName: string | null;
  awards: { emoji: string; title: string; names: string[]; detail: string }[];
}

export interface AuditDoc {
  _id: ObjectId;
  action: 'coins' | 'make_admin';
  targetUserId: ObjectId;
  /** null when done with the ADMIN_API_KEY */
  byUserId: ObjectId | null;
  via: 'admin' | 'api_key';
  amount?: number;
  balanceAfter?: number;
  reason?: string;
  createdAt: Date;
}

export interface FriendDoc {
  _id: ObjectId;
  /** both user ids sorted and joined, unique per pair */
  pair: string;
  requester: ObjectId;
  recipient: ObjectId;
  status: 'pending' | 'accepted';
  createdAt: Date;
  acceptedAt?: Date;
}

export interface Collections {
  users: Collection<UserDoc>;
  sessions: Collection<SessionDoc>;
  games: Collection<GameDoc>;
  audit: Collection<AuditDoc>;
  friends: Collection<FriendDoc>;
}

/** who performed an admin action */
export interface Actor {
  userId: ObjectId | null;
  via: 'admin' | 'api_key';
}
