// Shapes shared with the client. Keep in sync with bluff-frontend/src/types.ts
export const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'] as const;
export type Rank = (typeof RANKS)[number];

/** a card backs up a claim when it is the claimed rank, or the game's Kismat rank (wild) */
export const backsClaim = (card: { rank: Rank }, claim: Rank, kismat: Rank | null): boolean => card.rank === claim || (kismat !== null && card.rank === kismat);

/** Seedhi: after a claim, the next may be one rank below, the same, or one above (A and K wrap round) */
export function seedhiClaims(last: Rank): Rank[] {
  const i = RANKS.indexOf(last);
  return [RANKS[(i + RANKS.length - 1) % RANKS.length], last, RANKS[(i + 1) % RANKS.length]];
}

/** ranks the next play may claim: any to open a round; then the round's rank, or with Seedhi the last claim's neighbours */
export function claimsAllowed(roundRank: Rank | null, seedhi: boolean): readonly Rank[] {
  if (roundRank === null) return RANKS;
  return seedhi ? seedhiClaims(roundRank) : [roundRank];
}

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

/** which game a room plays */
export type GameKind = 'bluff' | 'crazy7';

/** how well Bluff bots play; the host picks it in the lobby (Crazy 7 bots always play their best) */
export const BOT_LEVELS = ['normal', 'hard', 'expert'] as const;
export type BotLevel = (typeof BOT_LEVELS)[number];

export const BOT_LEVEL_NAMES: Record<BotLevel, string> = { normal: 'Normal', hard: 'Hard', expert: 'Expert' };

/** with bots at the table the stake can be at most this, by bot level (bots have no coins of their own): Normal bots play only free games */
export const BOT_STAKE_CAPS: Record<BotLevel, number> = { normal: 0, hard: 100, expert: 1_000 };

/** the bot level that sets a table's stake cap: Crazy 7 bots always play their best, so they count as expert */
export const stakeLevelOf = (config: { game?: GameKind; botLevel?: BotLevel }): BotLevel =>
  config.game === 'crazy7' ? 'expert' : (config.botLevel ?? 'expert');

/** the most a table with bots may stake */
export const botStakeCap = (config: { game?: GameKind; botLevel?: BotLevel }): number => BOT_STAKE_CAPS[stakeLevelOf(config)] ?? BOT_STAKE_CAPS.expert;

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
  /** Bluff: how well the bots play (older apps don't send it: expert) */
  botLevel: BotLevel;
  /** Bluff: the last player wears a silly badge until they win a game in this room (older apps don't send it: off) */
  saza: boolean;
  /** Bluff: no lie reveal when the game ends (older apps don't send it: off, so the lies are shown) */
  secretLies: boolean;
  /** Bluff: a rated table, logged-in people only and no bots (older apps don't send it: off) */
  ranked: boolean;
  /** both games: logged-in people may send voice notes to the table (older apps don't send it: on) */
  voice: boolean;
  /** Bluff: a random rank is drawn at the deal and its cards are wild, backing up any claim (older apps don't send it: off) */
  kismat: boolean;
  /** Bluff: after the opener each claim is the same rank, one below or one above the last claim (older apps don't send it: off) */
  seedhi: boolean;
}

/** one lie nobody caught, turned face-up when the game ends */
export interface LieReveal {
  playerId: string;
  /** what they said: as many of this rank as there are cards */
  rank: Rank;
  /** what they really put down, in tap order */
  cards: Card[];
  /** someone called it, but the card turned over was real */
  survivedCall: boolean;
}

/** one play in the game-over reveal: what was said and the real cards */
export interface PlayReveal {
  rank: Rank;
  /** in tap order */
  cards: Card[];
  /** someone called it */
  called: boolean;
  /** the call turned over a fake */
  caught: boolean;
}

/** game over with the lie reveal on: every play one player made, in order, and the cards they still held */
export interface PlayerPlays {
  plays: PlayReveal[];
  hand: Card[];
}

/** Bluff's lie reveal at game over: the boldest lies that got away, and how much each player lied */
export interface LieRecap {
  /** the boldest uncaught lies, most fake cards first (a few at most) */
  lies: LieReveal[];
  /** every lie that got away, including those not listed */
  uncaught: number;
  /** each player's name, plays, lies and lies caught this game, in seat order (named even after leaving the room) */
  players: { playerId: string; name: string; plays: number; lies: number; caught: number }[];
}

