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
export type GameKind = 'bluff' | 'crazy7' | 'rang' | 'ludo' | 'snakes' | 'rmcs' | 'darts' | 'dots' | 'colorwar' | 'fruit' | 'spikes';

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
/** Rang: game time in minutes, the choices (config.rangTime); 0 = no limit */
export const RANG_TIMES = [0, 3, 5] as const;
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
  /** registry games (GAME_CATALOG options): each game's own settings by GameOptionSpec.id; parseConfig keeps known ids and choices only (older apps don't send it) */
  opts?: Record<string, string | number | boolean>;
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
  /** Rang: game time in minutes (0 = no limit); when it runs out everyone is ranked by the points they hold, fewest first (older apps don't send it: 0) */
  rangTime: 0 | 3 | 5;
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
  /** the +2/+4 cards that make up the penalty, oldest first (e.g. [2, 2, 4, 4] for 12) */
  chain: number[];
  /** game time on: ms left when this view was made; null with no limit */
  msLeft: number | null;
  /** the game ended because its time ran out */
  timedOut: boolean;
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
  /** 2v2: my partner's cards (only ever sent to their partner); null otherwise. Older servers don't send it */
  partner?: RangCard[] | null;
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

/** host's "get ready" buzz: once every this many ms (room:nudge → room:nudged to everyone not ready) */
export const NUDGE_COOLDOWN_MS = 10_000;

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

/** Ludo's own emoji and quick lines (Ludo tables use these instead of REACTIONS and QUICK_MESSAGES); spoken aloud at the table */
export const LUDO_REACTIONS = ['🎲', '🥺', '😈', '😭', '🙏', '🔥', '😂', '👏'] as const;
export const LUDO_QUICK_MESSAGES = [
  'Please mera goti mat kaato 🥺',
  "Please don't cut my goti 🥺",
  'Six de do bhagwan 🙏',
  'Bas ek six chahiye 🤞',
  'Chakka! 🎲',
  'Kaat diya! 😈',
  'Sorry, kaatna pada 😅',
  'Hehe, phir se kaat diya 😜',
  'Arre yaar, mera goti! 😭',
  'Dosti mein kaat diya? 💔',
  'Bach ke rehna 👀',
  'Agli baari tu gaya 😏',
  'Main safe hoon 😎',
  'Ghar pahunch gaya 🏠',
  'Bas ek ghar aur! 🏁',
  'Kya kismat hai! 🍀',
  'Jaldi roll karo ⏰',
  'Nice move! 👏',
  'Team up karein? 🤝',
  'Main jeet raha hoon 🏆',
  'GG 🎉',
  'Ek aur game! 🔁',
] as const;

/** how a spoken line should feel: the app bends pitch and speed to match */
export type VoiceMood = 'plead' | 'sad' | 'happy' | 'excited' | 'cheeky' | 'calm';
/** what the voice says for each LUDO_QUICK_MESSAGES line (same order): Hindi lines in Devanagari so a Hindi voice reads them naturally */
export const LUDO_QUICK_VOICE: readonly { say: string; lang: 'hi' | 'en'; mood: VoiceMood }[] = [
  { say: 'प्लीज़, मेरी गोटी मत काटो ना!', lang: 'hi', mood: 'plead' },
  { say: "Please don't cut my goti!", lang: 'en', mood: 'plead' },
  { say: 'छक्का दे दो भगवान!', lang: 'hi', mood: 'plead' },
  { say: 'बस एक छक्का चाहिए!', lang: 'hi', mood: 'plead' },
  { say: 'छक्का!', lang: 'hi', mood: 'excited' },
  { say: 'काट दिया!', lang: 'hi', mood: 'cheeky' },
  { say: 'सॉरी, काटना पड़ा!', lang: 'hi', mood: 'cheeky' },
  { say: 'हीहीही, फिर से काट दिया!', lang: 'hi', mood: 'cheeky' },
  { say: 'अरे यार, मेरी गोटी!', lang: 'hi', mood: 'sad' },
  { say: 'दोस्ती में काट दिया?', lang: 'hi', mood: 'sad' },
  { say: 'बच के रहना!', lang: 'hi', mood: 'cheeky' },
  { say: 'अगली बारी तू गया!', lang: 'hi', mood: 'cheeky' },
  { say: 'मैं सेफ़ हूँ!', lang: 'hi', mood: 'happy' },
  { say: 'घर पहुँच गया!', lang: 'hi', mood: 'excited' },
  { say: 'बस एक घर और!', lang: 'hi', mood: 'excited' },
  { say: 'क्या किस्मत है!', lang: 'hi', mood: 'happy' },
  { say: 'जल्दी रोल करो ना!', lang: 'hi', mood: 'calm' },
  { say: 'नाइस मूव!', lang: 'hi', mood: 'happy' },
  { say: 'टीम अप करें?', lang: 'hi', mood: 'calm' },
  { say: 'मैं जीत रहा हूँ!', lang: 'hi', mood: 'excited' },
  { say: 'जी जी! अच्छा खेले!', lang: 'hi', mood: 'happy' },
  { say: 'एक और गेम!', lang: 'hi', mood: 'excited' },
];

/** tables that use Ludo's emoji, quick lines and voice lines (Saanp Seedhi and Raja Mantri borrow them) */
const LUDO_CHAT_GAMES: readonly GameKind[] = ['ludo', 'snakes', 'rmcs', 'darts', 'dots', 'colorwar', 'fruit', 'spikes'];

/** the emoji and quick lines a table uses: Ludo's (also at Saanp Seedhi and Raja Mantri), every other game the shared ones */
export function chatSetOf(game: GameKind | undefined | null): { reactions: readonly string[]; messages: readonly string[] } {
  return game && LUDO_CHAT_GAMES.includes(game) ? { reactions: LUDO_REACTIONS, messages: LUDO_QUICK_MESSAGES } : { reactions: REACTIONS, messages: QUICK_MESSAGES };
}

