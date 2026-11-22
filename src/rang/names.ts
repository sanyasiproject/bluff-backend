import type { RangCard, RangColor } from '../types.js';

const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];

/** "red seven", "blue skip", "green +2", "wild", "wild +4": for spoken lines */
export function rangCardName(card: Pick<RangCard, 'color' | 'value'>): string {
  if (card.value === 'wild') return 'a wild';
  if (card.value === 'wild4') return 'a wild +4';
  const what = /^[0-9]$/.test(card.value) ? NUMBER_WORDS[Number(card.value)] : card.value === 'draw2' ? '+2' : card.value;
  return `${card.color} ${what}`;
}

/** "Red", for the colour named with a wild */
export const rangColorName = (color: RangColor): string => color[0].toUpperCase() + color.slice(1);
