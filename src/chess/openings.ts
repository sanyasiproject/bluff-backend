// Opening name lookup by the longest known prefix of a game's SAN moves.
import { OPENINGS_A } from './openings-a.js';
import { OPENINGS_B } from './openings-b.js';
import { OPENINGS_C } from './openings-c.js';

export interface ChessOpening { eco: string; name: string }

let table: Map<string, ChessOpening> | null = null;
let longest = 0;

const norm = (san: string): string => san.replace(/[+#!?]+$/g, '');

function load(): Map<string, ChessOpening> {
  if (table) return table;
  table = new Map();
  for (const text of [OPENINGS_A, OPENINGS_B, OPENINGS_C]) {
    for (const line of text.split('\n')) {
      const [eco, name, moves] = line.split('|');
      if (!moves) continue;
      const list = moves.trim().split(/\s+/).map(norm);
      longest = Math.max(longest, list.length);
      const key = list.join(' ');
      if (!table.has(key)) table.set(key, { eco, name });
    }
  }
  return table;
}

/** Number of named openings in the table. */
export const openingCount = (): number => load().size;

/** Opening of a game, or undefined when even the first move is unnamed. */
export function openingOf(sans: readonly string[]): ChessOpening | undefined {
  const t = load();
  const list = sans.slice(0, longest).map(norm);
  for (let n = list.length; n > 0; n--) {
    const hit = t.get(list.slice(0, n).join(' '));
    if (hit) return hit;
  }
  return undefined;
}

/** How many leading plies of the game match a named opening line exactly (book moves). */
export function bookPlies(sans: readonly string[]): number {
  const t = load();
  const list = sans.slice(0, longest).map(norm);
  for (let n = list.length; n > 0; n--) if (t.has(list.slice(0, n).join(' '))) return n;
  return 0;
}