/** quick lines are spoken aloud at these tables (no announcer there, so the voice is free) */
export const speaksQuickChat = (game: GameKind | undefined | null): boolean => !!game && LUDO_CHAT_GAMES.includes(game);

export type ChatKind = 'reaction' | 'message';

/** index points into the table's chatSetOf lists (REACTIONS / QUICK_MESSAGES, Ludo's own at a Ludo table), so no free text ever goes through the server */
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
  /** their Ludo looks: their gotis and dice show like this for everyone; the host's board is the table's (missing from older servers) */
  ludoLook?: LudoLookChoice;
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
  /** a registry game's table (Ludo and every game after it) while it's on, else null (missing from older servers) */
  plugged?: PluggedView | null;
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
  /** per game: played, won and the game's own counters, counted from Game Baithak on (older accounts: missing) */
  perGame?: Partial<Record<GameKind, GameTally>>;
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
  | 'rangWins'
  /** Ludo games finished and won, gotis knocked off, gotis home, sixes rolled */
  | 'ludoGames'
  | 'ludoWins'
  | 'ludoKills'
  | 'ludoHome'
  | 'ludoSixes';

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
  { id: 'd-ludogames2', period: 'daily', emoji: '🎲', title: 'Finish 2 games of Ludo', counter: 'ludoGames', goal: 2, coins: 150, xp: 30, social: false },
  { id: 'd-ludokills3', period: 'daily', emoji: '💥', title: 'Knock off 3 gotis in Ludo', counter: 'ludoKills', goal: 3, coins: 200, xp: 40, social: false },
  { id: 'd-ludosixes8', period: 'daily', emoji: '🎯', title: 'Roll 8 sixes in Ludo', counter: 'ludoSixes', goal: 8, coins: 150, xp: 30, social: false },
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
  { id: 'w-ludowins3', period: 'weekly', emoji: '🎲', title: 'Win 3 games of Ludo', counter: 'ludoWins', goal: 3, coins: 1_000, xp: 150, social: false },
  { id: 'w-ludohome20', period: 'weekly', emoji: '🏠', title: 'Bring 20 gotis home in Ludo', counter: 'ludoHome', goal: 20, coins: 1_000, xp: 150, social: false },
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

// ─── Game Baithak: the game catalog and registry games ───────────────────────────────

/** the app's name, shown on the splash, home and page titles */
export const APP_NAME = 'Game Baithak';

/** games built on the game registry (one folder per game on each side); Bluff, Crazy 7 and Rang are wired by hand */
export const PLUGGED_GAMES = ['ludo', 'snakes', 'rmcs', 'darts', 'dots', 'colorwar', 'fruit', 'spikes'] as const;
export type PluggedKind = (typeof PLUGGED_GAMES)[number];
export const isPlugged = (k: GameKind | undefined | null): k is PluggedKind => (PLUGGED_GAMES as readonly string[]).includes(k ?? '');

export type GameCategory = 'cards' | 'board' | 'party' | 'arcade';
export const GAME_CATEGORIES: { id: GameCategory; name: string; emoji: string }[] = [
  { id: 'cards', name: 'Cards', emoji: '🃏' },
  { id: 'board', name: 'Board', emoji: '🎲' },
  { id: 'party', name: 'Party', emoji: '🎉' },
  { id: 'arcade', name: 'Arcade', emoji: '🕹️' },
];

/** one setting a registry game shows in the lobby; the app draws it as a row of choices */
export interface GameOptionSpec {
  id: string;
  label: string;
  hint?: string;
  choices: { value: string | number | boolean; label: string; hint?: string }[];
  default: string | number | boolean;
  /** shown only while another option has this value */
  when?: { id: string; value: string | number | boolean };
}

/** a game in the catalog: the home grid, lobby picker and profile read it */
export interface GameInfo {
  kind: GameKind;
  name: string;
  emoji: string;
  tagline: string;
  category: GameCategory;
  minPlayers: number;
  maxPlayers: number;
  /** 2v2 partners possible */
  teams: boolean;
  bots: boolean;
  /** shows a NEW badge on the home grid */
  isNew?: boolean;
  /** tile colours: [from, to] */
  colors: [string, string];
  /** registry games only: lobby settings, stored in GameConfig.opts */
  options: GameOptionSpec[];
}

export const LUDO_MODES = ['classic', 'quick', 'timed', 'master'] as const;
export type LudoMode = (typeof LUDO_MODES)[number];
/** Ludo timed mode: minutes, the choices (opts.time) */
export const LUDO_TIMES = [5, 10] as const;

