// Shapes shared with the client. Keep in sync with bluff-frontend/src/types.ts
export const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'] as const;
export type Rank = (typeof RANKS)[number];

export const SUITS = ['S', 'H', 'D', 'C'] as const;
export type Suit = (typeof SUITS)[number];

export interface Card {
  id: string;
  rank: Rank;
  suit: Suit;
}

/** all: every card of the challenged play is turned over; one: the caller picks one card to turn over */
export type BluffRule = 'all' | 'one';

/** coins each player puts in; 0 = free game. Up to 10 lakh */
export const STAKES = [0, 50, 100, 250, 500, 1_000, 5_000, 10_000, 50_000, 100_000, 500_000, 1_000_000] as const;

/** a player may call bluff this many times in a row; playing or passing their turn resets it */
export const MAX_BLUFF_CALLS_IN_A_ROW = 2;

/** daily rewards, counted per India (IST) calendar day */
export const LOGIN_BONUS = 200;
/** daily game rewards (IST day): reaching this many finished games today pays these coins once */
export const DAILY_GAME_REWARDS: readonly { games: number; coins: number }[] = [
  { games: 1, coins: 100 },
  { games: 3, coins: 300 },
  { games: 5, coins: 500 },
  { games: 10, coins: 1_000 },
  { games: 20, coins: 2_000 },
  { games: 50, coins: 5_000 },
];

/** shorter games don't count towards the daily rewards, so quick games can't farm coins */
export const MIN_REWARD_GAME_SEC = 60;

/** most peeks a room can allow per player per game */
export const MAX_PEEKS = 3;

/** coins a caller can bet on a bluff call (never more than the room's stake) */
export const BET_STEPS = [50, 100, 250, 500, 1_000, 5_000, 10_000, 50_000, 100_000, 500_000] as const;

/** with bots at the table the stake can be at most this; bots have no coins of their own */
export const BOT_MAX_STAKE = 100;

/** which game a room plays */
export type GameKind = 'bluff' | 'crazy7';

/** Crazy 7: cards dealt to each player */
export const CRAZY7_HAND_SIZES = [5, 7] as const;
/** Crazy 7: the most cards a player may pick in one turn (the room setting goes from 1 to this) */
export const CRAZY7_MAX_PICKS = 7;
/** Crazy 7: cards the next player must pick for each 7 */
export const SEVEN_PENALTY = 2;

export interface GameConfig {
  /** Bluff (default) or Crazy 7; older apps don't send it */
  game: GameKind;
  decks: 1 | 2;
  bluffRule: BluffRule;
  stake: number;
  /** peeks per player per game (0 = off): secretly look at one card of the last play */
  peeks: number;
  /** coin games only: callers may bet coins on their bluff call */
  bets: boolean;
  /** 2 vs 2: exactly 4 players, partners sit opposite */
  teams: boolean;
  /** Crazy 7: cards dealt to each player */
  handSize: 5 | 7;
  /** Crazy 7: cards a player may pick in one turn (the first one is automatic when nothing matches) */
  maxPicks: number;
  /** Crazy 7: a 7 can be answered with another 7, passing a bigger pick on */
  stack7: boolean;
}

/** one move at a Crazy 7 table, for seat labels and animations */
export interface Crazy7Move {
  /** goes up by one with every move */
  id: number;
  kind: 'play' | 'pick' | 'penalty' | 'pass' | 'call' | 'missed' | 'shuffle';
  playerId: string | null;
  /** the card played */
  card: Card | null;
  /** cards picked */
  count: number;
}

/** the Crazy 7 part of a room view; everything here is public except the my-turn fields */
export interface Crazy7View {
  /** top card of the pile: the next card must match its suit or number */
  top: Card | null;
  /** a few cards under the top, oldest first */
  under: Card[];
  pileCount: number;
  deckCount: number;
  /** cards the player on turn must pick because of 7s (0 = none) */
  penalty: number;
  /** cards the player on turn has picked this turn */
  picks: number;
  /** my cards that can go on the pile now; empty when it isn't my turn */
  playable: string[];
  /** I may pick a card now (or take the 7 penalty) */
  canPick: boolean;
  /** I may end my turn now (only after picking) */
  canPass: boolean;
  /** I may say "last card" now */
  canCall: boolean;
  /** cards I picked this turn */
  picked: string[];
  /** players who said "last card" */
  called: string[];
  /** players who forgot: they pick 1 and miss their next turn */
  missed: string[];
  /** went down to one card without saying it; still time to say it */
  atRisk: string | null;
  last: Crazy7Move | null;
  /** goes up by one each time a turn starts, even when the same player gets it again */
  turn: number;
  /** something automatic is about to happen to the player on turn (a pick when nothing matches, a pass, a penalty) */
  auto: boolean;
  /** who put the top card down; null for the starting card */
  topBy: string | null;
}

