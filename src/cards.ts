import { randomInt } from 'node:crypto';
import { RANKS, SUITS, type Card, type Rank, type Suit } from './types.js';

export type RandomInt = (max: number) => number;

export const secureRandom: RandomInt = (max) => randomInt(max);

const RANK_NAMES: Record<Rank, [string, string]> = {
  A: ['Ace', 'Aces'],
  '2': ['Two', 'Twos'],
  '3': ['Three', 'Threes'],
  '4': ['Four', 'Fours'],
  '5': ['Five', 'Fives'],
  '6': ['Six', 'Sixes'],
  '7': ['Seven', 'Sevens'],
  '8': ['Eight', 'Eights'],
  '9': ['Nine', 'Nines'],
  '10': ['Ten', 'Tens'],
  J: ['Jack', 'Jacks'],
  Q: ['Queen', 'Queens'],
  K: ['King', 'Kings'],
};

const COUNT_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'];

export function buildDeck(decks: number): Card[] {
  const cards: Card[] = [];
  for (let d = 1; d <= decks; d++) {
    for (const suit of SUITS) {
      for (const rank of RANKS) cards.push({ id: `${rank}${suit}${d}`, rank, suit });
    }
  }
  return cards;
}

export function shuffle<T>(items: T[], rand: RandomInt = secureRandom): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = rand(i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function sortHand(cards: Card[]): Card[] {
  return cards.sort(
    (a, b) => RANKS.indexOf(a.rank) - RANKS.indexOf(b.rank) || SUITS.indexOf(a.suit) - SUITS.indexOf(b.suit),
  );
}

/** "four Queens", "one Ace" */
export function describeClaim(count: number, rank: Rank): string {
  const [one, many] = RANK_NAMES[rank];
  return `${COUNT_WORDS[count] ?? count} ${count === 1 ? one : many}`;
}

const SUIT_NAMES: Record<Suit, string> = { S: 'Spades', H: 'Hearts', D: 'Diamonds', C: 'Clubs' };

/** "Seven of Spades" */
export function cardName(card: Card): string {
  return `${RANK_NAMES[card.rank][0]} of ${SUIT_NAMES[card.suit]}`;
}

export function ordinal(n: number): string {
  return ['', '1st', '2nd', '3rd', '4th', '5th'][n] ?? `${n}th`;
}
