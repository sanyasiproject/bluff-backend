// Shapes shared with the client. Keep in sync with bluff-frontend/src/types.ts
export const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'] as const;
export type Rank = (typeof RANKS)[number];

/** a card's value for the final ranking: A 1, 2 2 … 10 10, J 11, Q 12, K 13 */
export const cardValue = (c: { rank: Rank }): number => RANKS.indexOf(c.rank) + 1;
/** total value of a hand; less is better */
export const handValue = (cards: { rank: Rank }[]): number => cards.reduce((n, c) => n + cardValue(c), 0);

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
/** login streak: the daily login reward by streak day (day 1 = LOGIN_BONUS); after day 7 the week starts again, the streak count keeps going */
export const LOGIN_STREAK_REWARDS = [LOGIN_BONUS, 250, 300, 400, 500, 650, 1_000] as const;
/** the login reward for a streak of this many days in a row (1 = first day) */
export const loginRewardOf = (streak: number): number => LOGIN_STREAK_REWARDS[(Math.max(1, streak) - 1) % LOGIN_STREAK_REWARDS.length];

/** the daily spin wheel's slices, in wheel order (one free spin per IST day); the server picks the slice */
export const SPIN_PRIZES: readonly { kind: 'coins' | 'xp'; amount: number }[] = [
  { kind: 'coins', amount: 100 },
  { kind: 'xp', amount: 50 },
  { kind: 'coins', amount: 250 },
  { kind: 'coins', amount: 500 },
  { kind: 'xp', amount: 100 },
  { kind: 'coins', amount: 1_000 },
  { kind: 'coins', amount: 2_500 },
  { kind: 'coins', amount: 10_000 },
];

/** what one daily spin gave */
export interface SpinResponse {
  /** slice of SPIN_PRIZES the wheel stops on */
  index: number;
  prize: { kind: 'coins' | 'xp'; amount: number };
  user: PublicUser;
}

/** turn timer (a room setting): default seconds each turn shows; after missesToAway timed-out turns in a row a player is away and gets awaySec */
export const TURN_TIMER = { turnSec: 30, awaySec: 8, missesToAway: 2 } as const;
/** turn lengths the host can pick */
export const TURN_SECONDS = [15, 30, 45] as const;
export type TurnSeconds = (typeof TURN_SECONDS)[number];
/** a win streak shows on seats and lobby rows from this many wins in a row */
export const WIN_STREAK_SHOWN = 3;
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
/** most Card Shields a room can allow per player per game */
export const MAX_CARD_SHIELDS = 3;
/** a Card Shield covers a play of up to this many cards */
export const SHIELD_MAX_CARDS = 2;

/** coins a caller can bet on a bluff call (never more than the room's stake) */
export const BET_STEPS = [50, 100, 250, 500, 1_000, 5_000, 10_000, 50_000, 100_000, 500_000] as const;

/** which game a room plays */
export type GameKind = 'bluff' | 'crazy7' | 'rang';

/** how well Bluff bots play; the host picks it in the lobby (Crazy 7 bots always play their best) */
export const BOT_LEVELS = ['normal', 'hard', 'expert'] as const;
export type BotLevel = (typeof BOT_LEVELS)[number];

export const BOT_LEVEL_NAMES: Record<BotLevel, string> = { normal: 'Normal', hard: 'Hard', expert: 'Expert' };

/** with bots at the table the stake can be at most this, by bot level (bots have no coins of their own): Normal bots play only free games */
export const BOT_STAKE_CAPS: Record<BotLevel, number> = { normal: 0, hard: 100, expert: 1_000 };

/** the bot level that sets a table's stake cap: Crazy 7 bots always play their best, so they count as expert */
export const stakeLevelOf = (config: { game?: GameKind; botLevel?: BotLevel }): BotLevel =>
  config.game === 'crazy7' || config.game === 'rang' ? 'expert' : (config.botLevel ?? 'expert');

/** the most a table with bots may stake */
export const botStakeCap = (config: { game?: GameKind; botLevel?: BotLevel }): number => BOT_STAKE_CAPS[stakeLevelOf(config)] ?? BOT_STAKE_CAPS.expert;

/** Crazy 7: cards dealt to each player */
export const CRAZY7_HAND_SIZES = [5, 7] as const;
/** Crazy 7: the most cards a player may pick in one turn (the room setting goes from 1 to this) */
export const CRAZY7_MAX_PICKS = 7;
/** Crazy 7: cards the next player must pick for each 7 */
export const SEVEN_PENALTY = 2;
/** Crazy 7 with power cards: cards the next player must pick for each 2 (answered by a 2 or a 7 with Stack 7s on) */
export const TWO_PENALTY = 2;
/** Crazy 7 with power cards: J changes the suit (wild), 8 skips the next player, A reverses the direction, 2 makes the next player pick 2 */
export const C7_POWER_RANKS = ['J', '8', 'A', '2'] as const;

/** Rang: our own colour-card game. Four colours, numbers 0–9 and action cards */
export const RANG_COLORS = ['red', 'blue', 'green', 'yellow'] as const;
export type RangColor = (typeof RANG_COLORS)[number];
export const RANG_VALUES = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'skip', 'reverse', 'draw2', 'wild', 'wild4'] as const;
export type RangValue = (typeof RANG_VALUES)[number];
/** a Rang card; wild and wild4 have no colour of their own */
export interface RangCard {
  id: string;
  color: RangColor | null;
  value: RangValue;
}
/** Rang: cards dealt to each player by default, and the sizes the host can pick (config.rangHand) */
export const RANG_HAND_SIZE = 7;
export const RANG_HAND_SIZES = [5, 7, 10] as const;
/** Rang: cards picked for forgetting "last card", the choices (config.rangMissed) */
export const RANG_MISSED_PENALTIES = [1, 2, 4] as const;
/** Rang: the most cards a player may pick in one turn while looking for one that fits (the room setting goes from 1 to this) */
export const RANG_MAX_PICKS = 7;
/** Rang: cards picked for forgetting to say last card */
export const RANG_MISSED_PENALTY = 2;
/** Rang: a card's points for the final ranking: numbers their face value, Skip, Reverse and +2 20, wilds 50 (lower is better) */
export const rangPoints = (c: Pick<RangCard, 'value'>): number =>
  /^[0-9]$/.test(c.value) ? Number(c.value) : c.value === 'wild' || c.value === 'wild4' ? 50 : 20;
