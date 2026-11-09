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
export const FIRST_GAME_BONUS = 500;

export interface GameConfig {
  decks: 1 | 2;
  bluffRule: BluffRule;
  stake: number;
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
}

export interface WatcherView {
  id: string;
  name: string;
  connected: boolean;
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
}

/** how one player's coins changed when a game ended */
export interface CoinResult {
  playerId: string;
  /** stake won or lost */
  change: number;
  /** first-game-of-the-day bonus, 0 if already claimed today */
  bonus: number;
  coins: number | null;
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
  players: { name: string; place: number | null; loser: boolean; guest: boolean; kicked: boolean }[];
}

export interface FriendView {
  id: string;
  username: string;
  displayName: string;
  online: boolean;
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
