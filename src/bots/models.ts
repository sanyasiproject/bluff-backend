import type { Card, Rank } from '../types.js';

export type BotStyle = 'shark' | 'maniac' | 'rock' | 'detective' | 'trickster' | 'gambler';

/** how one bot plays; each bot draws its own numbers, so no two at a table play alike. Server-only */
export interface Personality {
  style: BotStyle;
  /** appetite for fake cards: 0 honest, 1 wild */
  bluff: number;
  /** most fake cards it slips into one play */
  padMax: number;
  /** chance to open a round with fake cards */
  openBluff: number;
  /** leaning towards calling bluff: -1 trusting, +1 suspicious */
  call: number;
  /** how much a big pile scares it off a risky call (0..1) */
  pileFear: number;
  /** how much it trusts what it knows about a player over its gut (0..1) */
  readWeight: number;
  /** chance it uses what it remembers about cards on a decision (0..1) */
  memory: number;
  /** chance to hold back real cards */
  sandbag: number;
  /** extra push when someone (or itself) is close to finishing (0..1) */
  closer: number;
  /** after being caught: + lies more out of spite, - turns careful */
  tilt: number;
  /** randomness in its choices: higher is harder to read */
  temper: number;
  /** think-time multiplier */
  tempo: number;
  /** chance to peek when unsure */
  peek: number;
  /** chance to say something after a big moment */
  chatty: number;
}

/** what a bot has seen a player do at this table; only things everyone could see */
export interface Read {
  /** their plays that were called and turned out to be bluffs */
  caught: number;
  /** their plays that were called and held up */
  honest: number;
  goodCalls: number;
  wrongCalls: number;
  /** plays by others they could have called */
  chances: number;
  /** their turns in a running round: how many, by the odds, came with none of the rank (summed chances) */
  lack: number;
  /** of those turns, how many they passed; a player who never passes when they likely lack the rank is padding with fakes */
  passes: number;
  /** checks of the first, last and middle cards of their called plays (cards go down in tap order), and how many were fake */
  firstTried: number;
  firstFound: number;
  lastTried: number;
  lastFound: number;
  midTried: number;
  midFound: number;
  /** their called plays of 2+ cards, openings and follow-ups apart: caught with a fake, or held up (one card of n checked counts 1/n) */
  openCaught: number;
  openHonest: number;
  followCaught: number;
  followHonest: number;
  /** their called plays that would have emptied their hand: caught with a fake, or held up */
  endCaught: number;
  endHonest: number;
  /** cards of their plays turned over (by any call, or my peeks): how many fakes my reads expected, and how many there were */
  expected: number;
  found: number;
}

/** one play sitting in the current pile */
export interface PileEntry {
  /** the play's id, to match it with the last play on the table */
  id: string | null;
  playerId: string;
  count: number;
  rank: Rank;
  /** the real cards when the play was this bot's own */
  mine: Card[] | null;
  /** it started the round (the player picked the rank) */
  opening: boolean;
  /** cards the player had left after it (0: it would finish them) */
  left: number;
  /** copies of the rank this bot knew the player held just before it (cards they picked up in front of it) */
  knownBefore: number;
  /** real cards the bot reckons the play holds, once it has read it */
  realEst: number | null;
  /** cards of it this bot peeked at */
  seen: Card[];
  /** what this bot's read said when it weighed calling it: the chance of a fake anywhere, and at each card */
  read: { lie: number; spots: number[] } | null;
}

/** how a player tends to play, as a bot reckons it: every number is a chance unless said otherwise */
export interface Policy {
  /** following a round while holding its rank: slips fakes in */
  pad: number;
  /** following with none of the rank: pushes fakes instead of passing */
  push: number;
  /** following while holding the rank: passes anyway */
  hold: number;
  /** opening a round: slips fakes in among real cards */
  openPad: number;
  /** opening with a rank they hold none of */
  openNone: number;
  /** with a hand they can't finish honestly: fakes the rest to finish */
  finish: number;
  /** honest but keeps some real cards back */
  sandbag: number;
  /** lying while keeping some real cards back */
  holdBack: number;
  /** usual number of fakes in one lie (at least 1) */
  size: number;
  /** odds that the first, a middle and the last card of a mixed play is the fake (tap order) */
  spots: [number, number, number];
  /** how much is known about them (0 nothing, 1 plenty) */
  known: number;
}

export type BotMove = { kind: 'call'; cardIndex?: number } | { kind: 'play'; cardIds: string[]; rank?: Rank } | { kind: 'pass' };

export type Rand = () => number;
