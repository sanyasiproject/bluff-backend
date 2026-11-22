import type { Collection, ObjectId } from 'mongodb';
import type { Habits, PlayerStats } from '../models.js';
import type { AuditAction, GameConfig, GameKind, GameReplay, LeagueStats, LifetimeStats, Role, SeasonResult, ShopLookKind } from '../types.js';

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
  /** one document per ranked season; ranked_seasons by default */
  seasons?: string;
  /** private messages between friends; messages by default */
  messages?: string;
  /** running head-to-head totals per pair of accounts; rival_tallies by default */
  rivals?: string;
}

export interface UserDoc {
  _id: ObjectId;
  /** lowercase, unique */
  username: string;
  displayName: string;
  /** player search: the display name and each of its words, lower case (set with the name; older accounts get it at startup) */
  nameWords?: string[];
  /** scrypt$N$r$p$salt$hash */
  passwordHash: string;
  role: Role;
  coins: number;
  stats: LifetimeStats;
  createdAt: Date;
  lastLoginAt: Date | null;
  /** when the app was last open (a connection came or the last one went); friends see it while they're offline */
  lastSeenAt?: Date;
  /** IST day (YYYY-MM-DD) the daily login bonus was last given */
  lastLoginBonusDay?: string;
  /** days in a row the daily login bonus was given, ending on lastLoginBonusDay (login streak) */
  loginStreak?: number;
  /** IST day of the last daily spin */
  lastSpinDay?: string;
  /** finished games won in a row (any game); a finished game not won sets it back to 0 */
  winStreak?: number;
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
  /** chosen avatar, "face.bg" */
  avatar?: string;
  /** chosen card back, a CARD_BACKS id */
  cardBack?: string;
  /** chosen table theme, a TABLE_THEMES id */
  tableTheme?: string;
  /** how they really play Bluff, summed over their saved games; only the server and its bots read it */
  habits?: Partial<Habits>;
  /** today's and this week's missions (services/missions.ts); missing until first read or counted */
  missions?: MissionsDoc;
  /** this week's friends league counters, and last week's (services/league.ts) */
  league?: LeagueDoc;
  /** left off friends' league boards */
  leagueHidden?: boolean;
  /** when the player last changed their own display name; the next change waits NAME_CHANGE_DAYS (admin renames don't count) */
  nameChangedAt?: Date;
  /** ranked standing for the season it was earned in (services/ranked.ts) */
  ranked?: RankedDoc;
  /** earlier seasons played, oldest first; added when a standing moves into a new season */
  rankHistory?: SeasonResult[];
  /** coin shop rentals and the looks worn from them (services/shop.ts) */
  shop?: ShopDoc;
  /** season pass progress for one ranked season (services/seasonPass.ts); another season counts as none */
  pass?: PassDoc;
}

/** an account's season pass for one ranked season */
export interface PassDoc {
  season: number;
  /** pass XP earned this season */
  xp: number;
  /** tiers claimed, each at most once */
  claimed: number[];
}

/** an account's shop rentals; every one runs out */
export interface ShopDoc {
  /** goes up on every write, so a buy never undoes another write */
  rev: number;
  rentals: { id: string; until: Date }[];
  /** the rental shown for each look kind; ignored once that rental runs out */
  wearing: Partial<Record<ShopLookKind, string>>;
  /** Rank Shields held (older documents: none) */
  shields?: number;
}

/** one IST week of league counters */
export interface LeagueWeekDoc extends LeagueStats {
  /** the IST Monday the week started */
  week: string;
}

/** this week's league counters, with last week's kept for its final board */
export interface LeagueDoc extends LeagueWeekDoc {
  prev?: LeagueWeekDoc | null;
}

/** a player's hidden skill and visible rank points for one season */
export interface RankedDoc {
  season: number;
  /** skill estimate and its uncertainty (src/rating.ts) */
  mu: number;
  sigma: number;
  points: number;
  /** the start of the division shown (older documents: the best division reached); points may go RANK_PROTECTION below it before it drops */
  floor: number;
  games: number;
  wins: number;
  /** IST day that today counts, and the points change so far that day */
  day: string;
  today: number;
  /** losses the floor or the daily cap held off; later gains pay them back first (older documents: 0) */
  debt?: number;
}

/** one of an account's current missions */
export interface MissionDoc {
  /** a MISSIONS id */
  id: string;
  /** counted so far, at most the goal */
  progress: number;
  /** reached the goal; its coins and XP were paid in that same write */
  done: boolean;
}

/** an account's daily and weekly sets; a set from an earlier IST day or week is replaced when next read or counted */
export interface MissionsDoc {
  /** goes up by one on every write; each write checks it, so two writes can't overwrite each other or pay twice */
  rev: number;
  /** IST day (YYYY-MM-DD) of the daily set */
  day: string;
  daily: MissionDoc[];
  /** IST day of the Monday that starts the weekly set */
  week: string;
  weekly: MissionDoc[];
  /** IST day the free swap was last used */
  swapDay?: string;
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

/** who caught whom lying in a saved game, between logged-in players */
export interface CatchDoc {
  by: ObjectId;
  of: ObjectId;
  n: number;
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
  /** who caught whom lying, between logged-in players (games saved since rivals came in) */
  catches?: CatchDoc[];
  /** already added to rival_tallies (set when saved, or by the one-time backfill) */
  rivalsCounted?: boolean;
  /** step-by-step replay (games saved since replays came in) */
  replay?: GameReplay;
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
  /** the ranked season now on; missing in older documents: 1 */
  rankedSeason?: number;
  /** when the season now on started; set at first load for older documents */
  rankedSeasonStartedAt?: Date;
  /** when the next season starts, once an admin asked for it; null or missing otherwise */
  nextSeasonAt?: Date | null;
  /** every older game has been added to rival_tallies */
  rivalsBackfilled?: boolean;
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
  seasons: Collection<SeasonDoc>;
  messages: Collection<MessageDoc>;
  rivals: Collection<RivalTallyDoc>;
}

/** one private message between two friends; the newest DM_KEEP per pair are kept */
export interface MessageDoc {
  _id: ObjectId;
  /** both user ids sorted and joined, as in FriendDoc */
  pair: string;
  from: ObjectId;
  to: ObjectId;
  text: string;
  at: Date;
  read: boolean;
}

/** one ranked season: when it starts and ends, and who asked for it */
export interface SeasonDoc {
  _id: number;
  startsAt: Date;
  /** set when the next season starts */
  endsAt: Date | null;
  /** the admin who asked for it; null for the first season */
  scheduledBy: ObjectId | null;
  scheduledAt: Date;
}

/** who performed an admin action */
export interface Actor {
  userId: ObjectId | null;
  via: 'admin' | 'api_key';
}

/** one pair of accounts' games together (finished, a minute or more, both seated as people); a is the lower id */
export interface RivalTallyDoc {
  /** both ids sorted and joined, like a friendship's pair */
  _id: string;
  a: ObjectId;
  b: ObjectId;
  games: number;
  aAhead: number;
  bAhead: number;
  /** times a caught b lying, and b caught a */
  aCaught: number;
  bCaught: number;
}
