import type { GameConfig, RangCard, RangColor, RangValue, RangView } from '../types.js';

// Server-only shapes for the Rang bots

export type RangStyle = 'striker' | 'hoarder' | 'shifter' | 'counter';

/** how one Rang bot plays; each bot draws its own numbers inside its style */
export interface RangPersonality {
  style: RangStyle;
  /** thinking time per decision, ms */
  budgetMs: number;
  /** most samples per decision (each sample plays every option out) */
  maxPlayouts: number;
  /** chance a sample uses what it worked out about opponents' hands (0..1) */
  memory: number;
  /** looseness when options are close: higher is harder to read */
  temper: number;
  /** leaning: + fires +2/+4 early, - keeps them to answer one */
  attack: number;
  /** leaning: + spends wilds early, - holds them for when nothing fits */
  wilds: number;
  /** leaning towards changing colour with a same-value card */
  switching: number;
  /** leaning: + challenges a +4 more readily, - takes the pick */
  doubt: number;
  /** think-time multiplier */
  tempo: number;
  /** chance to say something after a big moment */
  chatty: number;
}

/** what a bot worked out about one opponent's hand from public moves */
export interface OpponentRead {
  /** colours and values they held none of when nothing fit (wild values: no wild at all) */
  voidColors: Set<RangColor>;
  voidValues: Set<RangValue>;
  /** cards picked since then, which can be anything */
  fresh: number;
  /** cards surely in their hand (a hand that came from me with a 7 or 0 swap) */
  known: RangCard[];
}

/** a bot's choice on its turn; color: named with a wild; targetId: who a 7 swaps with (7-0 on); extra: the rest of a doubles play, in order */
export type RangAction =
  | { kind: 'play'; cardId: string; color?: RangColor; targetId?: string; extra?: string[] }
  | { kind: 'pick' }
  | { kind: 'pass' }
  | { kind: 'challenge' };

/** the table exactly as one seat sees it */
export interface RangSeatView {
  meId: string;
  turnId: string | null;
  config: GameConfig;
  /** seated players in turn order with their card counts */
  players: { id: string; cardCount: number }[];
  rang: RangView;
}

export type Rand = () => number;