export const GAME_CATALOG: readonly GameInfo[] = [
  { kind: 'ludo', name: 'Ludo', emoji: '🎲', tagline: 'Roll, race and knock gotis home', category: 'board', minPlayers: 2, maxPlayers: 4, teams: true, bots: true, isNew: true, colors: ['#ff8a3d', '#c2185b'],
    options: [
      { id: 'mode', label: 'Mode', default: 'classic', choices: [
        { value: 'classic', label: 'Classic', hint: 'All 4 gotis home. A 6 opens a goti' },
        { value: 'quick', label: 'Quick', hint: 'Gotis start open. 2 home wins' },
        { value: 'timed', label: 'Timed', hint: 'Most points when time runs out' },
        { value: 'master', label: 'Master', hint: 'No way home before your first kill' },
      ] },
      { id: 'time', label: 'Time', default: 5, when: { id: 'mode', value: 'timed' }, choices: [{ value: 5, label: '5 min' }, { value: 10, label: '10 min' }] },
    ] },
  { kind: 'snakes', name: 'Saanp Seedhi', emoji: '🐍', tagline: 'Climb the ladders, dodge the snakes', category: 'board', minPlayers: 2, maxPlayers: 4, teams: false, bots: true, isNew: true, colors: ['#43a047', '#f9a825'],
    options: [
      { id: 'exact', label: 'Finish', default: true, choices: [{ value: true, label: 'Exact roll', hint: 'Land on 100 exactly or bounce back' }, { value: false, label: 'Any roll', hint: 'Reach 100 or more' }] },
      { id: 'six', label: 'Start', default: true, choices: [{ value: true, label: 'Need a 6', hint: 'Roll a 6 to step onto the board' }, { value: false, label: 'Go straight', hint: 'Start moving from the first roll' }] },
      { id: 'bonus', label: 'Sixes', default: true, choices: [{ value: true, label: 'Roll again', hint: 'A 6 gives another roll; three 6s lose the turn' }, { value: false, label: 'One roll', hint: 'One roll a turn' }] },
      { id: 'bite', label: 'Bite', default: true, choices: [{ value: true, label: 'On', hint: 'Land on a player and send them back 5' }, { value: false, label: 'Off', hint: 'Players can share a square' }] },
    ] },
  { kind: 'rmcs', name: 'Raja Mantri Chor Sipahi', emoji: '👑', tagline: 'Find the Chor before he gets away', category: 'party', minPlayers: 4, maxPlayers: 4, teams: false, bots: true, isNew: true, colors: ['#8e24aa', '#ff7043'],
    options: [{ id: 'rounds', label: 'Rounds', default: 5, choices: [{ value: 5, label: '5 rounds' }, { value: 10, label: '10 rounds' }] }] },
  { kind: 'spikes', name: 'Spike Attack', emoji: '🔺', tagline: 'Dodge the spikes, keep your 3 lives', category: 'arcade', minPlayers: 2, maxPlayers: 4, teams: false, bots: true, isNew: true, colors: ['#ff1744', '#651fff'],
    options: [
      { id: 'size', label: 'Arena', default: 5, choices: [{ value: 5, label: '5 × 5' }, { value: 6, label: '6 × 6' }] },
      { id: 'speed', label: 'Speed', default: 'normal', choices: [{ value: 'normal', label: 'Normal', hint: '3 second warnings to start' }, { value: 'fast', label: 'Fast', hint: '2 second warnings to start' }] },
    ] },
  { kind: 'fruit', name: 'Fruit Slice Duel', emoji: '🍉', tagline: 'Fastest sword takes the fruit. Never cut the magnet!', category: 'arcade', minPlayers: 2, maxPlayers: 4, teams: false, bots: true, isNew: true, colors: ['#ff5252', '#00c853'],
    options: [{ id: 'rounds', label: 'Rounds', default: 15, choices: [{ value: 15, label: '15 items' }, { value: 25, label: '25 items' }] }] },
  { kind: 'darts', name: 'Darts', emoji: '🎯', tagline: 'Count down from 301, land exactly on zero', category: 'arcade', minPlayers: 2, maxPlayers: 4, teams: false, bots: true, isNew: true, colors: ['#263238', '#d32f2f'],
    options: [{ id: 'start', label: 'Start at', default: 301, choices: [{ value: 301, label: '301' }, { value: 501, label: '501' }] }] },
  { kind: 'colorwar', name: 'Colour Wars', emoji: '🎨', tagline: 'Grow dots, burst and take over the board', category: 'board', minPlayers: 2, maxPlayers: 4, teams: false, bots: true, isNew: true, colors: ['#00b0ff', '#ff4081'],
    options: [{ id: 'size', label: 'Board', default: 5, choices: [{ value: 5, label: '5 × 5' }, { value: 7, label: '7 × 7' }] }] },
  { kind: 'dots', name: 'Dots and Boxes', emoji: '⬛', tagline: 'Draw lines, close boxes, steal the board', category: 'board', minPlayers: 2, maxPlayers: 4, teams: false, bots: true, isNew: true, colors: ['#3949ab', '#26c6da'],
    options: [{ id: 'size', label: 'Board', default: 5, choices: [{ value: 4, label: '4 × 4' }, { value: 5, label: '5 × 5' }, { value: 6, label: '6 × 6' }] }] },
  { kind: 'bluff', name: 'Bluff', emoji: '🃏', tagline: 'Lie with a straight face, catch the liars', category: 'cards', minPlayers: 2, maxPlayers: 8, teams: true, bots: true, colors: ['#2e7d32', '#004d40'], options: [] },
  { kind: 'crazy7', name: 'Crazy 7', emoji: '7️⃣', tagline: 'Match suit or number, 7s make them pick', category: 'cards', minPlayers: 2, maxPlayers: 8, teams: false, bots: true, colors: ['#6a1b9a', '#283593'], options: [] },
  { kind: 'rang', name: 'Rang', emoji: '🌈', tagline: 'Colour cards, wilds and +4s', category: 'cards', minPlayers: 2, maxPlayers: 8, teams: true, bots: true, colors: ['#e53935', '#1e88e5'], options: [] },
];

export const gameInfo = (k: GameKind | undefined | null): GameInfo => GAME_CATALOG.find((g) => g.kind === (k ?? 'bluff')) ?? GAME_CATALOG.find((g) => g.kind === 'bluff')!;

/** a registry game's option, or its default when unset or not one of its choices */
export function gameOpt<T extends string | number | boolean>(config: Pick<GameConfig, 'game' | 'opts'>, id: string): T {
  const spec = gameInfo(config.game).options.find((o) => o.id === id);
  const v = config.opts?.[id];
  if (spec && spec.choices.some((c) => c.value === v)) return v as T;
  return (spec?.default ?? v) as T;
}

/** a registry game's table, by game; every new registry game adds a variant */
export type PluggedView =
  | { kind: 'ludo'; ludo: LudoView }
  | { kind: 'snakes'; snakes: SnakesView }
  | { kind: 'rmcs'; rmcs: RmcsView }
  | { kind: 'darts'; darts: DartsView }
  | { kind: 'dots'; dots: DotsView }
  | { kind: 'colorwar'; colorwar: ColorWarView }
  | { kind: 'fruit'; fruit: FruitView }
  | { kind: 'spikes'; spikes: SpikesView };