export type Phase = 'lobby' | 'playing' | 'over';

export const REACTIONS = ['😂', '🤥', '👀', '🔥', '😱', '👏', '🤡', '😎'] as const;

export const QUICK_MESSAGES = [
  'Bluff hai! 🤥',
  'Sach bol raha hoon 😇',
  'Pakka? 🤨',
  'Jaldi chal bhai! ⏰',
  'Chehra bata raha hai, jhooth hai 👀',
  'Itne saare? Pakka jhooth 🤣',
  'Mujhe sab pata hai 🧐',
  'Main toh seedha-saadha hoon 😇',
  'Nice try 😏',
  'Ab tu gaya 😈',
  'Bhai tu toh gaya kaam se 💀',
  'Bach gaya! 😅',
  'Trust me 😉',
  'Soch le, phir mat bolna 😏',
  'Chal jhooth mat bol 🙄',
  'Sab mile hue hain kya? 🕵️',
  'Kya chaal hai! 🔥',
  'Aaj meri raat hai 😎',
  'Patte dekh ke rona aa gaya 😭',
  'Kismat kharab hai yaar 🤦',
  'Hasna mana hai 🤐',
  'Sorry yaar 🙏',
  'Bas kar bhai 😂',
  'Chai break? ☕',
  'Ek aur round! 🔁',
  'GG 🎉',
] as const;

export type ChatKind = 'reaction' | 'message';

/** index points into REACTIONS or QUICK_MESSAGES, so no free text ever goes through the server */
export interface ChatEvent {
  from: string;
  kind: ChatKind;
  index: number;
  /** 'pile': a reaction dropped on the last play (long-press the pile); otherwise it floats up the screen */
  on?: 'pile';
}

/** emoji a player throws at someone in the room; everyone sees it fly across. New ones go at the end: the index is what's sent */
export const THROWS = [
  '🌹', '💋', '👏', '🎉', '😂', '🍅', '🥚', '💣', '😡', '🪓',
  '🩴', '👊', '💩', '🎂', '🍻', '😱', '🥺', '🙏', '😝', '🤡',
] as const;

/** a thrown emoji: member ids in the room, index into THROWS */
export interface ThrowEvent {
  from: string;
  to: string;
  index: number;
}

/** amounts one gift can be, and the most a player can give away in total per IST day */
export const GIFT_STEPS = [10, 25, 50, 100] as const;
export const DAILY_GIFT_LIMIT = 100;

/** coins given between two people in the same room (member ids), so everyone sees them fly */
export interface GiftEvent {
  from: string;
  to: string;
  amount: number;
}

/** tells whoever got the coins, wherever they are */
export interface GiftReceived {
  fromName: string;
  amount: number;
}

export interface WatcherView {
  id: string;
  name: string;
  connected: boolean;
  /** for friend requests; null for guests */
  username: string | null;
  /** account level; null for guests */
  level: number | null;
  /** chose to watch, rather than waiting for a free seat */
  byChoice: boolean;
}

/** sent only to watchers: every hand and the real cards of the last play */
export interface WatchView {
  hands: Record<string, Card[]>;
  lastPlayCards: Card[] | null;
}

export interface Award {
  emoji: string;
  title: string;
  playerIds: string[];
  detail: string;
}

export interface PublicPlayer {
  id: string;
  name: string;
  cardCount: number;
  connected: boolean;
  place: number | null;
  /** logged in (can play staked games) */
  registered: boolean;
  /** coin balance as last seen by the server; null for guests */
  coins: number | null;
  /** for friend requests; null for guests */
  username: string | null;
  /** account level; null for guests */
  level: number | null;
  /** a bot the server plays; never has an account */
  bot: boolean;
}

/** how one player's coins changed when a game ended */
export interface CoinResult {
  playerId: string;
  /** stake won or lost */
  change: number;
  /** daily games reward this game reached, 0 if none */
  bonus: number;
  coins: number | null;
  level: number | null;
  /** games counted today including this one; null for guests */
  gamesToday: number | null;
  /** this game counted towards today's games (finished, long enough, not removed) */
  counted: boolean;
  /** coins won (+) or lost (-) on bluff-call bets */
  bets: number;
  /** XP this game earned; 0 for guests, stopped games and removed players */
  xp: number;
}

