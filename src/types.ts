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

export interface GameConfig {
  decks: 1 | 2;
  bluffRule: BluffRule;
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
}

export type AnnounceKind = 'play' | 'pass' | 'bluff' | 'round' | 'finish' | 'over' | 'room';

export interface Announcement {
  id: number;
  kind: AnnounceKind;
  text: string;
}