/** a registry game's move, sent with game:move */
export type PluggedMove =
  | { kind: 'ludo'; move: LudoMoveInput }
  | { kind: 'snakes'; move: SnakesMoveInput }
  | { kind: 'rmcs'; move: RmcsMoveInput }
  | { kind: 'darts'; move: DartsMoveInput }
  | { kind: 'dots'; move: DotsMoveInput }
  | { kind: 'colorwar'; move: ColorWarMoveInput }
  | { kind: 'fruit'; move: FruitMoveInput }
  | { kind: 'spikes'; move: SpikesMoveInput };

/** per-account numbers for one game (stats.perGame[kind]); counters are the game's own (Ludo: kills, home, sixes, killed) */
export type GameTally = { played: number; wins: number } & Partial<Record<string, number>>;

// ─── Ludo ──────────────────────────────────────────────────────────────────────────────

/** goti colours in turn order, clockwise from the top left */
export const LUDO_COLORS = ['red', 'green', 'yellow', 'blue'] as const;
export type LudoColor = (typeof LUDO_COLORS)[number];
export const LUDO_COLOR_HEX: Record<LudoColor, string> = { red: '#e53935', green: '#43a047', yellow: '#fdd835', blue: '#1e88e5' };
/** the colours used for 2, 3 and 4 players (2 sit opposite) */
export const LUDO_SEAT_COLORS: Record<2 | 3 | 4, LudoColor[]> = { 2: ['red', 'yellow'], 3: ['red', 'green', 'yellow'], 4: ['red', 'green', 'yellow', 'blue'] };

/** squares on the shared ring */
export const LUDO_RING = 52;
/** a goti's progress: -1 in its base, 0..50 on the ring from its own start square, 51..55 its home lane, 56 home */
export const LUDO_BASE = -1;
export const LUDO_LAST_RING = 50;
export const LUDO_HOME = 56;
export const LUDO_TOKENS = 4;
/** Quick mode: gotis home to win */
export const LUDO_QUICK_HOME = 2;
/** ring squares nobody can be knocked off: each colour's start and the star 8 squares on */
export const LUDO_SAFE_RING = [0, 8, 13, 21, 26, 34, 39, 47] as const;
/** Timed mode points: each square moved, a kill, a goti home; a goti knocked off loses the squares it had moved */
export const LUDO_POINTS = { step: 1, kill: 20, home: 15 } as const;

/** where each colour's start square sits on the ring */
export const ludoStartOf = (c: LudoColor): number => LUDO_COLORS.indexOf(c) * 13;
/** ring square of a goti on the ring, else null (base, lane, home) */
export const ludoRingOf = (c: LudoColor, progress: number): number | null =>
  progress >= 0 && progress <= LUDO_LAST_RING ? (ludoStartOf(c) + progress) % LUDO_RING : null;
export const ludoIsSafe = (ring: number): boolean => (LUDO_SAFE_RING as readonly number[]).includes(ring);

/** the 15×15 board: [col, row], row 0 at the top. The ring, starting at red's start square */
export const LUDO_RING_CELLS: readonly [number, number][] = [
  [1, 6], [2, 6], [3, 6], [4, 6], [5, 6],
  [6, 5], [6, 4], [6, 3], [6, 2], [6, 1], [6, 0],
  [7, 0],
  [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5],
  [9, 6], [10, 6], [11, 6], [12, 6], [13, 6], [14, 6],
  [14, 7],
  [14, 8], [13, 8], [12, 8], [11, 8], [10, 8], [9, 8],
  [8, 9], [8, 10], [8, 11], [8, 12], [8, 13], [8, 14],
  [7, 14],
  [6, 14], [6, 13], [6, 12], [6, 11], [6, 10], [6, 9],
  [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8],
  [0, 7],
  [0, 6],
];
/** each colour's home lane, squares 51..55 */
export const LUDO_LANE_CELLS: Record<LudoColor, readonly [number, number][]> = {
  red: [[1, 7], [2, 7], [3, 7], [4, 7], [5, 7]],
  green: [[7, 1], [7, 2], [7, 3], [7, 4], [7, 5]],
  yellow: [[13, 7], [12, 7], [11, 7], [10, 7], [9, 7]],
  blue: [[7, 13], [7, 12], [7, 11], [7, 10], [7, 9]],
};
/** the four spots in each base (centres, so halves) */
export const LUDO_BASE_CELLS: Record<LudoColor, readonly [number, number][]> = {
  red: [[1.5, 1.5], [3.5, 1.5], [1.5, 3.5], [3.5, 3.5]],
  green: [[10.5, 1.5], [12.5, 1.5], [10.5, 3.5], [12.5, 3.5]],
  yellow: [[10.5, 10.5], [12.5, 10.5], [10.5, 12.5], [12.5, 12.5]],
  blue: [[1.5, 10.5], [3.5, 10.5], [1.5, 12.5], [3.5, 12.5]],
};
/** home: the centre triangle of each colour (centre point) */
export const LUDO_HOME_CELLS: Record<LudoColor, [number, number]> = { red: [6.4, 7], green: [7, 6.4], yellow: [7.6, 7], blue: [7, 7.6] };

/** the board square ([col, row], cell centre at +0.5) of a goti; token picks its base spot */
export function ludoCellOf(c: LudoColor, progress: number, token = 0): [number, number] {
  if (progress <= LUDO_BASE) {
    const [x, y] = LUDO_BASE_CELLS[c][token % LUDO_TOKENS];
    return [x - 0.5, y - 0.5];
  }
  if (progress <= LUDO_LAST_RING) return [...LUDO_RING_CELLS[ludoRingOf(c, progress)!]] as [number, number];
  if (progress < LUDO_HOME) return [...LUDO_LANE_CELLS[c][progress - LUDO_LAST_RING - 1]] as [number, number];
  const [x, y] = LUDO_HOME_CELLS[c];
  return [x - 0.5, y - 0.5];
}

