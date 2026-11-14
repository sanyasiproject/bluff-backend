import type { Card, Rank } from '../types.js';

/** the cards a bot can't see, and how many of them are the rank in question */
export interface Unseen {
  cards: number;
  copies: number;
}

/** what one bot can't see of a rank: deck size minus its own cards (hand and pile) and the discards it knows of */
export function unseenOf(rank: Rank, decks: number, mine: Card[], gone: Map<Rank, number>): Unseen {
  let goneAll = 0;
  for (const n of gone.values()) goneAll += n;
  const own = mine.filter((c) => c.rank === rank).length;
  return {
    cards: Math.max(1, 52 * decks - mine.length - goneAll),
    copies: Math.max(0, 4 * decks - own - (gone.get(rank) ?? 0)),
  };
}

// log factorials, enough for two decks
const LOG_FACT: number[] = [0];
for (let i = 1; i <= 110; i++) LOG_FACT[i] = LOG_FACT[i - 1] + Math.log(i);
const logChoose = (n: number, k: number) => (k < 0 || k > n ? -Infinity : LOG_FACT[n] - LOG_FACT[k] - LOG_FACT[n - k]);

/** chance a hand of this size, dealt from what the bot can't see, holds at least n copies of the rank */
export function holdChance(u: Unseen, hand: number, n: number): number {
  if (n <= 0) return 1;
  const h = Math.min(hand, u.cards);
  if (n > u.copies || n > h) return 0;
  const all = logChoose(u.cards, h);
  let below = 0;
  for (let j = 0; j < n; j++) below += Math.exp(logChoose(u.copies, j) + logChoose(u.cards - u.copies, h - j) - all);
  return Math.min(1, Math.max(0, 1 - below));
}
