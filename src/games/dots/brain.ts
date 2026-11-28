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
  const count = new Map<number, number>();
  const ready: number[] = [];
  let taken = 0;
  // draws a line: each box it borders gains a side; a third side makes it takeable, a fourth takes it
  const draw = (l: number) => {
    lines.add(l);
    for (const x of dotsBoxesOf(b.size, l)) {
      const n = (count.get(x) ?? sides(b, x)) + 1;
      count.set(x, n);
      if (n === 3) ready.push(x);
      if (n === 4) taken++;
    }
  };
  // boxes already on three sides are takeable too
  for (let x = 0; x < b.size * b.size; x++) if (sides(b, x) === 3) ready.push(x);
  draw(line);
  // the next player keeps closing boxes with three sides: each box is looked at a few times at most
  while (ready.length > 0) {
    const x = ready.pop()!;
    const open = dotsBoxLines(b.size, Math.floor(x / b.size), x % b.size).find((l) => !lines.has(l));
    if (open !== undefined) draw(open);
  }
  return taken;
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
