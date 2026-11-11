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
}

/** one play sitting in the current pile */
export interface PileEntry {
  playerId: string;
  count: number;
  rank: Rank;
  /** the real cards when the play was this bot's own */
  mine: Card[] | null;
}

export type BotMove = { kind: 'call'; cardIndex?: number } | { kind: 'play'; cardIds: string[]; rank?: Rank } | { kind: 'pass' };

export type Rand = () => number;
