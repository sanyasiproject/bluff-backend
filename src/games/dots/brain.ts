import { dotsBoxesOf, dotsBoxLines, type BotLevel } from '../../types.js';
import type { DotsGame } from './game.js';

/** a board copy for looking ahead: drawn lines only */
type Board = { size: number; lines: Set<number> };

const sides = (b: Board, box: number): number =>
  dotsBoxLines(b.size, Math.floor(box / b.size), box % b.size).filter((l) => b.lines.has(l)).length;

/** lines that close a box now */
function closing(b: Board, free: number[]): number[] {
  return free.filter((l) => dotsBoxesOf(b.size, l).some((x) => sides(b, x) === 3));
}

/** lines that give no box away (no box gets its third side) */
function safe(b: Board, free: number[]): number[] {
  return free.filter((l) => dotsBoxesOf(b.size, l).every((x) => sides(b, x) < 2));
}

/** boxes the next player takes if they grab every box they can after this line */
export function giveaway(b: Board, line: number): number {
  const lines = new Set(b.lines);
  lines.add(line);
  const sim: Board = { size: b.size, lines };
  let taken = 0;
  for (;;) {
    const free = [...Array(2 * b.size * (b.size + 1)).keys()].filter((l) => !lines.has(l));
    const c = closing(sim, free)[0];
    if (c === undefined) return taken;
    lines.add(c);
    taken += dotsBoxesOf(b.size, c).filter((x) => sides(sim, x) === 4).length;
  }
}

const pick = <T>(xs: T[], rand: () => number): T => xs[Math.floor(rand() * xs.length) % xs.length];

/** a bot's line: take a box when it can; else a line that gives nothing; else (Expert, Hard) the smallest gift */
export function decide(g: DotsGame, _id: string, level: BotLevel, rand: () => number): { type: 'line'; line: number } {
  const board: Board = { size: g.size, lines: new Set(g.lines.keys()) };
  const free = g.freeLines();
  const take = closing(board, free);
  // Normal now and then misses a box it could take
  if (take.length > 0 && (level !== 'normal' || rand() < 0.85)) return { type: 'line', line: pick(take, rand) };
  const calm = safe(board, free);
  // Normal sometimes doesn't look and gives a box away
  if (calm.length > 0 && (level !== 'normal' || rand() < 0.7)) return { type: 'line', line: pick(calm, rand) };
  if (level === 'normal') return { type: 'line', line: pick(free, rand) };
  // Hard counts only boxes given at once; Expert counts the whole chain the next player runs
  const cost = (l: number) =>
    level === 'expert' ? giveaway(board, l) : dotsBoxesOf(g.size, l).filter((x) => sides(board, x) === 2).length;
  let best = Infinity;
  let options: number[] = [];
  for (const l of free) {
    const c = cost(l);
    if (c < best) [best, options] = [c, [l]];
    else if (c === best) options.push(l);
  }
  return { type: 'line', line: pick(options, rand) };
}
