// Perft node counting (for tests).
import { Board } from './board.js';
import { genLegal, makeMove } from './movegen.js';
import { variantEnd } from './rules.js';

export function perft(root: Board, depth: number): number {
  const boards: Board[] = [];
  for (let i = 0; i <= depth; i++) boards.push(new Board());
  const tmp = new Board();
  const lists: Int32Array[] = [];
  for (let i = 0; i <= depth; i++) lists.push(new Int32Array(512));
  boards[0].copyFrom(root);
  const go = (ply: number, d: number): number => {
    const b = boards[ply];
    if (variantEnd(b)) return 0;
    const list = lists[ply];
    const n = genLegal(b, list, 0, tmp);
    if (d === 1) return n;
    let total = 0;
    const child = boards[ply + 1];
    for (let i = 0; i < n; i++) {
      child.copyFrom(b);
      makeMove(child, list[i]);
      total += go(ply + 1, d - 1);
    }
    return total;
  };
  return depth === 0 ? 1 : go(0, depth);
}