export interface LastPlayView {
  id: string;
  playerId: string;
  count: number;
  rank: Rank;
}

export interface RevealView {
  playId: string;
  callerId: string;
  playerId: string;
  rank: Rank;
  /** null for cards that stayed face down (rule "one") */
  cards: (Card | null)[];
  pickedIndex: number | null;
  bluff: boolean;
  loserId: string;
  pileCount: number;
  /** coins the caller bet on this call; the loser of the call pays it when the game ends */
  bet: number;
}

export interface RoomView {
  code: string;
  meId: string;
  hostId: string;
  phase: Phase;
  config: GameConfig;
  players: PublicPlayer[];
  /** people in the room without a seat in the current game */
  watchers: WatcherView[];
  turnId: string | null;
  roundRank: Rank | null;
  pileCount: number;
  lastPlay: LastPlayView | null;
  passedIds: string[];
  reveal: RevealView | null;
  hand: Card[];
  loserId: string | null;
  /** everyone who lost: the last player with cards, or all but 1st when the host ended the game */
  loserIds: string[];
  /** the host ended the game once someone had won */
  endedEarly: boolean;
  /** filled once the game is over */
  awards: Award[];
  /** null for seated players, so they never receive anyone else's cards */
  watch: WatchView | null;
  /** coin changes once the finished game is saved; null until then or for free guest games */
  coinResults: CoinResult[] | null;
  /** game ended because too few players were left (after kicks); no coins moved */
  stopped: boolean;
  /** how many more times I can call bluff before I must play or pass */
  bluffCallsLeft: number;
  /** peeks I have left this game */
  peeksLeft: number;
  /** most I can bet on a bluff call right now (0 when bets are off) */
  betLimit: number;
  /** 2v2 partners by member id (in the lobby: who would pair up), or null */
  teams: [string[], string[]] | null;
  /** who won: 1st place, or both partners of the winning team */
  winnerIds: string[];
  /** 2v2 lobby: member id in each of the 4 slots (🔵 0 & 2, 🟠 1 & 3), null when empty */
  slots: (string | null)[] | null;
  /** 2v2 lobby: open requests to swap places */
  swapAsks: { fromId: string; toId: string }[];
  /** 2v2 game: my partner's cards (only ever sent to their partner) */
  partnerHand: Card[] | null;
  /** host only: people asking to watch the game in progress */
  watchRequests: { id: string; name: string; registered: boolean; level: number | null }[];
  /** players who used Leave game in this game: they lost and still pay the stake */
  leftPlayers: { id: string; name: string; registered: boolean; level: number | null }[];
  /** the Crazy 7 table while a Crazy 7 game is on, else null */
  crazy7: Crazy7View | null;
}

export type Role = 'user' | 'admin';

/** lifetime numbers stored on an account */
export interface LifetimeStats {
  gamesPlayed: number;
  wins: number;
  losses: number;
  bluffs: number;
  bluffsCaught: number;
  goodCalls: number;
  wrongCalls: number;
  cardsPickedUp: number;
  /** plays made (counted since bots came; older games aren't in it) */
  plays: number;
  /** plays by others this player could have called bluff on */
  chances: number;
  /** of gamesPlayed, how many were Crazy 7 (Bluff bots read only Bluff games) */
  crazy7Games: number;
}

/** XP from each finished game: playing it, winning, catching a liar, and each bluff nobody caught */
export const XP_RULES = { game: 20, win: 50, goodCall: 5, cleanBluff: 3 } as const;

export function xpOf(s: LifetimeStats): number {
  return (
    s.gamesPlayed * XP_RULES.game +
    s.wins * XP_RULES.win +
    s.goodCalls * XP_RULES.goodCall +
    Math.max(0, s.bluffs - s.bluffsCaught) * XP_RULES.cleanBluff
  );
}

/** XP needed to reach a level: each level needs 100 more than the last (0, 100, 300, 600, 1000…) */
export const xpForLevel = (level: number) => 50 * (level - 1) * level;

export function levelOf(s: LifetimeStats): number {
  const xp = xpOf(s);
  let level = 1;
  while (xp >= xpForLevel(level + 1)) level++;
  return level;
}

/** account data the API returns; never includes the password hash */
export interface PublicUser {
  id: string;
  username: string;
  displayName: string;
  role: Role;
  coins: number;
  stats: LifetimeStats;
  createdAt: string;
  /** coins this player can still give friends today */
  giftLeft: number;
  /** games whose practice tutorial this account has finished or skipped */
  tutorials: GameKind[];
}

