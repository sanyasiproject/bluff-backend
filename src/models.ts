import type { Award, Card, CoinResult, GameConfig, GameReplay, InviteEvent, LifetimeStats, PlayReveal, Rank, RangCard, RangColor, RankDivisionId, SazaBadge, ShopLookKind, Suit } from './types.js';

/** one of a player's plays this game with the true cards (server only); open: it never stood or was called (still waiting, or cut off by a walk-out or End game) */
export interface LoggedPlay extends PlayReveal {
  open: boolean;
  /** hid at least one card that doesn't back up the claim (the Kismat card does) */
  lie: boolean;
}

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
  /** chosen avatar ("face.bg"); null for guests, bots and accounts that haven't picked one */
  avatar: string | null;
  /** card back everyone sees on this member's cards; the classic one for guests and bots */
  back: string;
  /** table theme everyone sees on this member's seat; classic green for guests and bots */
  table: string;
  /** how they really play Bluff, from their past games; read at join for the bots, never sent to anyone. Null for guests and bots */
  habits: Habits | null;
  /** lobby: said they're ready to start (the host starts once every other person is ready) */
  ready: boolean;
  /** their app has the Ready button; people on older apps always count as ready */
  hasReady: boolean;
  /** their app knows the Bluff twists (Kismat card, Seedhi); a twist game waits for older apps to update */
  hasTwists: boolean;
  /** their app has Rang and Crazy 7 power cards; such a game waits for older apps to update */
  hasRang: boolean;
  /** Bluff's saza badge in this room: the last player wears it until they win a game here */
  saza: SazaBadge | null;
  /** shop looks they rent, each with the time it runs out (read at join and when they buy or switch) */
  shop: ShopWear;
  /** this season's division and points, read at join and updated after each ranked game; null for guests and bots */
  rank: RankBadge | null;
  /** games won in a row, read at join and updated after each game; 0 for guests and bots */
  streak: number;
}

/** a division and rank points, as shown on seats and lobby rows */
export interface RankBadge {
  division: RankDivisionId;
  points: number;
}

/** shop looks worn, each with when its rental runs out (ms); null: none of that kind */
export type ShopWear = Record<ShopLookKind, { id: string; until: number } | null>;

/**
 * How a player really plays Bluff, counted from every play the server saw (the true cards, caught or not).
 * Saved on the account for the bots; never sent to any app. Never includes a game that is still running.
 */
export interface Habits {
  /** plays that opened a round, how many hid a fake, and how many claimed a rank they held none of */
  openPlays: number;
  openLies: number;
  openNone: number;
  /** plays following a round while holding its rank, and how many hid fakes */
  followPlays: number;
  followLies: number;
  /** turns following a round while holding none of its rank: fakes pushed, or passed */
  pushes: number;
  passNone: number;
  /** passes while holding the round's rank */
  passHeld: number;
  /** all lies, and the fake cards in them */
  lies: number;
  lieCards: number;
  /** plays that emptied their hand, and how many of those were lies */
  finishPlays: number;
  finishLies: number;
  /** turns with 3 cards or fewer that couldn't be finished honestly, and how many they faked the rest to finish anyway */
  endTurns: number;
  endFakes: number;
  /** cards of mixed plays (real and fake together) by where they sat in tap order, and how many of them were fake */
  slotFirst: number;
  fakeFirst: number;
  slotMid: number;
  fakeMid: number;
  slotLast: number;
  fakeLast: number;
  /** honest plays while holding 2+ of the rank, and how many of those kept some back */
  heldHonest: number;
  heldKept: number;
  /** lies while holding 1+ of the rank, and how many of those kept real ones back (fake now, the real ones later) */
  heldLies: number;
  liesKept: number;
  /** plays that took the round's claims past the copies in the game (so one claim was a lie), and how many of those were lies */
  overPlays: number;
  overLies: number;
  /** bots' plays they had their chance to call (the play stood, or they called it; not a bot's last cards) and how many they called; the same for the bot plays that hid a fake */
  botSeen: number;
  botCalls: number;
  botLieSeen: number;
  botLieCalls: number;
}

/** how a player looks to others at the table */
export interface PlayerLook {
  avatar: string | null;
  back: string;
  table: string;
  /** missing: leave the shop looks as they are */
  shop?: ShopWear;
}

/** the account behind a logged-in member */
export interface MemberAccount {
  userId: string;
  username: string;
  coins: number | null;
  level: number | null;
  stats: LifetimeStats | null;
  avatar: string | null;
  back: string;
  table: string;
  habits: Habits | null;
  /** missing: none (tests and older callers) */
  shop?: ShopWear;
  /** missing: Bronze 0 for a logged-in player (tests and older callers) */
  rank?: RankBadge | null;
  /** games won in a row; missing: 0 */
  streak?: number;
}