/** Rang: total points of a hand; lower is better */
export const rangHandPoints = (cards: Pick<RangCard, 'value'>[]): number => cards.reduce((n, c) => n + rangPoints(c), 0);

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
  /** both games: live voice for logged-in seated players (older apps don't send it: on) */
  voice: boolean;
  /** Bluff: a random rank is drawn at the deal and its cards are wild, backing up any claim (older apps don't send it: off) */
  kismat: boolean;
  /** Bluff: after the opener each claim is the same rank, one below or one above the last claim (older apps don't send it: off) */
  seedhi: boolean;
  /** both games: each turn has TURN_TIMER.turnSec; when it runs out the server plays a safe move (older apps don't send it: off) */
  turnTimer: boolean;
  /** turn timer: seconds a turn shows, one of TURN_SECONDS (older apps don't send it: 30) */
  turnSec: TurnSeconds;
  /** Crazy 7: power cards J (change suit), 8 (skip), A (reverse) and 2 (pick 2) (older apps don't send it: off) */
  c7Power: boolean;
  /** Rang: most cards picked in one turn while looking for one that fits, 1 to RANG_MAX_PICKS (older apps don't send it: 1) */
  rangPicks: number;
  /** Rang: a +2 may be answered with a +2 or +4, and a +4 with a +4; the next player picks the total (older apps don't send it: on) */
  rangStack: boolean;
  /** Rang: the player hit by a +4 may challenge it; played while holding the colour in play, its player picks 4 instead; played fairly, the challenger picks 6 (older apps don't send it: on) */
  rangChallenge: boolean;
  /** Rang: a 7 swaps hands with a player of your choice, a 0 passes every hand on in the direction of play (older apps don't send it: off) */
  rangSwap: boolean;
  /** Rang: a picked card that fits is played at once (a wild names the colour held most, a 7 swaps with the fewest cards) (older apps don't send it: off) */
  rangForce: boolean;
  /** Rang: cards dealt to each player, one of RANG_HAND_SIZES (older apps don't send it: 7) */
  rangHand: 5 | 7 | 10;
  /** Rang: cards picked for forgetting "last card", one of RANG_MISSED_PENALTIES (older apps don't send it: 2) */
  rangMissed: 1 | 2 | 4;
  /** Rang: put down 2 or more number cards of the same number in one go; the first must fit, the last one's colour is next (older apps don't send it: off) */
  rangDoubles: boolean;
  /** Bluff: Card Shields per player per game (0 = off): a shielded play of up to SHIELD_MAX_CARDS can't be called or peeked (older apps don't send it: 0) */
  shields: number;
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
  /** 🔒 under a Card Shield: nobody could call it */
  shielded?: boolean;
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

/** one move at a Rang table, for seat labels and animations */
export interface RangMove {
  /** goes up by one with every move */
  id: number;
  kind: 'play' | 'pick' | 'penalty' | 'pass' | 'call' | 'missed' | 'shuffle' | 'challenge';
  playerId: string | null;
  /** the card played */
  card: RangCard | null;
  /** cards picked */
  count: number;
  /** play: the colour named with a wild; null otherwise */
  color?: RangColor | null;
  /** play with doubles: every card put down, in order (the last one is on top) */
  cards?: RangCard[];
  /** play: Force play put down the card just picked */
  forced?: boolean;
  /** play: the player skipped, or swapped with (7-0); challenge: who played the +4 */
  targetId?: string | null;
  /** challenge: the +4 was played while holding the colour in play */
  guilty?: boolean;
}