/** the squares a goti passes through from one progress to the next, for a hop-by-hop animation (excludes from, includes to); a goti leaving base goes straight to its start */
export function ludoPath(c: LudoColor, from: number, to: number): [number, number][] {
  if (from <= LUDO_BASE) return [ludoCellOf(c, 0)];
  const out: [number, number][] = [];
  for (let p = from + 1; p <= to; p++) out.push(ludoCellOf(c, p));
  return out;
}

export interface LudoSeat {
  playerId: string;
  color: LudoColor;
  /** progress of each of the 4 gotis (see LUDO_BASE / LUDO_HOME) */
  tokens: number[];
  kills: number;
  /** gotis home */
  home: number;
  /** finishing place once out, else null */
  place: number | null;
  /** Timed mode: points so far; 0 in the other modes */
  score: number;
  /** Master mode: has made a kill, so the home lane is open */
  unlocked: boolean;
}

/** what a player does on their turn: roll, or move a goti by the roll */
export type LudoMoveInput = { type: 'roll' } | { type: 'move'; token: number };

/** one goti move, for animation and the announcer; seq goes up by one each move */
export interface LudoLastMove {
  seq: number;
  playerId: string;
  color: LudoColor;
  token: number;
  from: number;
  to: number;
  roll: number;
  /** gotis knocked back to base by this move */
  captured: { playerId: string; color: LudoColor; token: number; from: number }[];
  /** the goti reached home */
  home: boolean;
  /** the move earned another roll (6, kill or home) */
  bonus: boolean;
}

/** the Ludo table as one seat sees it (Ludo has no secrets: everyone sees the same) */
export interface LudoView {
  mode: LudoMode;
  seats: LudoSeat[];
  turnId: string | null;
  /** the turn's dice: the last roll shown, null before the first roll of a turn */
  dice: number | null;
  /** goes up with every roll, so the app rolls the dice again even for the same number */
  rollSeq: number;
  /** the player on turn has rolled and must pick a goti */
  rolled: boolean;
  /** gotis the player on turn may move with this roll (empty before rolling) */
  movable: number[];
  /** sixes rolled in a row this turn (3 loses the turn) */
  sixes: number;
  /** whose gotis the turn player moves: their own, or their partner's once all of theirs are home (2v2) */
  movesFor: string | null;
  last: LudoLastMove | null;
  /** Timed mode: when the game ends (ms since epoch); null otherwise */
  endsAt: number | null;
  /** 2v2: partners (red+yellow vs green+blue), else null */
  teams: [string[], string[]] | null;
  /** every kill so far, oldest first, for the game-over kill recap */
  kills: { by: string; victim: string; at: number }[];
}

/** Ludo stats counters kept per account in stats.perGame.ludo */
export const LUDO_TALLIES = ['kills', 'killed', 'home', 'sixes'] as const;

// ─── Ludo looks (shared by both apps, so everyone sees the same thing) ───────────────────

/** a Ludo look: unlocked at a level; both apps draw every id */
export interface LudoLookDef {
  id: string;
  name: string;
  emoji: string;
  level: number;
}
/** boards: the host's board is the table's board for everyone */
export const LUDO_BOARD_LOOKS: readonly LudoLookDef[] = [
  { id: 'classic', name: 'Classic', emoji: '🎲', level: 1 },
  { id: 'wood', name: 'Sheesham', emoji: '🪵', level: 3 },
  { id: 'neon', name: 'Neon', emoji: '💡', level: 6 },
  { id: 'night', name: 'Raat', emoji: '🌙', level: 8 },
  { id: 'royal', name: 'Mahal', emoji: '👑', level: 10 },
];
/** goti styles: each player's own gotis, seen by everyone */
export const LUDO_GOTI_LOOKS: readonly LudoLookDef[] = [
  { id: 'glossy', name: 'Glossy', emoji: '♟️', level: 1 },
  { id: 'marble', name: 'Marble', emoji: '🔮', level: 4 },
  { id: 'gem', name: 'Gem', emoji: '💎', level: 8 },
  { id: 'metal', name: 'Metal', emoji: '🥇', level: 12 },
  { id: 'crown', name: 'Raja', emoji: '👑', level: 18 },
];
/** dice skins: the dice shows the skin of the player whose turn it is */
export const LUDO_DICE_LOOKS: readonly LudoLookDef[] = [
  { id: 'ivory', name: 'Ivory', emoji: '🎲', level: 1 },
  { id: 'ruby', name: 'Ruby', emoji: '♦️', level: 2 },
  { id: 'neon', name: 'Neon', emoji: '💡', level: 5 },
  { id: 'gold', name: 'Sona', emoji: '✨', level: 7 },
  { id: 'jade', name: 'Jade', emoji: '🟢', level: 10 },
];
export type LudoLookKind = 'board' | 'goti' | 'dice';
export const LUDO_LOOKS: Record<LudoLookKind, readonly LudoLookDef[]> = { board: LUDO_BOARD_LOOKS, goti: LUDO_GOTI_LOOKS, dice: LUDO_DICE_LOOKS };
export interface LudoLookChoice {
  board: string;
  goti: string;
  dice: string;
}
export const DEFAULT_LUDO_LOOK: LudoLookChoice = { board: 'classic', goti: 'glossy', dice: 'ivory' };

/** a look id kept only when it exists and the level unlocks it, else the first (free) one */
export function ludoLookOk(kind: LudoLookKind, id: unknown, level: number): string {
  const list = LUDO_LOOKS[kind];
  return (list.find((l) => l.id === id && l.level <= level) ?? list[0]).id;
}

