import { backsClaim, type Card, type Rank } from '../types.js';

/** the cards a bot can't see, and how many of them are the rank in question */
export interface Unseen {
  cards: number;
  copies: number;
}

/** copies in the game that could back up a claim of this rank (the Kismat cards count too), like Game.copiesFor */
export const copiesFor = (rank: Rank, decks: number, kismat: Rank | null) => 4 * decks * (!!kismat && kismat !== rank ? 2 : 1);

/** what one bot can't see of a rank: deck size minus its own cards (hand and pile) and the discards it knows of; Kismat cards count as copies */
export function unseenOf(rank: Rank, decks: number, mine: Card[], gone: Map<Rank, number>, kismat: Rank | null = null): Unseen {
  let goneAll = 0;
  for (const n of gone.values()) goneAll += n;
  const own = mine.filter((c) => backsClaim(c, rank, kismat)).length;
  const wildGone = kismat && kismat !== rank ? (gone.get(kismat) ?? 0) : 0;
  return {
    cards: Math.max(1, 52 * decks - mine.length - goneAll),
    copies: Math.max(0, copiesFor(rank, decks, kismat) - own - (gone.get(rank) ?? 0) - wildGone),
  };
}

// log factorials, enough for two decks
const LOG_FACT: number[] = [0];
for (let i = 1; i <= 110; i++) LOG_FACT[i] = LOG_FACT[i - 1] + Math.log(i);
export const logChoose = (n: number, k: number) => (k < 0 || k > n ? -Infinity : LOG_FACT[n] - LOG_FACT[k] - LOG_FACT[n - k]);

/** chance a hand of this size, dealt from what the bot can't see, holds at least n copies of the rank; copies may be fractional (a soft count) */
export function holdChance(u: Unseen, hand: number, n: number): number {
  if (n <= 0) return 1;
  const lo = Math.floor(u.copies);
  const t = u.copies - lo;
  if (t > 1e-9) return (1 - t) * holdChance({ cards: u.cards, copies: lo }, hand, n) + t * holdChance({ cards: u.cards, copies: lo + 1 }, hand, n);
  // a whole number from here on (a hair above one counts as it)
  const copies = lo;
  const h = Math.min(hand, u.cards);
  if (n > copies || n > h) return 0;
  const all = logChoose(u.cards, h);
  let below = 0;
  for (let j = 0; j < n; j++) below += Math.exp(logChoose(copies, j) + logChoose(u.cards - copies, h - j) - all);
  return Math.min(1, Math.max(0, 1 - below));
}

/** the spread of the sum of two independent counts (index = count) */
export function convolve(a: number[], b: number[]): number[] {
  const out = new Array<number>(a.length + b.length - 1).fill(0);
  a.forEach((x, i) => {
    if (x > 0) b.forEach((y, j) => (out[i + j] += x * y));
  });
  return out;
}

/** a spread's average (index = count) */
export const meanOf = (spread: number[]) => spread.reduce((sum, p, i) => sum + p * i, 0);

/** chance a play of `count` holds 0, 1, 2… real cards (index = real), from a read of its fakes (index = fakes); a plain guess with no read */
export function realOdds(count: number, fakes: number[] | null): number[] {
  if (fakes && fakes.length === count + 1) return fakes.map((_, j) => fakes[count - j]);
  return Array.from({ length: count + 1 }, (_, j) => Math.exp(logChoose(count, j)) * 0.55 ** j * 0.45 ** (count - j));
}

/** chance a hand of `hand` cards from `cards` unseen holds exactly k of `copies` (index k); copies may be fractional (a soft count) */
export function holdingOdds(cards: number, copies: number, hand: number): number[] {
  const exact = (c: number) => {
    const h = Math.min(hand, cards);
    const out = new Array<number>(hand + 1).fill(0);
    const all = logChoose(cards, h);
    for (let k = 0; k <= Math.min(c, h); k++) out[k] = Math.exp(logChoose(c, k) + logChoose(cards - c, h - k) - all);
    return out;
  };
  const c = Math.max(0, Math.min(copies, cards));
  const lo = Math.floor(c);
  const t = c - lo;
  if (t < 1e-9) return exact(lo);
  const a = exact(lo);
  const b = exact(lo + 1);
  return a.map((x, k) => x * (1 - t) + b[k] * t);
}