/** Saza for the loser: the badges the winner picks from (the loser gets one at random first) */
export const SAZA_BADGES = [
  { id: 'joker', name: 'Joker', emoji: '🤡' },
  { id: 'murga', name: 'Murga', emoji: '🐔' },
  { id: 'kachua', name: 'Kachua', emoji: '🐢' },
  { id: 'aloo', name: 'Aloo', emoji: '🥔' },
  { id: 'bandar', name: 'Bandar', emoji: '🐒' },
  { id: 'mirchi', name: 'Mirchi', emoji: '🌶️' },
] as const;

export type SazaBadge = (typeof SAZA_BADGES)[number]['id'];

/** the catalog entry for a saza id, or null */
export const sazaOf = (id: string | null | undefined) => SAZA_BADGES.find((b) => b.id === id) ?? null;

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

/** a voice note: the longest clip, the most bytes one may be, and how long a player waits before the next one */
export const VOICE_MAX_MS = 7_000;
export const VOICE_MAX_BYTES = 90 * 1024;
export const VOICE_GAP_MS = 10_000;
/** audio formats a voice note may come in (the part before any ";codecs=") */
export const VOICE_TYPES = ['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/aac', 'audio/mpeg'] as const;

/** a voice note passed on to everyone else in the room as it comes in; the server never keeps it */
export interface VoiceEvent {
  /** member id of the sender */
  from: string;
  audio: ArrayBuffer;
  /** the recording's type, e.g. "audio/webm;codecs=opus" */
  mime: string;
  /** length as the sender's phone measured it */
  ms: number;
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

/** table themes: the felt a player plays on, and the seat box everyone else sees around their name; some unlock with level */
export const TABLE_THEMES = [
  { id: 'classic', name: 'Classic green', emoji: '🟢', level: 1 },
  { id: 'royal', name: 'Royal blue', emoji: '🔵', level: 3 },
  { id: 'wood', name: 'Wooden', emoji: '🪵', level: 6 },
  { id: 'midnight', name: 'Midnight', emoji: '🌙', level: 10 },
  { id: 'maroon', name: 'Maroon velvet', emoji: '🍷', level: 15 },
  { id: 'emerald', name: 'Emerald gold', emoji: '✨', level: 20 },
  { id: 'galaxy', name: 'Galaxy', emoji: '🌌', level: 30 },
  { id: 'saffron', name: 'Saffron', emoji: '🧡', level: 4 },
  { id: 'lagoon', name: 'Lagoon', emoji: '🏝️', level: 9 },
  { id: 'diwali', name: 'Diwali lights', emoji: '🪔', level: 24 },
  { id: 'monsoon', name: 'Monsoon', emoji: '🌧️', level: 35 },
  { id: 'champion', name: 'Champion', emoji: '🏆', level: 50 },
] as const;

/** the table of guests, bots and players who haven't picked one */
export const DEFAULT_TABLE_THEME = 'classic';

/** the catalog entry for a table id, or null */
export const tableThemeOf = (id: string | null | undefined) => TABLE_THEMES.find((t) => t.id === id) ?? null;

/** card backs: everyone at the table sees a player's face-down cards in that player's back; some unlock with level */
export const CARD_BACKS = [
  { id: 'classic', name: 'Classic red', emoji: '🟥', level: 1 },
  { id: 'ocean', name: 'Ocean blue', emoji: '🌊', level: 2 },
  { id: 'paisley', name: 'Paisley', emoji: '🌼', level: 5 },
  { id: 'neon', name: 'Neon', emoji: '💡', level: 8 },
  { id: 'gold', name: 'Royal gold', emoji: '👑', level: 12 },
  { id: 'mandala', name: 'Mandala', emoji: '🪷', level: 18 },
  { id: 'diamond', name: 'Diamond', emoji: '💎', level: 25 },
  { id: 'legend', name: 'Legend', emoji: '🏆', level: 40 },
  { id: 'rangoli', name: 'Rangoli', emoji: '🎨', level: 4 },
  { id: 'peacock', name: 'Peacock', emoji: '🦚', level: 10 },
  { id: 'kite', name: 'Kite festival', emoji: '🪁', level: 15 },
  { id: 'cosmic', name: 'Cosmic', emoji: '🌠', level: 32 },
  { id: 'maharaja', name: 'Maharaja', emoji: '🐘', level: 50 },
] as const;

/** the back of guests, bots and players who haven't picked one */
export const DEFAULT_CARD_BACK = 'classic';

/** the catalog entry for a back id, or null */
export const cardBackOf = (id: string | null | undefined) => CARD_BACKS.find((b) => b.id === id) ?? null;

/** avatar faces a player can pick, shown big on a coloured background; some unlock with level. New ones go at the end */
export const AVATAR_FACES = [
  { id: 'fox', emoji: '🦊', level: 1 },
  { id: 'tiger', emoji: '🐯', level: 1 },
  { id: 'panda', emoji: '🐼', level: 1 },
  { id: 'cat', emoji: '🐱', level: 1 },
  { id: 'dog', emoji: '🐶', level: 1 },
  { id: 'monkey', emoji: '🐵', level: 1 },
  { id: 'frog', emoji: '🐸', level: 1 },
  { id: 'penguin', emoji: '🐧', level: 1 },
  { id: 'cool', emoji: '😎', level: 1 },
  { id: 'cowboy', emoji: '🤠', level: 1 },
  { id: 'robot', emoji: '🤖', level: 1 },
  { id: 'ghost', emoji: '👻', level: 1 },
  { id: 'lion', emoji: '🦁', level: 3 },
  { id: 'unicorn', emoji: '🦄', level: 3 },
  { id: 'koala', emoji: '🐨', level: 3 },
  { id: 'ninja', emoji: '🥷', level: 5 },
  { id: 'wizard', emoji: '🧙', level: 5 },
  { id: 'vampire', emoji: '🧛', level: 5 },
  { id: 'alien', emoji: '👽', level: 8 },
  { id: 'hero', emoji: '🦸', level: 8 },
  { id: 'wolf', emoji: '🐺', level: 8 },
  { id: 'dragon', emoji: '🐲', level: 12 },
  { id: 'eagle', emoji: '🦅', level: 12 },
  { id: 'joker', emoji: '🃏', level: 18 },
  { id: 'king', emoji: '🤴', level: 18 },
  { id: 'queen', emoji: '👸', level: 18 },
  { id: 'fire', emoji: '🔥', level: 25 },
  { id: 'diamond', emoji: '💎', level: 25 },
  { id: 'crown', emoji: '👑', level: 40 },
  { id: 'owl', emoji: '🦉', level: 2 },
  { id: 'octopus', emoji: '🐙', level: 4 },
  { id: 'sloth', emoji: '🦥', level: 6 },
  { id: 'peacock', emoji: '🦚', level: 10 },
  { id: 'elephant', emoji: '🐘', level: 14 },
  { id: 'shark', emoji: '🦈', level: 16 },
  { id: 'genie', emoji: '🧞', level: 22 },
  { id: 'mermaid', emoji: '🧜', level: 28 },
  { id: 'astronaut', emoji: '🧑‍🚀', level: 32 },
  { id: 'trex', emoji: '🦖', level: 45 },
] as const;

/** character avatars: girls and boys, drawn in the app (lib/characters.ts); some are doing something (waving, on the phone). New ones go at the end */
export const AVATAR_CHARACTERS = [
  { id: 'aarav', kind: 'boy', level: 1 },
  { id: 'diya', kind: 'girl', level: 1 },
  { id: 'kabir', kind: 'boy', level: 1 },
  { id: 'zoya', kind: 'girl', level: 1 },
  { id: 'rohan', kind: 'boy', level: 1 },
  { id: 'meera', kind: 'girl', level: 1 },
  { id: 'ayaan', kind: 'boy', level: 1 },
  { id: 'sara', kind: 'girl', level: 1 },
  { id: 'priya', kind: 'girl', level: 1 },
  { id: 'karan', kind: 'boy', level: 1 },
  { id: 'neha', kind: 'girl', level: 1 },
  { id: 'sam', kind: 'boy', level: 1 },
  { id: 'fatima', kind: 'girl', level: 1 },
  { id: 'vikram', kind: 'boy', level: 3 },
  { id: 'anaya', kind: 'girl', level: 3 },
  { id: 'riya', kind: 'girl', level: 3 },
  { id: 'aman', kind: 'boy', level: 3 },
  { id: 'arjun', kind: 'boy', level: 5 },
  { id: 'tara', kind: 'girl', level: 5 },
  { id: 'pooja', kind: 'girl', level: 5 },
  { id: 'rahul', kind: 'boy', level: 5 },
  { id: 'nia', kind: 'girl', level: 8 },
  { id: 'yash', kind: 'boy', level: 8 },
  { id: 'nikhil', kind: 'boy', level: 8 },
  { id: 'anjali', kind: 'girl', level: 8 },
  { id: 'raj', kind: 'boy', level: 12 },
  { id: 'ishita', kind: 'girl', level: 12 },
  { id: 'veer', kind: 'boy', level: 12 },
  { id: 'dev', kind: 'boy', level: 15 },
  { id: 'kiara', kind: 'girl', level: 15 },
  { id: 'aditya', kind: 'boy', level: 20 },
  { id: 'myra', kind: 'girl', level: 20 },
  { id: 'ishaan', kind: 'boy', level: 30 },
  { id: 'sana', kind: 'girl', level: 30 },
] as const;

/** avatar backgrounds; the colours live in the app (lib/avatars.ts) */
export const AVATAR_BACKGROUNDS = [
  { id: 'sunset', level: 1 },
  { id: 'ocean', level: 1 },
  { id: 'forest', level: 1 },
  { id: 'grape', level: 1 },
  { id: 'candy', level: 1 },
  { id: 'fire', level: 4 },
  { id: 'ice', level: 4 },
  { id: 'night', level: 6 },
  { id: 'gold', level: 10 },
  { id: 'galaxy', level: 20 },
  { id: 'rainbow', level: 30 },
  { id: 'mint', level: 2 },
  { id: 'peacock', level: 14 },
  { id: 'aurora', level: 40 },
] as const;

/** an emoji face or a character */
export type AvatarFace = (typeof AVATAR_FACES)[number] | (typeof AVATAR_CHARACTERS)[number];

/** "<face or character>.<background>", e.g. "fox.sunset" or "priya.ocean"; parts that don't exist (an older or newer app) count as no avatar */
export function parseAvatar(value: string | null | undefined): { face: AvatarFace; bg: (typeof AVATAR_BACKGROUNDS)[number] } | null {
  if (typeof value !== 'string') return null;
  const [faceId, bgId] = value.split('.');
  const face: AvatarFace | undefined = AVATAR_FACES.find((f) => f.id === faceId) ?? AVATAR_CHARACTERS.find((c) => c.id === faceId);
  const bg = AVATAR_BACKGROUNDS.find((b) => b.id === bgId);
  return face && bg ? { face, bg } : null;
}

export interface WatcherView {
  id: string;
  name: string;
  /** chosen avatar ("face.bg"); null shows the first letter */
  avatar: string | null;
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
  /** chosen avatar ("face.bg"); null shows the first letter (guests, bots, not picked yet) */
  avatar: string | null;
  /** their card back (CARD_BACKS id): everyone sees their face-down cards in it */
  back: string;
  /** their table theme (TABLE_THEMES id): everyone sees their seat box in it */
  table: string;
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
  /** lobby: ready to start; the host, bots and people on older apps always count as ready */
  ready: boolean;
  /** the saza badge they wear in this room (Bluff's last player, until they win here); null when none or Saza is off */
  saza: SazaBadge | null;
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
  /** XP this game earned (the game itself only: missionsDone and secretXp come on top); 0 for guests, stopped games and removed players */
  xp: number;
  /** daily and weekly missions this game finished; their coins and XP are already added */
  missionsDone: { id: string; coins: number; xp: number }[];
  /** bonus XP from this game's secret mission card (0 when not done or the game didn't count) */
  secretXp: number;
  /** a rated game's rank points before and after, the division now, and what held the change back: the daily cap, the floor, or paying back losses they held off earlier; null otherwise */
  rank: { before: number; after: number; division: RankDivisionId; held: 'cap' | 'floor' | 'debt' | null } | null;
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
  /** the rank the next play follows: the round's rank, or with Seedhi the last claim; null when a round is about to open */
  roundRank: Rank | null;
  /** Bluff with the Kismat card on: this game's wild rank, shown to everyone; null otherwise */
  kismat: Rank | null;
  pileCount: number;
  /** Bluff: who played each of the top cards of the pile (up to 7, bottom to top), so they show in that player's back */
  pileTopBy: string[];
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
  /** game over with Saza on: who wears the new badge, and the winner who may still swap it; null otherwise */
  sazaPick: { loserId: string; winnerId: string } | null;
  /** a Bluff game is over: its lies, unless the host keeps them secret; null otherwise (never while the game runs) */
  lieRecap: LieRecap | null;
  /** my secret mission card this game; null for bots, watchers and in the lobby */
  secret: SecretView | null;
  /** game over: each person's secret mission card, turned over (not players the host removed), named even after leaving; empty while the game runs */
  secrets: { playerId: string; name: string; id: string; done: boolean }[];
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
  /** XP from missions and secret mission cards (older accounts: 0) */
  bonusXp: number;
}

/** XP from each finished game: playing it, winning, catching a liar, and each bluff nobody caught; missions add bonusXp */
export const XP_RULES = { game: 20, win: 50, goodCall: 5, cleanBluff: 3 } as const;

export function xpOf(s: LifetimeStats): number {
  return (
    s.gamesPlayed * XP_RULES.game +
    s.wins * XP_RULES.win +
    s.goodCalls * XP_RULES.goodCall +
    Math.max(0, s.bluffs - s.bluffsCaught) * XP_RULES.cleanBluff +
    (s.bonusXp ?? 0)
  );
}

/** what a daily or weekly mission counts, from each finished game of MIN_REWARD_GAME_SEC or more (logged in, not removed) */
export type MissionCounter =
  /** games finished, either game */
  | 'games'
  /** games won (a 2v2 team win counts) */
  | 'wins'
  /** Bluff: calls that turned over a fake */
  | 'goodCalls'
  /** Bluff: lies nobody caught */
  | 'cleanBluffs'
  /** Crazy 7 games finished */
  | 'crazy7Games'
  /** Crazy 7 games won */
  | 'crazy7Wins'
  /** Crazy 7: 7s played */
  | 'sevens'
  /** games finished with an accepted friend at the table */
  | 'friendGames'
  /** secret mission cards done */
  | 'secrets';

export type MissionPeriod = 'daily' | 'weekly';

export interface MissionDef {
  id: string;
  period: MissionPeriod;
  emoji: string;
  title: string;
  counter: MissionCounter;
  goal: number;
  coins: number;
  xp: number;
  /** needs a real friend at the table; each day's and each week's set is dealt with exactly one (a swap may change that) */
  social: boolean;
}

/** 3 missions a day and 3 a week, each set with one social mission; daily ones start again at IST midnight, weekly ones on Monday */
export const MISSIONS: readonly MissionDef[] = [
  { id: 'd-games3', period: 'daily', emoji: '🎴', title: 'Finish 3 games', counter: 'games', goal: 3, coins: 150, xp: 30, social: false },
  { id: 'd-win1', period: 'daily', emoji: '🏆', title: 'Win a game', counter: 'wins', goal: 1, coins: 200, xp: 40, social: false },
  { id: 'd-catch2', period: 'daily', emoji: '🕵️', title: 'Catch 2 liars in Bluff', counter: 'goodCalls', goal: 2, coins: 150, xp: 30, social: false },
  { id: 'd-sneak3', period: 'daily', emoji: '😎', title: 'Get 3 lies past everyone in Bluff', counter: 'cleanBluffs', goal: 3, coins: 150, xp: 30, social: false },
  { id: 'd-c7games2', period: 'daily', emoji: '7️⃣', title: 'Finish 2 games of Crazy 7', counter: 'crazy7Games', goal: 2, coins: 150, xp: 30, social: false },
  { id: 'd-sevens3', period: 'daily', emoji: '🃏', title: 'Play 3 sevens in Crazy 7', counter: 'sevens', goal: 3, coins: 150, xp: 30, social: false },
  { id: 'd-secret1', period: 'daily', emoji: '🤫', title: 'Complete a secret mission', counter: 'secrets', goal: 1, coins: 150, xp: 30, social: false },
  { id: 'd-friend1', period: 'daily', emoji: '👯', title: 'Finish a game with a friend', counter: 'friendGames', goal: 1, coins: 200, xp: 40, social: true },
  { id: 'd-friend2', period: 'daily', emoji: '👯', title: 'Finish 2 games with friends', counter: 'friendGames', goal: 2, coins: 250, xp: 50, social: true },
  { id: 'w-games15', period: 'weekly', emoji: '🎴', title: 'Finish 15 games', counter: 'games', goal: 15, coins: 1_000, xp: 150, social: false },
  { id: 'w-wins5', period: 'weekly', emoji: '🏆', title: 'Win 5 games', counter: 'wins', goal: 5, coins: 1_200, xp: 200, social: false },
  { id: 'w-catch10', period: 'weekly', emoji: '🕵️', title: 'Catch 10 liars in Bluff', counter: 'goodCalls', goal: 10, coins: 1_000, xp: 150, social: false },
  { id: 'w-sneak12', period: 'weekly', emoji: '😎', title: 'Get 12 lies past everyone in Bluff', counter: 'cleanBluffs', goal: 12, coins: 1_000, xp: 150, social: false },
  { id: 'w-c7wins3', period: 'weekly', emoji: '7️⃣', title: 'Win 3 games of Crazy 7', counter: 'crazy7Wins', goal: 3, coins: 1_000, xp: 150, social: false },
  { id: 'w-secret5', period: 'weekly', emoji: '🤫', title: 'Complete 5 secret missions', counter: 'secrets', goal: 5, coins: 1_000, xp: 150, social: false },
  { id: 'w-friend5', period: 'weekly', emoji: '👯', title: 'Finish 5 games with friends', counter: 'friendGames', goal: 5, coins: 1_200, xp: 200, social: true },
];

/** missions in each day's set and in each week's set */
export const MISSIONS_PER_SET = 3;

/** the catalogue entry for a mission id, or null */
export const missionOf = (id: string | null | undefined) => MISSIONS.find((m) => m.id === id) ?? null;

/** one of a player's current missions */
export interface MissionView {
  id: string;
  /** counted so far, at most the goal */
  progress: number;
  /** reached the goal; its coins and XP were added right then */
  done: boolean;
}

/** GET /api/me/missions and the swap: today's and this week's missions */
export interface MissionsResponse {
  daily: MissionView[];
  weekly: MissionView[];
  /** today's free swap of one unfinished mission is still there */
  rerollLeft: boolean;
  /** when today's set and this week's set start again (ISO time) */
  dailyResetAt: string;
  weeklyResetAt: string;
}

/** a secret mission card: one per person per game, dealt at random when the game starts, revealed at game over */
export interface SecretMissionDef {
  id: string;
  game: GameKind;
  emoji: string;
  title: string;
  /** how it counts, in one line */
  how: string;
  goal: number;
}

export const SECRET_MISSIONS: readonly SecretMissionDef[] = [
  { id: 'catch2', game: 'bluff', emoji: '🕵️', title: 'Catch 2 liars', how: 'Two bluff calls that turn over a fake', goal: 2 },
  { id: 'sneak2', game: 'bluff', emoji: '😎', title: 'Get 2 lies past everyone', how: 'Two plays with a fake in them that stand or survive a call', goal: 2 },
  { id: 'bigLie', game: 'bluff', emoji: '🎭', title: 'Get a lie of 3 or more cards past everyone', how: 'One play of 3 or more cards with a fake in it that stands or survives a call', goal: 1 },
  { id: 'bait', game: 'bluff', emoji: '🪤', title: 'Get called on the truth', how: 'Put down only real cards and have someone call bluff on them', goal: 1 },
  { id: 'bigDrop', game: 'bluff', emoji: '🃏', title: 'Put down 4 cards in one go', how: '4 or more cards in one play, truth or lie', goal: 1 },
  { id: 'sevens2', game: 'crazy7', emoji: '7️⃣', title: 'Play two 7s', how: 'Any two 7s; one that answers a 7 counts too', goal: 2 },
  { id: 'stack7', game: 'crazy7', emoji: '🔁', title: 'Answer a 7 with your own 7', how: 'When a 7 makes you pick, play your own 7 instead (only dealt with Stack 7s on)', goal: 1 },
  { id: 'lastCard', game: 'crazy7', emoji: '📢', title: 'Say last card in time', how: 'Tap 📢 Last card before anyone else moves', goal: 1 },
];

/** the catalogue entry for a secret mission id, or null */
export const secretMissionOf = (id: string | null | undefined) => SECRET_MISSIONS.find((m) => m.id === id) ?? null;

/** bonus XP for a secret mission card done in a game that counts (logged in, finished, MIN_REWARD_GAME_SEC or more) */
export const SECRET_XP = 25;

/** my own secret mission card while the game runs (and at its end) */
export interface SecretView {
  id: string;
  /** counted so far from my own game, at most the goal */
  progress: number;
  done: boolean;
}

/** points a game gives in the weekly friends league (never coins); only games of MIN_REWARD_GAME_SEC or more with 2+ logged-in people count */
export const LEAGUE_POINTS = { game: 1, win: 10, goodCall: 3, cleanBluff: 2 } as const;

/** each week's side titles: most points, most liars caught, most lies nobody caught */
export const LEAGUE_CROWNS = [
  { id: 'champion', emoji: '👑', title: 'Champion of the week', stat: 'points' },
  { id: 'cid', emoji: '🕵️', title: 'CID of the week', stat: 'goodCalls' },
  { id: 'jhootha', emoji: '🤥', title: 'Jhootha No. 1', stat: 'cleanBluffs' },
] as const;
export type LeagueCrownId = (typeof LEAGUE_CROWNS)[number]['id'];

/** one player's week in the league */
export interface LeagueStats {
  points: number;
  games: number;
  wins: number;
  goodCalls: number;
  cleanBluffs: number;
}

export interface LeagueRow extends LeagueStats {
  id: string;
  username: string;
  displayName: string;
  avatar: string | null;
  level: number;
  /** 1-based place on this board; ties share a place */
  place: number;
  me: boolean;
}

/** one week's board: me and my friends who played that week (hidden friends left out), best first */
export interface LeagueBoard {
  /** the IST Monday the week started (YYYY-MM-DD) */
  week: string;
  rows: LeagueRow[];
  /** who holds each crown (ties share it); a crown nobody scored for is left out */
  crowns: { id: LeagueCrownId; userIds: string[]; value: number }[];
}

/** GET /api/me/league */
export interface LeagueResponse {
  thisWeek: LeagueBoard;
  /** last week's final board; null when nobody on it played */
  lastWeek: LeagueBoard | null;
  /** when this week ends (ISO time, Monday 00:00 IST) */
  resetAt: string;
  /** I'm left off my friends' boards (I still see mine) */
  hidden: boolean;
}

/** the Dosti meter: finished games together; levels never go down */
export const DOSTI_LEVELS = [
  { level: 1, games: 1, name: 'Hi-Hello' },
  { level: 2, games: 5, name: 'Dost' },
  { level: 3, games: 15, name: 'Pakke Dost' },
  { level: 4, games: 40, name: 'Jigri Yaar' },
  { level: 5, games: 100, name: 'Jaan se Pyaare' },
] as const;

/** the Dosti level for a number of games together, or null before the first */
export const dostiOf = (games: number) => [...DOSTI_LEVELS].reverse().find((d) => games >= d.games) ?? null;

/** decided games (one finished ahead of the other) needed before a Rival or Nemesis tag shows */
export const RIVAL_MIN_GAMES = 10;

/** my record against one friend, from our saved games together */
export interface RivalRecord {
  id: string;
  username: string;
  displayName: string;
  avatar: string | null;
  level: number;
  /** finished games together: the Dosti meter */
  games: number;
  /** games I finished ahead of them, and they of me; games where neither was ahead aren't in either */
  ahead: number;
  behind: number;
  /** times I caught them lying, and they caught me (counted since this came in) */
  iCaught: number;
  theyCaught: number;
  /** rival: a close record; nemesis: they finish ahead most of the time; null until RIVAL_MIN_GAMES decided games */
  tag: 'rival' | 'nemesis' | null;
}

/** GET /api/me/rivals: every friend I've finished a game with, most games first */
export interface RivalsResponse {
  records: RivalRecord[];
}

/** ranked divisions by rank points; reaching one makes its start a floor for the rest of the season */
export const RANK_DIVISIONS = [
  { id: 'bronze', name: 'Bronze', emoji: '🥉', min: 0 },
  { id: 'silver', name: 'Silver', emoji: '🥈', min: 300 },
  { id: 'gold', name: 'Gold', emoji: '🥇', min: 700 },
  { id: 'platinum', name: 'Platinum', emoji: '💠', min: 1_200 },
  { id: 'diamond', name: 'Diamond', emoji: '💎', min: 1_800 },
  { id: 'badshah', name: 'Bluff Badshah', emoji: '👑', min: 2_500 },
] as const;
export type RankDivisionId = (typeof RANK_DIVISIONS)[number]['id'];

/** the division for some rank points */
export const divisionOf = (points: number) => [...RANK_DIVISIONS].reverse().find((d) => points >= d.min) ?? RANK_DIVISIONS[0];

/** rank points a player can win or lose in one IST day, so one night can't make or break a season */
export const RANK_DAILY_CAP = 150;

/** my ranked standing this season */
export interface RankView {
  season: number;
  points: number;
  division: RankDivisionId;
  /** points never drop below this: the start of the best division reached this season */
  floor: number;
  games: number;
  wins: number;
  /** today's change so far, within RANK_DAILY_CAP either way */
  today: number;
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
  /** chosen avatar ("face.bg"); null shows the first letter */
  avatar: string | null;
  /** chosen card back (CARD_BACKS id); null until picked (shown as the classic back) */
  cardBack: string | null;
  /** chosen table theme (TABLE_THEMES id); null until picked (shown as classic green) */
  tableTheme: string | null;
  role: Role;
  coins: number;
  stats: LifetimeStats;
  createdAt: string;
  /** coins this player can still give friends today */
  giftLeft: number;
  /** games whose practice tutorial this account has finished or skipped */
  tutorials: GameKind[];
  /** this season's ranked standing; null before a ranked game this season (older servers don't send it) */
  rank: RankView | null;
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
  /** the ranked season now on; an admin starts a new one (older documents: 1) */
  rankedSeason: number;
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
  avatar: string | null;
  online: boolean;
  /** when they were last online (ISO); null while online, for requests, or if never seen */
  lastSeen: string | null;
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
  avatar: string | null;
  level: number;
  /** null unless they're already a friend */
  online: boolean | null;
  /** when a friend was last online (ISO); null while online, if never seen, or for anyone who isn't a friend */
  lastSeen: string | null;
  /** how they relate to me */
  status: 'friend' | 'sent' | 'incoming' | 'none';
}

/** what anyone logged in can see about a player: name, level and game record, nothing private */
export interface PublicProfile {
  id: string;
  username: string;
  displayName: string;
  avatar: string | null;
  level: number;
  joinedAt: string;
  /** null unless they're a friend (or me) */
  online: boolean | null;
  /** when a friend was last online (ISO); null while online, if never seen, or for anyone who isn't a friend */
  lastSeen: string | null;
  stats: LifetimeStats;
  /** how they relate to me */
  status: 'me' | 'friend' | 'sent' | 'incoming' | 'none';
  /** this season's division and rank points; null before a ranked game this season */
  rank: { division: RankDivisionId; points: number } | null;
}

export interface FriendsResponse {
  friends: FriendView[];
  /** requests waiting for me to accept */
  incoming: FriendView[];
  /** requests I sent */
  outgoing: FriendView[];
}

/** a friend's app just opened after a while away; sent to their friends who are online */
export interface FriendOnlineEvent {
  id: string;
  name: string;
  username: string;
  /** chosen avatar ("face.bg"); null shows the first letter */
  avatar: string | null;
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