// ─── Saanp Seedhi (snakes and ladders) ───────────────────────────────────────────────────

/** squares 1..100 on a 10×10 board; square 1 bottom-left, rows snake back and forth, 100 top-left */
export const SNAKES_GOAL = 100;
/** snake heads → tails (our own layout) */
export const SNAKES: Readonly<Record<number, number>> = { 17: 7, 54: 34, 62: 19, 64: 60, 87: 36, 93: 73, 95: 75, 98: 79 };
/** ladder feet → tops (our own layout) */
export const LADDERS: Readonly<Record<number, number>> = { 2: 38, 4: 14, 9: 31, 21: 42, 28: 84, 51: 67, 72: 91, 80: 99 };
/** squares a bitten player falls back (bite rule) */
export const SNAKES_BITE_BACK = 5;
/** player colours in seat order */
export const SNAKES_COLORS = ['red', 'blue', 'green', 'yellow'] as const;
export type SnakesColor = (typeof SNAKES_COLORS)[number];

/** [col, row] of a square on the 10×10 board, row 0 at the top (0 = off the board: null) */
export function snakesCellOf(square: number): [number, number] | null {
  if (square < 1 || square > SNAKES_GOAL) return null;
  const i = square - 1;
  const rowFromBottom = Math.floor(i / 10);
  const inRow = i % 10;
  const col = rowFromBottom % 2 === 0 ? inRow : 9 - inRow;
  return [col, 9 - rowFromBottom];
}

export interface SnakesSeat {
  playerId: string;
  color: SnakesColor;
  /** 0 = not on the board yet, 1..100 */
  pos: number;
  /** finishing place once at 100, else null */
  place: number | null;
  ladders: number;
  snakes: number;
  bites: number;
}

/** one turn's movement, for animation: step from → landed, then slide along a snake or ladder to → to */
export interface SnakesLastMove {
  seq: number;
  playerId: string;
  roll: number;
  from: number;
  /** where the dice count ended (after any bounce off 100) */
  landed: number;
  /** final square after a snake or ladder */
  to: number;
  /** rolled past 100 with the exact rule: walked to 100 and back */
  bounced: boolean;
  via: { kind: 'snake' | 'ladder'; from: number; to: number } | null;
  /** players this move bit, sent back SNAKES_BITE_BACK squares (bite rule) */
  bitten: { playerId: string; from: number; to: number }[];
  /** the move earned another roll (a 6 with the bonus rule) */
  bonus: boolean;
}

export interface SnakesView {
  seats: SnakesSeat[];
  turnId: string | null;
  dice: number | null;
  /** goes up with every roll, so the app rolls the dice again even for the same number */
  rollSeq: number;
  /** sixes rolled in a row this turn (3 lose the turn with the bonus rule) */
  sixes: number;
  last: SnakesLastMove | null;
  rules: { exact: boolean; six: boolean; bonus: boolean; bite: boolean };
}

/** Saanp Seedhi has one move: roll (the token moves by itself) */
export type SnakesMoveInput = { type: 'roll' };

// ─── Raja Mantri Chor Sipahi ──────────────────────────────────────────────────────────────

export const RMCS_ROLES = ['raja', 'mantri', 'chor', 'sipahi'] as const;
export type RmcsRole = (typeof RMCS_ROLES)[number];
/** points on each chit; a wrong guess swaps the Mantri's and the Chor's points for that round */
export const RMCS_POINTS: Record<RmcsRole, number> = { raja: 1000, mantri: 800, sipahi: 500, chor: 0 };
export const RMCS_NAMES: Record<RmcsRole, string> = { raja: 'Raja', mantri: 'Mantri', chor: 'Chor', sipahi: 'Sipahi' };
export const RMCS_EMOJI: Record<RmcsRole, string> = { raja: '👑', mantri: '🧐', chor: '🦹', sipahi: '👮' };
/** seconds people get to open their chit before it opens by itself */
export const RMCS_OPEN_SEC = 8;

/**
 * a round: 'open' — everyone opens their chit (each sees only their own; the Raja shows himself);
 * 'guess' — the Mantri points at one of the two others as the Chor;
 * 'result' — every chit is shown and points added; the next round starts by itself
 */
export type RmcsPhase = 'open' | 'guess' | 'result';

export interface RmcsRound {
  round: number;
  roles: Record<string, RmcsRole>;
  /** who the Mantri pointed at; null if time ran out (counts as wrong) */
  guess: string | null;
  correct: boolean;
  /** points each player got this round */
  points: Record<string, number>;
}

export interface RmcsView {
  /** 1-based round number, and how many in the game */
  round: number;
  rounds: number;
  phase: RmcsPhase;
  /** my own chit this round (null for watchers until result) */
  myRole: RmcsRole | null;
  /** chits everyone can see: the Raja once opened, the Mantri once guessing starts, every chit at result */
  shown: Record<string, RmcsRole>;
  /** who has opened their chit */
  opened: string[];
  /** when the open or guess step ends by itself (ms since epoch) */
  endsAt: number | null;
  /** totals so far */
  scores: Record<string, number>;
  /** the round just finished (result phase and after), newest last */
  history: RmcsRound[];
}

/** open my chit; the Mantri guesses who the Chor is */
export type RmcsMoveInput = { type: 'open' } | { type: 'guess'; target: string };

// ─── shared by the arcade and board party games ───────────────────────────────────────────

/** player colours in seat order (Dots and Boxes, Colour Wars, Fruit, Spikes, Darts) */
export const PARTY_COLORS = ['#ff5252', '#40c4ff', '#69f0ae', '#ffd740'] as const;

// ─── Darts (301 / 501 countdown) ──────────────────────────────────────────────────────────

