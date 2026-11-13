import type { Card, Crazy7View, GameConfig, Rank, Suit } from '../types.js';

// Server-only shapes for the Crazy 7 bots

export type Crazy7Style = 'hunter' | 'guardian' | 'switcher' | 'counter';

/** how one Crazy 7 bot plays; each bot draws its own numbers inside its style */
export interface Crazy7Personality {
  style: Crazy7Style;
  /** thinking time per decision, ms */
  budgetMs: number;
  /** most samples per decision (each sample plays every option out) */
  maxPlayouts: number;
  /** chance a sample uses what it worked out about opponents' hands (0..1) */
  memory: number;
  /** looseness when options are close: higher is harder to read */
  temper: number;
  /** leaning: + fires 7s early, - keeps them as shields */
  sevens: number;
  /** leaning towards changing suit with a same-number card */
  switching: number;
  /** think-time multiplier */
  tempo: number;
  /** chance to say something after a big moment */
  chatty: number;
}

/** what a bot worked out about one opponent's hand from public moves */
export interface OpponentRead {
  /** suits and numbers they held none of at their last forced pick (or 7s they couldn't answer with) */
  voidSuits: Set<Suit>;
  voidRanks: Set<Rank>;
  /** cards picked since then, which can be anything */
  fresh: number;
}

/** a bot's choice on its turn */
export type Crazy7Action = { kind: 'play'; cardId: string } | { kind: 'pick' } | { kind: 'pass' };

/** the table exactly as one seat sees it */
export interface SeatView {
  meId: string;
  turnId: string | null;
  config: GameConfig;
  hand: Card[];
  /** seated players in turn order with their card counts */
  players: { id: string; cardCount: number }[];
  c7: Crazy7View;
}

export type Rand = () => number;