/** the Rang table as one seat sees it */
export interface RangView {
  /** my cards (RoomView.hand stays empty in Rang) */
  hand: RangCard[];
  top: RangCard | null;
  /** a few cards under the top, oldest first */
  under: RangCard[];
  /** the colour to match: the top card's, or the one named with a wild */
  color: RangColor | null;
  pileCount: number;
  deckCount: number;
  /** 1 clockwise (seat order), -1 after a Reverse */
  dir: 1 | -1;
  /** cards the player on turn must pick because of +2 / +4 (0 = none) */
  penalty: number;
  /** cards the player on turn has picked this turn, and the most allowed (config.rangPicks) */
  picks: number;
  maxPicks: number;
  /** my cards that can go on the pile now; empty when it isn't my turn */
  playable: string[];
  canPick: boolean;
  canPass: boolean;
  canCall: boolean;
  /** I was hit by a single +4 and may challenge it */
  canChallenge: boolean;
  /** cards I picked this turn */
  picked: string[];
  called: string[];
  missed: string[];
  atRisk: string | null;
  last: RangMove | null;
  /** goes up by one each time a turn starts */
  turn: number;
  /** something automatic is about to happen to the player on turn */
  auto: boolean;
  /** who put the top card down; null for the starting card */
  topBy: string | null;
  /** people without a seat see every hand; null for seated players */
  watch: Record<string, RangCard[]> | null;
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
  /** power cards: the suit named with a J, which the next card must follow; null otherwise */
  wish: Suit | null;
  /** power cards: 1 in seat order, -1 after an A */
  dir: 1 | -1;
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

/** live voice: the most a connection message (offer or answer, with its network routes) may be */
export const RTC_MAX_SDP = 32 * 1024;

/** what the server tells a phone that joins live voice: how to reach the others (STUN, and TURN when the server has one) */
export interface LiveVoiceJoin {
  iceServers: { urls: string | string[]; username?: string; credential?: string }[];
}

/** a live voice connection message, passed from one seated player to another; the server never keeps it */
export interface RtcSignal {
  from: string;
  sdp: { type: 'offer' | 'answer'; sdp: string };
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
  { id: 'royal', name: 'Royal blue', emoji: '🔵', level: 2 },
  { id: 'wood', name: 'Wooden', emoji: '🪵', level: 4 },
  { id: 'midnight', name: 'Midnight', emoji: '🌙', level: 8 },
  { id: 'maroon', name: 'Maroon velvet', emoji: '🍷', level: 12 },
  { id: 'emerald', name: 'Emerald gold', emoji: '✨', level: 18 },
  { id: 'galaxy', name: 'Galaxy', emoji: '🌌', level: 28 },
  { id: 'saffron', name: 'Saffron', emoji: '🧡', level: 6 },
  { id: 'lagoon', name: 'Lagoon', emoji: '🏝️', level: 14 },
  { id: 'diwali', name: 'Diwali lights', emoji: '🪔', level: 24 },
  { id: 'monsoon', name: 'Monsoon', emoji: '🌧️', level: 32 },
  { id: 'champion', name: 'Champion', emoji: '🏆', level: 36 },
  { id: 'rail', name: 'Green rail', emoji: '🎱', level: 10 },
  { id: 'lattice', name: 'Royal lattice', emoji: '💠', level: 16 },
  { id: 'planks', name: 'Wood planks', emoji: '🪚', level: 20 },
  { id: 'moonlit', name: 'Moonlit night', emoji: '🌛', level: 22 },
  { id: 'velvet', name: 'Velvet sheen', emoji: '🎭', level: 26 },
  { id: 'goldweave', name: 'Gold weave', emoji: '🧵', level: 30 },
  { id: 'nebula', name: 'Nebula', emoji: '🪐', level: 34 },
] as const;

/** the table of guests, bots and players who haven't picked one */
export const DEFAULT_TABLE_THEME = 'classic';

/** the catalog entry for a table id, or null */
export const tableThemeOf = (id: string | null | undefined) => TABLE_THEMES.find((t) => t.id === id) ?? null;

/** card backs: everyone at the table sees a player's face-down cards in that player's back; some unlock with level */
export const CARD_BACKS = [
  { id: 'classic', name: 'Classic red', emoji: '🟥', level: 1 },
  { id: 'ocean', name: 'Ocean blue', emoji: '🌊', level: 2 },
  { id: 'paisley', name: 'Paisley', emoji: '🌼', level: 4 },
  { id: 'neon', name: 'Neon', emoji: '💡', level: 8 },
  { id: 'gold', name: 'Royal gold', emoji: '👑', level: 12 },
  { id: 'mandala', name: 'Mandala', emoji: '🪷', level: 18 },
  { id: 'diamond', name: 'Diamond', emoji: '💎', level: 24 },
  { id: 'legend', name: 'Legend', emoji: '🏆', level: 38 },
  { id: 'rangoli', name: 'Rangoli', emoji: '🎨', level: 6 },
  { id: 'peacock', name: 'Peacock', emoji: '🦚', level: 16 },
  { id: 'kite', name: 'Kite festival', emoji: '🪁', level: 22 },
  { id: 'cosmic', name: 'Cosmic', emoji: '🌠', level: 32 },
  { id: 'maharaja', name: 'Maharaja', emoji: '🐘', level: 40 },
  { id: 'rosette', name: 'Red rosette', emoji: '🏵️', level: 10 },
  { id: 'anchor', name: 'Anchor blue', emoji: '⚓', level: 14 },
  { id: 'teardrop', name: 'Paisley drop', emoji: '💧', level: 20 },
  { id: 'bolt', name: 'Neon bolt', emoji: '⚡', level: 26 },
  { id: 'crown', name: 'Gold crown', emoji: '🤴', level: 28 },
  { id: 'lotus', name: 'Lotus', emoji: '🌸', level: 30 },
  { id: 'gem', name: 'Cut gem', emoji: '🔷', level: 34 },
  { id: 'laurel', name: 'Laurel', emoji: '🌿', level: 36 },
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
  /** game over: total value of the cards still held (A 1 … K 13), which ranks those who didn't finish; null while playing */
  handValue: number | null;
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
  /** shop looks they rent (aura, win burst, entry flash); missing from older servers */
  shop?: ShopLook;
  /** in live voice right now: logged in, seated, connected and the host's voice switch on (missing from older servers) */
  live?: boolean;
  /** in live voice with the mic on; in it with this false: only listening (missing from older servers) */
  mic?: boolean;
  /** this season's division and points (logged-in people; refreshed after each ranked game); null for guests and bots */
  rank?: { division: RankDivisionId; points: number } | null;
  /** turn timer on and they let 2 turns in a row run out: their turns get the short away timer until they move again (missing from older servers) */
  away?: boolean;
  /** games won in a row (logged-in people; refreshed after each game); 0 for guests and bots (missing from older servers) */
  streak?: number;
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
  /** extra XP from a shop XP boost, already in stats.bonusXp (missing from older servers) */
  boostXp?: number;
  /** extra coins from a shop coin boost on the daily ladder and missions, already in coins (missing from older servers) */
  boostCoins?: number;
  /**
   * a rated game's rank points before and after, the division shown now, and what held the change back: the daily cap, 0 points
   * (floor), paying back losses held off earlier, a Rank Shield used up, or the division kept by its 50-point protection (grace); null otherwise
   */
  rank: { before: number; after: number; division: RankDivisionId; held: 'cap' | 'floor' | 'debt' | 'shield' | 'grace' | null } | null;
  /** games won in a row after this game; null for guests and games that didn't finish (missing from older servers) */
  winStreak?: number | null;
  /** season pass XP this game gave (games that count, wins and missions finished); missing from older servers */
  passXp?: number;
}

export interface LastPlayView {
  id: string;
  playerId: string;
  count: number;
  rank: Rank;
  /** 🔒 Card Shield: nobody can call or peek at it */
  shielded: boolean;
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
  /** turn timer: ms left on this turn's clock when the view was made; null when the timer is off or nobody's clock runs (missing from older servers) */
  turnMsLeft?: number | null;
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
  /** Card Shields I have left this game */
  shieldsLeft: number;
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
  /** people waiting for me to let them in: through me as their friend, or (host) mid-game watchers; watch: they asked to watch */
  watchRequests: { id: string; name: string; registered: boolean; level: number | null; watch?: boolean; viaFriend?: boolean }[];
  /** players who used Leave game in this game: they lost and still pay the stake */
  leftPlayers: { id: string; name: string; registered: boolean; level: number | null }[];
  /** the Crazy 7 table while a Crazy 7 game is on, else null */
  crazy7: Crazy7View | null;
  /** the Rang table while a Rang game is on, else null */
  rang: RangView | null;
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
  /** of gamesPlayed, how many were Rang (older accounts: missing) */
  rangGames?: number;
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
  | 'secrets'
  /** Bluff games won */
  | 'bluffWins'
  /** Bluff: lies told (plays with a fake in them), caught or not */
  | 'bluffs'
  /** ranked Bluff games finished, and won */
  | 'rankedGames'
  | 'rankedWins'
  /** 2 vs 2 games won */
  | 'teamWins'
  /** games won with an accepted friend at the table */
  | 'friendWins'
  /** Crazy 7: "last card" said in time */
  | 'lastCalls'
  /** Crazy 7: a waiting 7 answered with your own 7 */
  | 'stacks'
  /** Rang games finished, and won */
  | 'rangGames'
  | 'rangWins';

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
  { id: 'd-ranggames2', period: 'daily', emoji: '🌈', title: 'Finish 2 games of Rang', counter: 'rangGames', goal: 2, coins: 150, xp: 30, social: false },
  { id: 'd-c7games2', period: 'daily', emoji: '7️⃣', title: 'Finish 2 games of Crazy 7', counter: 'crazy7Games', goal: 2, coins: 150, xp: 30, social: false },
  { id: 'd-sevens3', period: 'daily', emoji: '🃏', title: 'Play 3 sevens in Crazy 7', counter: 'sevens', goal: 3, coins: 150, xp: 30, social: false },
  { id: 'd-secret1', period: 'daily', emoji: '🤫', title: 'Complete a secret mission', counter: 'secrets', goal: 1, coins: 150, xp: 30, social: false },
  { id: 'd-friend1', period: 'daily', emoji: '👯', title: 'Finish a game with a friend', counter: 'friendGames', goal: 1, coins: 200, xp: 40, social: true },
  { id: 'd-friend2', period: 'daily', emoji: '👯', title: 'Finish 2 games with friends', counter: 'friendGames', goal: 2, coins: 250, xp: 50, social: true },
  { id: 'd-games5', period: 'daily', emoji: '🔥', title: 'Finish 5 games', counter: 'games', goal: 5, coins: 250, xp: 50, social: false },
  { id: 'd-wins3', period: 'daily', emoji: '🏆', title: 'Win 3 games', counter: 'wins', goal: 3, coins: 350, xp: 60, social: false },
  { id: 'd-bluffwin1', period: 'daily', emoji: '😏', title: 'Win a game of Bluff', counter: 'bluffWins', goal: 1, coins: 200, xp: 40, social: false },
  { id: 'd-lies6', period: 'daily', emoji: '🤥', title: 'Tell 6 lies in Bluff', counter: 'bluffs', goal: 6, coins: 150, xp: 30, social: false },
  { id: 'd-catch5', period: 'daily', emoji: '🔍', title: 'Catch 5 liars in Bluff', counter: 'goodCalls', goal: 5, coins: 250, xp: 50, social: false },
  { id: 'd-ranked2', period: 'daily', emoji: '🏅', title: 'Finish 2 ranked games', counter: 'rankedGames', goal: 2, coins: 250, xp: 50, social: false },
  { id: 'd-teamwin1', period: 'daily', emoji: '🤝', title: 'Win a 2 vs 2 game', counter: 'teamWins', goal: 1, coins: 200, xp: 40, social: false },
  { id: 'd-lastcall2', period: 'daily', emoji: '📢', title: 'Say last card in time twice in Crazy 7', counter: 'lastCalls', goal: 2, coins: 150, xp: 30, social: false },
  { id: 'd-stack1', period: 'daily', emoji: '🔁', title: 'Answer a 7 with your own 7', counter: 'stacks', goal: 1, coins: 200, xp: 40, social: false },
  { id: 'd-friendwin1', period: 'daily', emoji: '🥳', title: 'Win a game with a friend at the table', counter: 'friendWins', goal: 1, coins: 300, xp: 50, social: true },
  { id: 'w-games15', period: 'weekly', emoji: '🎴', title: 'Finish 15 games', counter: 'games', goal: 15, coins: 1_000, xp: 150, social: false },
  { id: 'w-wins5', period: 'weekly', emoji: '🏆', title: 'Win 5 games', counter: 'wins', goal: 5, coins: 1_200, xp: 200, social: false },
  { id: 'w-catch10', period: 'weekly', emoji: '🕵️', title: 'Catch 10 liars in Bluff', counter: 'goodCalls', goal: 10, coins: 1_000, xp: 150, social: false },
  { id: 'w-sneak12', period: 'weekly', emoji: '😎', title: 'Get 12 lies past everyone in Bluff', counter: 'cleanBluffs', goal: 12, coins: 1_000, xp: 150, social: false },
  { id: 'w-rangwins3', period: 'weekly', emoji: '🌈', title: 'Win 3 games of Rang', counter: 'rangWins', goal: 3, coins: 1_000, xp: 150, social: false },
  { id: 'w-c7wins3', period: 'weekly', emoji: '7️⃣', title: 'Win 3 games of Crazy 7', counter: 'crazy7Wins', goal: 3, coins: 1_000, xp: 150, social: false },
  { id: 'w-secret5', period: 'weekly', emoji: '🤫', title: 'Complete 5 secret missions', counter: 'secrets', goal: 5, coins: 1_000, xp: 150, social: false },
  { id: 'w-friend5', period: 'weekly', emoji: '👯', title: 'Finish 5 games with friends', counter: 'friendGames', goal: 5, coins: 1_200, xp: 200, social: true },
  { id: 'w-games40', period: 'weekly', emoji: '🔥', title: 'Finish 40 games', counter: 'games', goal: 40, coins: 2_500, xp: 400, social: false },
  { id: 'w-wins15', period: 'weekly', emoji: '🏆', title: 'Win 15 games', counter: 'wins', goal: 15, coins: 3_000, xp: 500, social: false },
  { id: 'w-bluffwins8', period: 'weekly', emoji: '😏', title: 'Win 8 games of Bluff', counter: 'bluffWins', goal: 8, coins: 2_000, xp: 300, social: false },
  { id: 'w-lies40', period: 'weekly', emoji: '🤥', title: 'Tell 40 lies in Bluff', counter: 'bluffs', goal: 40, coins: 1_200, xp: 200, social: false },
  { id: 'w-catch25', period: 'weekly', emoji: '🔍', title: 'Catch 25 liars in Bluff', counter: 'goodCalls', goal: 25, coins: 2_000, xp: 300, social: false },
  { id: 'w-sneak30', period: 'weekly', emoji: '🗿', title: 'Get 30 lies past everyone in Bluff', counter: 'cleanBluffs', goal: 30, coins: 2_000, xp: 300, social: false },
  { id: 'w-ranked10', period: 'weekly', emoji: '🏅', title: 'Finish 10 ranked games', counter: 'rankedGames', goal: 10, coins: 2_000, xp: 300, social: false },
  { id: 'w-rankedwins5', period: 'weekly', emoji: '🎖️', title: 'Win 5 ranked games', counter: 'rankedWins', goal: 5, coins: 2_500, xp: 400, social: false },
  { id: 'w-teamwins3', period: 'weekly', emoji: '🤝', title: 'Win 3 games of 2 vs 2', counter: 'teamWins', goal: 3, coins: 1_500, xp: 250, social: false },
  { id: 'w-c7games10', period: 'weekly', emoji: '🌀', title: 'Finish 10 games of Crazy 7', counter: 'crazy7Games', goal: 10, coins: 1_200, xp: 200, social: false },
  { id: 'w-stacks5', period: 'weekly', emoji: '🔁', title: 'Answer 5 sevens with your own 7', counter: 'stacks', goal: 5, coins: 1_200, xp: 200, social: false },
  { id: 'w-friend15', period: 'weekly', emoji: '👯', title: 'Finish 15 games with friends', counter: 'friendGames', goal: 15, coins: 2_000, xp: 300, social: true },
  { id: 'w-friendwins5', period: 'weekly', emoji: '🥳', title: 'Win 5 games with a friend at the table', counter: 'friendWins', goal: 5, coins: 2_500, xp: 400, social: true },
];

/** missions in each day's set and in each week's set */
export const MISSIONS_PER_SET = 4;

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
  { id: 'rgStack', game: 'rang', emoji: '➕', title: 'Answer a +2 or +4 with your own', how: 'When a +2 or +4 makes you pick, stack your own instead (only dealt with stacking on)', goal: 1 },
  { id: 'rgWilds', game: 'rang', emoji: '🌈', title: 'Play two wilds', how: 'Any two Wild or Wild +4 cards', goal: 2 },
  { id: 'rgLast', game: 'rang', emoji: '📢', title: 'Say last card in time', how: 'Tap 📢 Last card before anyone else moves', goal: 1 },
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

/** ranked divisions by rank points; you keep showing one until you're RANK_PROTECTION points below its start */
export const RANK_DIVISIONS = [
  // tiers: equal steps shown as Gold 1, Gold 2… (1 is the lowest); display only, points and protection work per division
  // how much a win and a loss move points in each division is server-only (services/ranked.ts), never sent to apps
  { id: 'bronze', name: 'Bronze', emoji: '🥉', min: 0, tiers: 3 },
  { id: 'silver', name: 'Silver', emoji: '🥈', min: 300, tiers: 3 },
  { id: 'gold', name: 'Gold', emoji: '🥇', min: 700, tiers: 4 },
  { id: 'platinum', name: 'Platinum', emoji: '💠', min: 1_200, tiers: 4 },
  { id: 'diamond', name: 'Diamond', emoji: '💎', min: 1_800, tiers: 5 },
  { id: 'badshah', name: 'Bluff Badshah', emoji: '👑', min: 2_500, tiers: 1 },
] as const;

/** where each tier of a division starts, lowest first (one entry for a division without tiers) */
export function tierStarts(id: RankDivisionId): number[] {
  const i = RANK_DIVISIONS.findIndex((d) => d.id === id);
  const d = RANK_DIVISIONS[i];
  const end = RANK_DIVISIONS[i + 1]?.min ?? d.min;
  return Array.from({ length: d.tiers }, (_, t) => Math.ceil(d.min + ((end - d.min) * t) / d.tiers));
}

/** the tier (1 is the lowest) for these points in the division shown; under its start (its protection) counts as tier 1; null without tiers */
export function rankTier(points: number, id: RankDivisionId): number | null {
  const starts = tierStarts(id);
  if (starts.length < 2) return null;
  let tier = 1;
  starts.forEach((at, t) => points >= at && (tier = t + 1));
  return tier;
}

/** "Gold 2", or "Bluff Badshah" for a division without tiers */
export function rankName(points: number, id: RankDivisionId): string {
  const d = RANK_DIVISIONS.find((x) => x.id === id) ?? RANK_DIVISIONS[0];
  const tier = rankTier(points, d.id);
  return tier === null ? d.name : `${d.name} ${tier}`;
}

/** the next tier or division up from here, and the points where it starts; null at the top */
export function nextRankStep(points: number, id: RankDivisionId): { name: string; emoji: string; at: number } | null {
  const i = RANK_DIVISIONS.findIndex((d) => d.id === id);
  const d = RANK_DIVISIONS[i];
  const higher = tierStarts(d.id).find((at) => at > points);
  if (higher !== undefined) return { name: rankName(higher, d.id), emoji: d.emoji, at: higher };
  const up = RANK_DIVISIONS[i + 1];
  return up ? { name: rankName(up.min, up.id), emoji: up.emoji, at: up.min } : null;
}

/** points can fall this far below a division's start before the division shown drops to the one below */
export const RANK_PROTECTION = 50;
export type RankDivisionId = (typeof RANK_DIVISIONS)[number]['id'];

/** the division for some rank points */
export const divisionOf = (points: number) => [...RANK_DIVISIONS].reverse().find((d) => points >= d.min) ?? RANK_DIVISIONS[0];

/** a ranked loss costs this share of the points the same win would give, so wins count for more */
export const RANK_LOSS_SHARE = 0.7;

/** a new season starts everyone this many divisions below where they ended the last one (never below 0) */
export const RANK_SEASON_DROP = 1.5;

/** an admin's new season starts this many days after they ask for it */
export const SEASON_START_DELAY_DAYS = 7;

/** a season normally runs about a month; from this day on the admin's button reminds them to start the next one */
export const SEASON_REMIND_DAY = 23;

/** one finished season of a player's, for their history */
export interface SeasonResult {
  season: number;
  division: RankDivisionId;
  points: number;
  games: number;
  wins: number;
}

/** my ranked standing this season */
export interface RankView {
  season: number;
  points: number;
  division: RankDivisionId;
  /** the start of the division shown; points may go RANK_PROTECTION below it before that division drops */
  floor: number;
  games: number;
  wins: number;
  /** today's change so far (no limit) */
  today: number;
  /** when this season started, and when the next one starts once an admin asked for it (ISO); null when not known or not asked */
  startedAt?: string | null;
  nextAt?: string | null;
  /** earlier seasons played, newest first (missing from older servers) */
  history?: SeasonResult[];
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
  /** when this player may change their own name again (ISO); null: now. The first change is free, then one every NAME_CHANGE_DAYS; admins any time (missing from older servers) */
  nameChangeAt?: string | null;
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
  /** this season's ranked standing; everyone starts at Bronze (older servers send null before a ranked game) */
  rank: RankView | null;
  /** days in a row this player opened the app (login streak); 0 before the first (missing from older servers) */
  loginStreak?: number;
  /** used today's free spin (missing from older servers) */
  spunToday?: boolean;
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
  /** Crazy 7 and Rang: cards picked from the deck (older games: missing) */
  picks?: number;
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
  /** a step-by-step replay was saved (missing on older servers) */
  hasReplay?: boolean;
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

export type AuditAction = 'coins' | 'make_admin' | 'update' | 'password' | 'gift' | 'settings' | 'shop';

/** after a player changes their own display name, the next change waits this long */
export const NAME_CHANGE_DAYS = 60;

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
  /** when the season now on started (ISO); null if not known */
  rankedSeasonStartedAt?: string | null;
  /** when the next season starts, once an admin asked for it (ISO); null otherwise */
  nextSeasonAt?: string | null;
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
  /** this season's division and rank points; everyone starts at Bronze (older servers send null before a ranked game) */
  rank: { division: RankDivisionId; points: number } | null;
  /** earlier seasons they played, newest first (missing from older servers) */
  seasons?: SeasonResult[];
  /** their shop aura while it runs; null when none (missing from older servers) */
  aura?: string | null;
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

// ---------- coin shop: every item is rented for a day or a week, never owned ----------

/** xp: more XP per game · coins: more coins from the daily ladder and missions · aura: animated seat box, card backs and profile card · win: a burst everyone sees when you win · entry: a flash when you join a table · shield: a one-use card that stops a ranked loss */
export type ShopKind = 'xp' | 'coins' | 'aura' | 'win' | 'entry' | 'shield';

/** the shop slots a player shows to others: one of each, from their active rentals */
export type ShopLookKind = 'aura' | 'win' | 'entry';

export interface ShopItem {
  id: string;
  kind: ShopKind;
  emoji: string;
  name: string;
  desc: string;
  price: number;
  /** how long one buy lasts; buying it again while it runs adds this much more. 0: a one-use card, not a rental */
  days: 0 | 1 | 7;
  /** xp and coins: the multiplier (1.5 = +50%) */
  mult?: number;
}

export const SHOP_ITEMS: readonly ShopItem[] = [
  { id: 'xp-d15', kind: 'xp', emoji: '⚡', name: 'XP Spark', desc: '1.25x XP from games for a day', price: 500, days: 1, mult: 1.25 },
  { id: 'xp-d2', kind: 'xp', emoji: '🔥', name: 'XP Blaze', desc: '1.5x XP from games for a day', price: 1_200, days: 1, mult: 1.5 },
  { id: 'xp-d3', kind: 'xp', emoji: '💎', name: 'XP Diamond', desc: '2x XP from games for a day', price: 3_000, days: 1, mult: 2 },
  { id: 'xp-w15', kind: 'xp', emoji: '⚡', name: 'XP Spark week', desc: '1.25x XP from games for 7 days', price: 2_500, days: 7, mult: 1.25 },
  { id: 'xp-w2', kind: 'xp', emoji: '🔥', name: 'XP Blaze week', desc: '1.5x XP from games for 7 days', price: 6_000, days: 7, mult: 1.5 },
  { id: 'coins-w25', kind: 'coins', emoji: '🪙', name: 'Coin Magnet', desc: '+25% coins from the daily games ladder and missions for 7 days', price: 2_000, days: 7, mult: 1.25 },
  { id: 'shield', kind: 'shield', emoji: '🛡️', name: 'Rank Shield', desc: 'Your next ranked loss costs no rank points. Used up on that loss', price: 300, days: 0 },
  { id: 'aura-lightning', kind: 'aura', emoji: '⚡', name: 'Lightning', desc: 'Electric bolts crackle round your seat, cards and profile', price: 3_000, days: 7 },
  { id: 'aura-aurora', kind: 'aura', emoji: '🌌', name: 'Aurora', desc: 'Northern lights flow inside your seat, cards and profile', price: 2_500, days: 7 },
  { id: 'aura-fire', kind: 'aura', emoji: '🔥', name: 'Inferno', desc: 'Flames lick round your seat, cards and profile', price: 3_000, days: 7 },
  { id: 'aura-galaxy', kind: 'aura', emoji: '✨', name: 'Galaxy', desc: 'Stars drift through your seat, cards and profile', price: 3_500, days: 7 },
  { id: 'aura-gold', kind: 'aura', emoji: '👑', name: 'Royal Gold', desc: 'A gold shine sweeps over your seat, cards and profile', price: 5_000, days: 7 },
  { id: 'win-fireworks', kind: 'win', emoji: '🎆', name: 'Fireworks', desc: 'Fireworks burst for everyone when you win', price: 1_500, days: 7 },
  { id: 'win-goldrain', kind: 'win', emoji: '💰', name: 'Gold rain', desc: 'Coins rain down for everyone when you win', price: 2_000, days: 7 },
  { id: 'win-thunder', kind: 'win', emoji: '🌩️', name: 'Thunder', desc: 'Lightning strikes the table when you win', price: 2_000, days: 7 },
  { id: 'entry-spotlight', kind: 'entry', emoji: '🔦', name: 'Spotlight', desc: 'A spotlight and your name when you join a table', price: 1_000, days: 7 },
  { id: 'entry-thunder', kind: 'entry', emoji: '⚡', name: 'Thunder entry', desc: 'A lightning flash and your name when you join a table', price: 1_500, days: 7 },
];

export const shopItemOf = (id: string | null | undefined) => SHOP_ITEMS.find((i) => i.id === id) ?? null;

/** Rank Shields one account can hold */
export const MAX_SHIELDS = 5;

/** a running rental */
export interface ShopRental {
  id: string;
  /** ISO time it runs out */
  until: string;
}

/** GET /api/me/shop and every shop change */
export interface ShopResponse {
  coins: number;
  /** rentals still running, soonest to end first */
  active: ShopRental[];
  /** what others see, from the active rentals; null when none is on */
  wearing: Record<ShopLookKind, string | null>;
  /** Rank Shields held, each used up by one ranked loss (missing from older servers) */
  shields?: number;
}

/** shop looks one player shows to others at a table (null: none on) */
export interface ShopLook {
  aura: string | null;
  win: string | null;
  entry: string | null;
}

// ---------- game replay: a finished game step by step (GET /api/me/games/:id/replay) ----------

/** steps kept per game; later moves overwrite the last step so the end still shows */
export const REPLAY_MAX_STEPS = 800;
/** a saved game keeps its replay this many days; then only the result stays */
export const REPLAY_KEEP_DAYS = 30;

/** one seat in a replay, in table order */
export interface ReplayPlayer {
  id: string;
  name: string;
  bot: boolean;
}

/** Bluff: the play on top of the pile (cards only when the room showed lies) */
export interface ReplayClaim {
  playerId: string;
  count: number;
  rank: Rank;
  /** the real cards; missing when the room kept lies secret */
  cards?: Card[];
  /** 🔒 under a Card Shield */
  shielded?: boolean;
}

/** one moment of the game: the start, then one per move */
export interface ReplayStep {
  /** what the table heard for this move */
  lines: string[];
  turnId: string | null;
  /** cards each player holds, in `players` order */
  counts: number[];
  pile: number;
  /** Bluff: the last claim still on the pile */
  claim?: ReplayClaim | null;
  /** Bluff: a bluff call in this step */
  call?: { callerId: string; playerId: string; caught: boolean } | null;
  /** Crazy 7: the face-up card */
  top?: Card | null;
  /** Rang: the face-up card and the colour to match */
  rangTop?: RangCard | null;
  rangColor?: RangColor | null;
}

/** a saved game's replay */
export interface GameReplay {
  game: GameKind;
  players: ReplayPlayer[];
  steps: ReplayStep[];
  /** Bluff plays carry their real cards */
  cards: boolean;
  /** some middle moves were not kept (very long game) */
  truncated?: boolean;
  /** Bluff: the Kismat rank, wild this game (it backs any claim) */
  wild?: Rank | null;
}

/** GET /api/me/games/:id/replay */
export interface ReplayResponse extends GameReplay {
  id: string;
  status: 'finished' | 'ended_early';
  startedAt: string;
  endedAt: string;
}

// ---------- private messages between friends ----------

/** longest message, after trimming */
export const DM_MAX_LENGTH = 300;
/** messages per history page */
export const DM_PAGE_SIZE = 50;

/** one private message; also the socket event `dm`, sent to both people's open apps */
export interface DirectMessage {
  id: string;
  from: string;
  to: string;
  text: string;
  /** ISO time sent */
  at: string;
  read: boolean;
}

/** GET /api/friends/:id/messages: oldest first */
export interface DmHistoryResponse {
  messages: DirectMessage[];
  /** older messages are left to load */
  more: boolean;
}

/** GET /api/friends/unread: messages I haven't read, from current friends */
export interface DmUnreadResponse {
  total: number;
  /** friend id → count; friends with none are left out */
  byFriend: Record<string, number>;
}

/** socket event `dm:read`, sent to both people: reader read everything the other sent them */
export interface DmReadEvent {
  reader: string;
  other: string;
}

// ---------- season pass: a free reward track for the ranked season now on, claimed tier by tier ----------

/** pass XP from one game that counts (both games), a win on top, and each daily or weekly mission it finished */
export const PASS_XP = { game: 20, win: 20, mission: 30 } as const;
/** pass XP for each tier */
export const PASS_TIER_XP = 100;
/** coins given instead of a Rank Shield tier when the player already holds MAX_SHIELDS */
export const PASS_SHIELD_COINS = 750;

/** one tier's reward: coins, bonus level XP, or one Rank Shield (amount 1) */
export interface PassReward {
  kind: 'coins' | 'xp' | 'shield';
  amount: number;
}

/** the track, tier 1 first: coins growing along it, some bonus XP, a shield every 5th tier and big coin prizes at 10, 20 and 30 */
export const PASS_TIERS: readonly PassReward[] = [
  { kind: 'coins', amount: 100 },
  { kind: 'coins', amount: 120 },
  { kind: 'xp', amount: 50 },
  { kind: 'coins', amount: 150 },
  { kind: 'shield', amount: 1 },
  { kind: 'coins', amount: 180 },
  { kind: 'coins', amount: 200 },
  { kind: 'xp', amount: 75 },
  { kind: 'coins', amount: 220 },
  { kind: 'coins', amount: 1_000 },
  { kind: 'coins', amount: 250 },
  { kind: 'coins', amount: 270 },
  { kind: 'xp', amount: 100 },
  { kind: 'coins', amount: 300 },
  { kind: 'shield', amount: 1 },
  { kind: 'coins', amount: 330 },
  { kind: 'coins', amount: 350 },
  { kind: 'xp', amount: 125 },
  { kind: 'coins', amount: 380 },
  { kind: 'coins', amount: 2_000 },
  { kind: 'coins', amount: 400 },
  { kind: 'coins', amount: 430 },
  { kind: 'xp', amount: 150 },
  { kind: 'coins', amount: 460 },
  { kind: 'shield', amount: 1 },
  { kind: 'coins', amount: 500 },
  { kind: 'coins', amount: 530 },
  { kind: 'xp', amount: 200 },
  { kind: 'coins', amount: 570 },
  { kind: 'coins', amount: 5_000 },
];

/** tiers reached with this much pass XP (0 to PASS_TIERS.length) */
export const passTierOf = (xp: number): number => Math.min(PASS_TIERS.length, Math.floor(Math.max(0, xp) / PASS_TIER_XP));

/** one tier on the track */
export interface PassTierView {
  /** 1 to PASS_TIERS.length */
  tier: number;
  reward: PassReward;
  reached: boolean;
  claimed: boolean;
}

/** GET /api/me/pass */
export interface PassResponse {
  /** the ranked season the pass runs for; a new season starts it again */
  season: number;
  /** ISO times the season started and the next one starts (null when not known or not booked) */
  startedAt: string | null;
  endsAt: string | null;
  /** pass XP this season */
  xp: number;
  /** tiers reached */
  tier: number;
  tiers: PassTierView[];
  /** reached tiers not claimed yet */
  claimable: number;
}

/** POST /api/me/pass/claim: the pass after the claim, what it gave (coins instead of a shield when they held MAX_SHIELDS), and the account */
export interface PassClaimResponse {
  pass: PassResponse;
  got: PassReward;
  /** a shield tier paid coins because they already held MAX_SHIELDS */
  shieldSwapped: boolean;
  user: PublicUser;
}

// ---- room chat: one message list per room, kept in memory while the room exists ----

/** messages a room keeps (the oldest go first) */
export const ROOM_CHAT_MAX = 500;
/** longest typed room message, in characters */
export const ROOM_CHAT_LENGTH = 200;

/** one line in a room's chat: typed, or a Quick Chat line */
export interface RoomMessage {
  id: number;
  /** sender's member id */
  from: string;
  /** sender's name when they sent it (kept after they leave) */
  name: string;
  /** sender's username, for muting; null for guests */
  username: string | null;
  text: string;
  /** ms since epoch */
  at: number;
  /** a Quick Chat line (also shown as the usual bubble) */
  quick: boolean;
}