/** numbers round the board, clockwise from the top */
export const DART_NUMBERS = [20, 1, 18, 4, 13, 6, 10, 15, 2, 17, 3, 19, 7, 16, 8, 11, 14, 9, 12, 5] as const;
/** ring radii as a share of the board's scoring radius (1 = outer edge of the double ring); arcade-wide so 2x and 3x can be hit on a phone */
export const DART_RINGS = { bull: 0.07, outerBull: 0.16, trebleIn: 0.5, trebleOut: 0.64, doubleIn: 0.86, doubleOut: 1 } as const;
export const DARTS_PER_TURN = 3;

export type DartRing = 'bull' | 'outerBull' | 'single' | 'treble' | 'double' | 'miss';
/** what a dart at (x, y) scores; x right, y up, board centre (0,0), scoring radius 1 */
export function dartScore(x: number, y: number): { ring: DartRing; number: number; score: number } {
  const r = Math.hypot(x, y);
  if (r <= DART_RINGS.bull) return { ring: 'bull', number: 25, score: 50 };
  if (r <= DART_RINGS.outerBull) return { ring: 'outerBull', number: 25, score: 25 };
  if (r > DART_RINGS.doubleOut) return { ring: 'miss', number: 0, score: 0 };
  // angle clockwise from straight up; each number spans 18°, 20 centred on the top
  const deg = ((Math.atan2(x, y) * 180) / Math.PI + 360 + 9) % 360;
  const number = DART_NUMBERS[Math.floor(deg / 18)];
  if (r >= DART_RINGS.doubleIn) return { ring: 'double', number, score: number * 2 };
  if (r >= DART_RINGS.trebleIn && r <= DART_RINGS.trebleOut) return { ring: 'treble', number, score: number * 3 };
  return { ring: 'single', number, score: number };
}

export interface DartThrow {
  seq: number;
  playerId: string;
  /** where it landed (after the hand's shake), board units */
  x: number;
  y: number;
  ring: DartRing;
  number: number;
  score: number;
  /** 1..3 in the turn */
  dart: number;
  /** went below 0: the turn's darts don't count and the turn ends */
  bust: boolean;
}

export interface DartsView {
  start: 301 | 501;
  /** points left per player */
  left: Record<string, number>;
  turnId: string | null;
  /** darts thrown this turn so far */
  thrown: DartThrow[];
  /** points left when this turn began (a bust goes back to it) */
  turnStart: number;
  last: DartThrow | null;
  /** finishing order so far */
  places: Record<string, number>;
}

/** aim at (x, y) in board units where the wobbling reticle was released; the server adds a small shake */
export type DartsMoveInput = { type: 'throw'; x: number; y: number };

// ─── Dots and Boxes ───────────────────────────────────────────────────────────────────────

/**
 * a board of size×size boxes has (size+1)×(size+1) dots. Lines are numbered: first the horizontal ones,
 * row by row ((size+1) rows of size), then the vertical ones (size rows of size+1)
 */
export const dotsLineCount = (size: number): number => 2 * size * (size + 1);
export function dotsLineAt(size: number, line: number): { dir: 'h' | 'v'; row: number; col: number } {
  const h = size * (size + 1);
  if (line < h) return { dir: 'h', row: Math.floor(line / size), col: line % size };
  const v = line - h;
  return { dir: 'v', row: Math.floor(v / (size + 1)), col: v % (size + 1) };
}
/** the four lines round box (row, col) */
export function dotsBoxLines(size: number, row: number, col: number): [number, number, number, number] {
  const h = size * (size + 1);
  return [row * size + col, (row + 1) * size + col, h + row * (size + 1) + col, h + row * (size + 1) + col + 1];
}
/** boxes (row * size + col) that a line borders */
export function dotsBoxesOf(size: number, line: number): number[] {
  const { dir, row, col } = dotsLineAt(size, line);
  const out: number[] = [];
  if (dir === 'h') {
    if (row > 0) out.push((row - 1) * size + col);
    if (row < size) out.push(row * size + col);
  } else {
    if (col > 0) out.push(row * size + col - 1);
    if (col < size) out.push(row * size + col);
  }
  return out;
}

export interface DotsView {
  size: number;
  /** line → player who drew it */
  lines: Record<number, string>;
  /** box → player who closed it */
  boxes: Record<number, string>;
  scores: Record<string, number>;
  turnId: string | null;
  /** the last line, and boxes it closed (closing a box gives another turn) */
  last: { seq: number; playerId: string; line: number; closed: number[] } | null;
}
export type DotsMoveInput = { type: 'line'; line: number };

// ─── Colour Wars ──────────────────────────────────────────────────────────────────────────

/** a cell bursts at this many dots: it empties and gives one dot (and its colour) to each neighbour */
export const COLORWAR_BURST = 4;
/** your first move places this many dots on any empty cell */
export const COLORWAR_FIRST = 3;

export interface ColorWarCell {
  owner: string | null;
  dots: number;
}
export interface ColorWarView {
  size: number;
  /** row-major, size × size */
  cells: ColorWarCell[];
  turnId: string | null;
  /** players who still need their first move (it places COLORWAR_FIRST dots on an empty cell) */
  firstMove: string[];
  /** still in the game; out once they hold no cell after their first move */
  alive: string[];
  /** the last tap and its chain, wave by wave (cells that burst in each wave), for the animation */
  last: { seq: number; playerId: string; cell: number; waves: number[][] } | null;
  /** finishing order (out first = last place) */
  places: Record<string, number>;
}
export type ColorWarMoveInput = { type: 'tap'; cell: number };

// ─── Fruit Slice Duel ─────────────────────────────────────────────────────────────────────

