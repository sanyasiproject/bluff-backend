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

export interface Collections {
  users: Collection<UserDoc>;
  sessions: Collection<SessionDoc>;
  games: Collection<GameDoc>;
  audit: Collection<AuditDoc>;
}

/** who performed an admin action */
export interface Actor {
  userId: ObjectId | null;
  via: 'admin' | 'api_key';
}
