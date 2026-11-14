import type { Collection, ObjectId } from 'mongodb';
import type { PlayerStats } from '../models.js';
import type { AuditAction, GameConfig, GameKind, LifetimeStats, Role } from '../types.js';

/** database and collection names, all overridable from env */
export interface DbNames {
  db: string;
  users: string;
  sessions: string;
  games: string;
  audit: string;
  friends: string;
  settings: string;
  /** phones that get friend-invite notifications; push_subscriptions by default */
  push?: string;
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
  /** IST day that gamesToday counts */
  gamesTodayDay?: string;
  /** finished games counted towards the daily game rewards on gamesTodayDay */
  gamesToday?: number;
  /** set by an admin: no login, existing sessions are revoked */
  blocked?: boolean;
  /** IST day that giftGiven counts */
  giftDay?: string;
  /** coins given to friends on giftDay */
  giftGiven?: number;
  /** games whose practice tutorial they finished or skipped */
  tutorials?: GameKind[];
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
  /** null for guests and bots */
  userId: ObjectId | null;
  name: string;
  guest: boolean;
  /** a bot the server played (older games don't have it) */
  bot?: boolean;
  place: number | null;
  won: boolean;
  loser: boolean;
  kicked: boolean;
  /** stake won (+) or paid (-) */
  coinChange: number;
  /** daily games reward this game reached */
  bonus: number;
  /** coins won (+) or lost (-) on bluff-call bets */
  betChange?: number;
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
  action: AuditAction;
  targetUserId: ObjectId;
  /** null when done with the ADMIN_API_KEY */
  byUserId: ObjectId | null;
  /** player: a gift between friends */
  via: 'admin' | 'api_key' | 'player';
  amount?: number;
  balanceAfter?: number;
  reason?: string;
  /** what changed, e.g. "Name: Ravi → Ravi K" */
  detail?: string;
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

/** one phone (browser) that gets friend-invite notifications for an account */
export interface PushSubscriptionDoc {
  _id: ObjectId;
  userId: ObjectId;
  /** where the browser's push service takes messages for this phone; unique */
  endpoint: string;
  /** the browser's keys for encrypting messages to it */
  p256dh: string;
  auth: string;
  createdAt: Date;
  updatedAt: Date;
  lastSentAt?: Date;
}

/** the one app-wide settings document */
export interface SettingsDoc {
  _id: 'app';
  guestsAllowed: boolean;
  /** missing in older documents: on */
  pushInvites?: boolean;
  updatedBy: ObjectId | null;
  updatedAt: Date;
}

export interface Collections {
  users: Collection<UserDoc>;
  sessions: Collection<SessionDoc>;
  games: Collection<GameDoc>;
  audit: Collection<AuditDoc>;
  friends: Collection<FriendDoc>;
  settings: Collection<SettingsDoc>;
  push: Collection<PushSubscriptionDoc>;
}

/** who performed an admin action */
export interface Actor {
  userId: ObjectId | null;
  via: 'admin' | 'api_key';
}