export interface AuthResponse {
  token: string;
  user: PublicUser;
  /** daily login bonus just added (0 if already claimed today) */
  bonus: number;
}

export interface MyGameStats {
  bluffs: number;
  caught: number;
  goodCalls: number;
  wrongCalls: number;
  pickedUp: number;
}

export interface GameSummary {
  id: string;
  roomCode: string;
  endedAt: string;
  durationSec: number;
  status: 'finished' | 'ended_early';
  /** older games are Bluff */
  game: GameKind;
  decks: 1 | 2;
  stake: number;
  place: number | null;
  won: boolean;
  lost: boolean;
  kicked: boolean;
  /** stake won (+) or lost (-) */
  coinChange: number;
  bonus: number;
  my: MyGameStats | null;
  myAwards: { emoji: string; title: string }[];
  players: { name: string; place: number | null; loser: boolean; guest: boolean; kicked: boolean; bot: boolean }[];
}

/** extra numbers for the player's own profile page */
export interface ProfileOverview {
  /** place by coins among all accounts, 1 = most coins */
  coinRank: number;
  players: number;
  friends: number;
  /** today's daily login reward already received */
  loginBonusToday: boolean;
  /** games counted towards today's game rewards */
  gamesToday: number;
}

/** what an admin sees about an account */
export interface AdminUser extends PublicUser {
  lastLoginAt: string | null;
  blocked: boolean;
}

export type AuditAction = 'coins' | 'make_admin' | 'update' | 'password' | 'gift' | 'settings';

/** sent on every connection (and to a guest who is turned away), so the app never depends on one HTTP check */
export interface ServerInfo {
  /** the server has accounts (a database) */
  accounts: boolean;
  /** guests may create and join rooms */
  guestsAllowed: boolean;
  /** friend invites reach offline phones as notifications (set up on the server and switched on by an admin) */
  pushInvites: boolean;
}

/** switches an admin can flip for the whole app */
export interface AppSettings {
  /** false: everyone must log in to create or join a room */
  guestsAllowed: boolean;
  /** friend invites go to offline friends as phone notifications; an admin can switch it off */
  pushInvites: boolean;
  /** the admin who last changed it, and when; null if never changed */
  updatedBy: string | null;
  updatedAt: string | null;
}

/** one admin change to an account */
export interface AuditEntry {
  id: string;
  action: AuditAction;
  /** the admin's display name; null when done with the admin key */
  by: string | null;
  amount?: number;
  balanceAfter?: number;
  reason?: string;
  /** what changed, e.g. "Name: Ravi → Ravi K" */
  detail?: string;
  createdAt: string;
}

/** admin changes per page on a user's admin page */
export const HISTORY_PAGE_SIZE = 10;

/** everything the admin page for one user shows */
export interface AdminUserDetail {
  user: AdminUser;
  games: GameSummary[];
  /** first page of admin changes, newest first */
  history: AuditEntry[];
  /** all admin changes, for the page count */
  historyTotal: number;
  friends: number;
  /** devices currently logged in */
  activeSessions: number;
}

export interface FriendView {
  id: string;
  username: string;
  displayName: string;
  online: boolean;
  level: number;
  /** already in a room: 'here' is the room I'm in; such friends can't be invited */
  inRoom: 'here' | 'other' | null;
  /** their room's stage when it's another room: lobby or over (join or watch), playing (ask the host to watch) */
  roomPhase: Phase | null;
}

/** a player found by name in the Friends search */
export interface PlayerSearchResult {
  id: string;
  username: string;
  displayName: string;
  level: number;
  /** null unless they're already a friend */
  online: boolean | null;
  /** how they relate to me */
  status: 'friend' | 'sent' | 'incoming' | 'none';
}

/** what anyone logged in can see about a player: name, level and game record, nothing private */
export interface PublicProfile {
  id: string;
  username: string;
  displayName: string;
  level: number;
  joinedAt: string;
  /** null unless they're a friend (or me) */
  online: boolean | null;
  stats: LifetimeStats;
  /** how they relate to me */
  status: 'me' | 'friend' | 'sent' | 'incoming' | 'none';
}

export interface FriendsResponse {
  friends: FriendView[];
  /** requests waiting for me to accept */
  incoming: FriendView[];
  /** requests I sent */
  outgoing: FriendView[];
}

/** a friend asking you to join their room */
export interface InviteEvent {
  fromId: string;
  fromName: string;
  code: string;
}

export type AnnounceKind ='play' | 'pass' | 'bluff' | 'round' | 'finish' | 'over' | 'room';

export interface Announcement {
  id: number;
  kind: AnnounceKind;
  text: string;
}