export const FRUIT_KINDS = ['apple', 'orange', 'melon', 'banana', 'mango', 'grapes', 'bomb'] as const;
export type FruitKind = (typeof FRUIT_KINDS)[number];
export const FRUIT_POINTS: Record<FruitKind, number> = { apple: 1, orange: 1, banana: 1, grapes: 2, mango: 2, melon: 3, bomb: -10 };
/** the play area: x 0..1 left to right, y 0..1 bottom to top; fruit fly up from below and fall back */
export const FRUIT_GRAVITY = -1.6;
/** a slice counts within this much of where the fruit really was (ms), for network lag */
export const FRUIT_SLICE_SLACK_MS = 450;

export interface FruitSpawn {
  id: number;
  kind: FruitKind;
  /** ms after the start when it's thrown in */
  t: number;
  x0: number;
  vx: number;
  vy: number;
}

/** a small seeded random (mulberry32), so every phone and the server throw exactly the same fruit */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** the whole wave for a game: same seed, same fruit for everyone; it gets busier as time goes on */
export function fruitWave(seed: number, seconds: number): FruitSpawn[] {
  const rnd = seededRandom(seed);
  const out: FruitSpawn[] = [];
  let t = 800;
  let id = 1;
  const end = seconds * 1000 - 1500;
  while (t < end) {
    const busy = t / end;
    const burst = 1 + Math.floor(rnd() * (1 + busy * 3));
    for (let i = 0; i < burst; i++) {
      const bomb = rnd() < 0.08 + busy * 0.07;
      const kind: FruitKind = bomb ? 'bomb' : FRUIT_KINDS[Math.floor(rnd() * (FRUIT_KINDS.length - 1))];
      const x0 = 0.15 + rnd() * 0.7;
      out.push({ id: id++, kind, t: t + i * 120, x0, vx: (0.5 - x0) * (0.3 + rnd() * 0.4), vy: 1.45 + rnd() * 0.3 });
    }
    t += 900 - busy * 450 + rnd() * 400;
  }
  return out;
}

/** where a fruit is ms after the start; null before it's thrown or once it falls off the bottom */
export function fruitAt(f: FruitSpawn, ms: number): { x: number; y: number } | null {
  const s = (ms - f.t) / 1000;
  if (s < 0) return null;
  const y = -0.1 + f.vy * s + (FRUIT_GRAVITY * s * s) / 2;
  if (y < -0.15 && s > 0.2) return null;
  return { x: f.x0 + f.vx * s, y };
}

/** Fruit Slice Duel (reaction duel): one item at a time pops up in the middle; everyone has a sword and one Strike button */
export type FruitItemKind = Exclude<FruitKind, 'bomb'> | 'magnet';
/** striking a magnet slows your sword for this many next items */
export const FRUIT_MAGNET_ROUNDS = 2;
/** a slowed sword adds this much to your reaction time */
export const FRUIT_SLOW_MS = 350;
/** reactions faster than this are not human: refused */
export const FRUIT_MIN_REACTION_MS = 110;
/** after the first strike, the server waits this long for slower phones' strikes before naming the winner */
export const FRUIT_COLLECT_MS = 700;
/** an item stays up at most this long; nobody strikes = nobody scores */
export const FRUIT_ITEM_MS = 2500;
/** points for winning each fruit */
export const FRUIT_ITEM_POINTS: Record<Exclude<FruitItemKind, 'magnet'>, number> = { apple: 1, orange: 1, banana: 1, grapes: 2, mango: 2, melon: 3 };

export interface FruitView {
  phase: 'countdown' | 'play' | 'over';
  /** 1-based item number and how many in the game */
  round: number;
  rounds: number;
  /** the item up now (null between items); shownAt is server time — each phone measures reaction from when IT drew the item */
  item: { round: number; kind: FruitItemKind; shownAt: number } | null;
  /** the last item's result: who won it (fastest reaction on a fruit), everyone's reaction (null = no strike), who got slowed by a magnet */
  result: { round: number; kind: FruitItemKind; winner: string | null; reactions: Record<string, number | null>; slowed: string[] } | null;
  scores: Record<string, number>;
  /** items each player's sword stays slow for (magnet) */
  slow: Record<string, number>;
  startsAt: number;
  /** server time when this view was made, so the app can line up its clock */
  now: number;
}
/** strike at item `round`; reaction = ms from when the item appeared on this phone's screen to the tap */
export type FruitMoveInput = { type: 'strike'; round: number; reaction: number };

// ─── Spike Attack ─────────────────────────────────────────────────────────────────────────

export const SPIKES_LIVES = 3;
export type SpikeDir = 'left' | 'right' | 'top' | 'bottom';
/** a spike on the way: it shoots in from `dir` along row (left/right) or column (top/bottom) `line`, right across to the far side */
export interface SpikeWarning {
  id: number;
  dir: SpikeDir;
  line: number;
  /** when the warning showed and when the spike strikes (ms since epoch, server clock) */
  warnAt: number;
  strikeAt: number;
}
/** Spike Attack movement: free, in arena units (the arena is size × size, a player is a circle) */
export const SPIKES_SPEED = 3.2;
export const SPIKES_RADIUS = 0.32;
export interface SpikesView {
  size: number;
  phase: 'countdown' | 'play' | 'over';
  startsAt: number;
  /** each player's centre [x, y] in arena units (0..size), y 0 at the top; a spike on row r hits anyone whose circle overlaps r..r+1 */
  pos: Record<string, [number, number]>;
  lives: Record<string, number>;
  /** players hit just now can't be hit again until this time (ms since epoch) */
  safeUntil: Record<string, number>;
  warnings: SpikeWarning[];
  /** recent strikes, for the animation: who they hit */
  strikes: { id: number; dir: SpikeDir; line: number; at: number; hit: string[] }[];
  /** finishing order (out first = last place) */
  places: Record<string, number>;
  /** server time when this view was made, so the app can line up its clock */
  now: number;
}
/** where my character is now (sent about 12 times a second while moving); the server checks it against SPIKES_SPEED */
export type SpikesMoveInput = { type: 'move'; x: number; y: number };
