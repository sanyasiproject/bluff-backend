import { UTTT_LINES, type BotLevel, type UtttMoveInput } from '../../types.js';
import { other, UtttCore, type Side } from './core.js';
import type { UtttGame } from './game.js';

const WIN = 100_000;
// board weights: the centre counts most, then corners
const BOARD_W = [1.2, 1, 1.2, 1, 1.5, 1, 1.2, 1, 1.2];
const CELL_W = [3, 2, 3, 2, 4, 2, 3, 2, 3];

/** how good the position is for side s */
export function evaluate(core: UtttCore, s: Side): number {
  if (core.result === 3) return 0;
  if (core.result) return core.result === s ? WIN : -WIN;
  const o = other(s);
  let score = 0;
  for (let b = 0; b < 9; b++) {
    const st = core.boards[b];
    if (st === s) score += 100 * BOARD_W[b];
    else if (st === o) score -= 100 * BOARD_W[b];
    else if (st === 0) {
      let local = 0;
      for (const l of UTTT_LINES) {
        let mine = 0;
        let theirs = 0;
        for (const k of l) {
          const c = core.cells[b * 9 + k];
          if (c === s) mine++;
          else if (c === o) theirs++;
        }
        if (theirs === 0 && mine === 2) local += 9;
        else if (mine === 0 && theirs === 2) local -= 9;
      }
      for (let k = 0; k < 9; k++) {
        const c = core.cells[b * 9 + k];
        if (c === s) local += CELL_W[k];
        else if (c === o) local -= CELL_W[k];
      }
      score += local * BOARD_W[b];
    }
  }
  // big lines still open to one side
  for (const l of UTTT_LINES) {
    let mine = 0;
    let theirs = 0;
    let dead = false;
    for (const b of l) {
      const st = core.boards[b];
      if (st === s) mine++;
      else if (st === o) theirs++;
      else if (st === 3) dead = true;
    }
    if (dead || (mine && theirs)) continue;
    if (mine === 2) score += 220;
    else if (mine === 1) score += 25;
    if (theirs === 2) score -= 220;
    else if (theirs === 1) score -= 25;
  }
  // a free move is worth a lot to whoever has it
  if (core.forced < 0) score += core.toMove === s ? 45 : -45;
  return score;
}

// cheap move order: takes a board first, then avoids handing out free moves
function ordered(core: UtttCore, first: number): number[] {
  const s = core.toMove;
  const keyed = core.legal().map((m) => {
    const b = Math.floor(m / 9);
    const c = m % 9;
    let k = CELL_W[c];
    if (m === first) k += 10_000;
    for (const l of UTTT_LINES) {
      if (!l.includes(c)) continue;
      const others = l.filter((x) => x !== c);
      if (others.every((x) => core.cells[b * 9 + x] === s)) k += 500;
      else if (others.every((x) => core.cells[b * 9 + x] === other(s))) k += 200;
    }
    if (core.boards[c] !== 0 || c === b) k -= 60;
    return { m, k };
  });
  return keyed.sort((a, b) => b.k - a.k).map((x) => x.m);
}

class Timeout extends Error {}

/** alpha-beta (negamax) to a depth; throws Timeout past the deadline */
function negamax(core: UtttCore, depth: number, alpha: number, beta: number, ply: number, deadline: number, nodes: { n: number }): number {
  if ((++nodes.n & 1023) === 0 && Date.now() > deadline) throw new Timeout();
  if (core.result) return core.result === 3 ? 0 : core.result === core.toMove ? WIN - ply : -(WIN - ply);
  if (depth === 0) return evaluate(core, core.toMove);
  let best = -Infinity;
  for (const m of ordered(core, -1)) {
    core.play(m);
    const v = -negamax(core, depth - 1, -beta, -alpha, ply + 1, deadline, nodes);
    core.undo();
    if (v > best) best = v;
    if (v > alpha) alpha = v;
    if (alpha >= beta) break;
  }
  return best;
}

/** the best move by iterative deepening within budgetMs (and maxDepth); scores of the root moves at the last full depth */
export function searchBest(root: UtttCore, maxDepth: number, budgetMs: number): { move: number; scores: Map<number, number> } {
  const core = root.clone();
  const deadline = Date.now() + budgetMs;
  const nodes = { n: 0 };
  let best = ordered(core, -1)[0];
  let scores = new Map<number, number>();
  for (let depth = 1; depth <= maxDepth; depth++) {
    const now = new Map<number, number>();
    let alpha = -Infinity;
    let pick = best;
    try {
      for (const m of ordered(core, best)) {
        core.play(m);
        const v = -negamax(core, depth - 1, -Infinity, -alpha, 1, deadline, nodes);
        core.undo();
        now.set(m, v);
        if (v > alpha) {
          alpha = v;
          pick = m;
        }
      }
    } catch (err) {
      if (err instanceof Timeout) break;
      throw err;
    }
    best = pick;
    scores = now;
    // a forced win found: no need to look deeper
    if (alpha >= WIN - 100) break;
  }
  return { move: best, scores };
}

/** by level: Normal looks 2 moves ahead with noise, Hard 4, Expert deepens for up to budgetMs */
export const UTTT_BOT = {
  normal: { depth: 2, ms: 40, noise: 60 },
  hard: { depth: 4, ms: 80, noise: 10 },
  expert: { depth: 14, ms: 180, noise: 0 },
} as const;

export function decide(g: UtttGame, _botId: string, level: BotLevel, rand: () => number, budgetMs?: number): UtttMoveInput {
  const lv = UTTT_BOT[level] ?? UTTT_BOT.hard;
  const { move, scores } = searchBest(g.core, lv.depth, budgetMs ?? lv.ms);
  let pick = move;
  if (lv.noise > 0 && scores.size > 1) {
    // noisy levels pick among close moves, never throwing away a win
    let bestV = -Infinity;
    for (const [m, v] of scores) {
      const nv = v >= WIN - 100 ? v : v + (rand() * 2 - 1) * lv.noise;
      if (nv > bestV) {
        bestV = nv;
        pick = m;
      }
    }
  }
  return { type: 'place', board: Math.floor(pick / 9), cell: pick % 9 };
}