/** someone asking to watch a game in progress; the host lets them in or not */
export interface WatchRequest {
  id: string;
  name: string;
  account: MemberAccount | null;
  socketId: string;
  /** the account, or a guest's network and name, for the wait before asking again */
  key: string;
  /** asked through a friend (Friends, Online now): that friend's member id answers; missing: the host does */
  askedOf?: string;
  /** they asked to watch rather than take a seat */
  watch?: boolean;
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
  /** their secret mission card this game and whether they did it; null for bots */
  secret: { id: string; done: boolean } | null;
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
  /** Bluff: how many times each player caught another lying, by member id */
  catches: { by: string; of: string; n: number }[];
  /** step-by-step replay; null when nothing was recorded */
  replay?: GameReplay | null;
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
  /** a friend invite to an offline friend's phones; resolves with how many took it (0: none turned on, or switched off) */
  pushInvite?: (toUserId: string, invite: InviteEvent) => Promise<number>;
  /** invite notifications are set up and an admin has them on */
  pushInvitesOn?: () => boolean;
  /** the app opened or closed on an account (its first connection came or its last went): saved as their last online time; resolves with the one before */
  markSeen?: (userId: string) => Promise<Date | null>;
  /** ids of an account's friends (accepted requests only) */
  friendIdsOf?: (userId: string) => Promise<string[]>;
  /** moves coins to a friend within the daily gift limit; throws GameError with a reason players can read */
  giftCoins?: (fromUserId: string, toUserId: string, amount: number) => Promise<GiftResult>;
}

/** what a room needs to know about an account */
export interface AccountInfo {
  coins: number;
  level: number;
  stats: LifetimeStats;
  avatar: string | null;
  back: string;
  table: string;
  /** null until they've played a Bluff game with an account */
  habits: Habits | null;
  shop: ShopWear;
  rank: RankBadge;
  /** games won in a row */
  streak: number;
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
  /** Rang: wilds (and +4s) played */
  wilds?: number;
  /** Crazy 7: times they forgot to say last card */
  missedCalls?: number;
  /** Crazy 7: cards picked (kept apart from Bluff's pickedUp, which feeds the Collector achievement) */
  picks?: number;
  /** Crazy 7: 7s played to answer a waiting 7 */
  stacks?: number;
  /** Crazy 7: "last card" said in time */
  lastCalls?: number;
  /** Bluff: how they really played this game, added to the account's habits when the game is saved */
  habits?: Habits;
}

/** what a room reads from whichever game is on (Bluff's Game, Crazy7Game or RangGame); C is that game's card */
export interface TableGame<C extends { id: string } = Card> {
  readonly order: string[];
  readonly config: GameConfig;
  readonly hands: Map<string, C[]>;
  readonly stats: Map<string, PlayerStats>;
  readonly kicked: Set<string>;
  readonly forfeited: Set<string>;
  readonly teams: [string[], string[]] | null;
  readonly bets: BetResult[];
  readonly endedEarly: boolean;
  pile: C[];
  places: string[];
  turnId: string | null;
  over: boolean;
  aborted: boolean;
  closed: boolean;
  hand(id: string): C[];
  /** finishing place; once over, everyone still in is ranked by fewest cards left */
  placeOf(id: string): number | null;
  /** points of the cards a player still holds, for the final ranking (lower is better) */
  handValueOf(id: string): number;
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
  /** 🔒 Card Shield: can't be called or peeked at */
  shielded?: boolean;
}

export type GameEvent =
  | { kind: 'play'; playerId: string; count: number; rank: Rank; shielded?: boolean }
  | { kind: 'pass'; playerId: string }
  | { kind: 'bluff'; callerId: string; playerId: string; bluff: boolean; loserId: string; pileCount: number; bet: number }
  | { kind: 'newRound'; starterId: string }
  | { kind: 'roundEnd'; starterId: string; discarded: number }
  | { kind: 'finish'; playerId: string; place: number }
  | { kind: 'gameOver'; loserId: string | null }
  // Crazy 7
  /** power cards: wish (the suit named with a J), skipped (by an 8, or an A with 2 players), reversed (by an A) */
  | { kind: 'c7play'; playerId: string; card: Card; penalty: number; wish?: Suit | null; skipped?: string | null; reversed?: boolean }
  /** forced: picked automatically because nothing matched top */
  | { kind: 'c7pick'; playerId: string; count: number; forced: boolean; top: Card | null }
  /** missed: forgot last card; forced: had no 7 to answer with */
  | { kind: 'c7penalty'; playerId: string; count: number; missed: boolean; forced: boolean }
  | { kind: 'c7pass'; playerId: string; auto: boolean }
  | { kind: 'c7call'; playerId: string }
  | { kind: 'c7missed'; playerId: string }
  | { kind: 'c7shuffle'; count: number }
  // Rang: color is the colour named with a wild; skipped by a Skip (or Reverse with 2 players); targetId swapped hands with a 7; rotated by a 0
  // doubles: cards holds every card put down (card is the last, now on top); forced: played by Force play right after the pick
  | { kind: 'rgplay'; playerId: string; card: RangCard; color: RangColor | null; penalty: number; skipped?: string | null; reversed?: boolean; targetId?: string | null; rotated?: boolean; cards?: RangCard[]; forced?: boolean }
  | { kind: 'rgpick'; playerId: string; count: number; forced: boolean }
  | { kind: 'rgpenalty'; playerId: string; count: number; missed: boolean; forced: boolean }
  | { kind: 'rgpass'; playerId: string; auto: boolean }
  | { kind: 'rgcall'; playerId: string }
  | { kind: 'rgmissed'; playerId: string }
  | { kind: 'rgshuffle'; count: number }
  /** the hit player challenged a +4: guilty (played while holding the colour) means its player picks; else the challenger picks */
  | { kind: 'rgchallenge'; playerId: string; targetId: string; guilty: boolean; count: number };
