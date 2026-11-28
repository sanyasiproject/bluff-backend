import { wordHuntMinLen, wordHuntTouches } from '../../types.js';
import { childOf, type Dict } from './dictionary.js';

/** our own 25 letter dice, faces weighted like English letter frequencies; 'qu' is one face */
export const WORDHUNT_DICE: readonly (readonly string[])[] = [
  'e t o s h p', 'e t o s h p', 'e t i s h w', 'e t i s h w', 'e t i s h w', 'e a i s d f', 'e a i s d f', 'e a i r d f', 'e a i r d g',
  'e a i r d g', 'e a i r d g', 'e a i r c y', 'e a n r c y', 'e a n r c y', 'e a n r c b', 'e a n r u b', 'e a n r u b', 'e o n l u v',
  't o n l u v', 't o n l m k', 't o n l m k', 't o n l m j', 't o s l m x', 't o s l p qu', 't o s h p z',
].map((d) => d.split(' '));

/** the fewest words a grid must hold, by size */
export const WORDHUNT_MIN_WORDS: Record<number, number> = { 4: 40, 5: 80 };

/** a word the grid holds: one path that spells it and its tier (1 common .. 8 rare) */
export interface Solved {
  path: number[];
  tier: number;
}

/** every dictionary word in the grid of minLen+ letters, by DFS over the trie */
export function solve(d: Dict, grid: readonly string[], size: number, minLen = wordHuntMinLen(size)): Map<string, Solved> {
  const out = new Map<string, Solved>();
  const used = new Uint8Array(grid.length);
  const path: number[] = [];
  const nbrs = grid.map((_, i) => grid.map((_, j) => j).filter((j) => wordHuntTouches(size, i, j)));
  const walk = (i: number, node: number, word: string) => {
    const tile = grid[i];
    let n = node;
    for (let k = 0; k < tile.length && n >= 0; k++) n = childOf(d, n, tile.charCodeAt(k) - 97);
    if (n < 0) return;
    const w = word + tile;
    used[i] = 1;
    path.push(i);
    if (d.tier[n] > 0 && w.length >= minLen && !out.has(w)) out.set(w, { path: [...path], tier: d.tier[n] });
    if (d.firstChild[n] >= 0) for (const j of nbrs[i]) if (!used[j]) walk(j, n, w);
    path.pop();
    used[i] = 0;
  };
  for (let i = 0; i < grid.length; i++) walk(i, 0, '');
  return out;
}

/** a small seeded random (mulberry32), so one seed always makes the same grid */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** one roll of the dice: size² dice picked and shuffled, one face each */
export function rollGrid(size: number, r: () => number): string[] {
  const dice = [...WORDHUNT_DICE];
  for (let i = dice.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [dice[i], dice[j]] = [dice[j], dice[i]];
  }
  return dice.slice(0, size * size).map((d) => d[Math.floor(r() * d.length)]);
}

/** a grid with at least WORDHUNT_MIN_WORDS words (the richest of up to 60 rolls otherwise), with its words */
export function makeGrid(d: Dict, size: number, seed: number): { grid: string[]; words: Map<string, Solved>; tries: number } {
  const r = seeded(seed);
  let best: { grid: string[]; words: Map<string, Solved> } | null = null;
  for (let tries = 1; tries <= 60; tries++) {
    const grid = rollGrid(size, r);
    const words = solve(d, grid, size);
    if (!best || words.size > best.words.size) best = { grid, words };
    if (words.size >= (WORDHUNT_MIN_WORDS[size] ?? 40)) return { ...best, tries };
  }
  return { ...best!, tries: 60 };
}
