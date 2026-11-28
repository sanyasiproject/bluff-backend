// Post-game review: evals, move judgements, accuracy, ACPL and opening.
import { search } from './engine/search.js';
import { clearEngine } from './engine/tt.js';
import type { ChessGame } from './game.js';
import { bookPlies, openingOf, type ChessOpening } from './openings.js';
import type { Move } from './position.js';

export type MoveJudgement = 'best' | 'good' | 'inaccuracy' | 'mistake' | 'blunder' | 'book' | 'forced';

export interface MoveReview {
  ply: number; // 1 = White's first move
  san: string;
  evalBefore: number; // white-POV cp; mate → ±(10000 - moves)
  evalAfter: number;
  best: Move;
  bestSan: string;
  judgement: MoveJudgement;
  bestLine: string[]; // engine line (SAN) from the position before the move
  depth: number;
  accuracy: number; // 0-100 for this move
}

export interface GameReview {
  moves: MoveReview[];
  accuracy: { w: number; b: number };
  acpl: { w: number; b: number };
  counts: { w: Record<'inaccuracy' | 'mistake' | 'blunder', number>; b: Record<'inaccuracy' | 'mistake' | 'blunder', number> };
  evals: number[]; // white-POV eval of every position (ply 0..n), for the graph
  opening?: ChessOpening;
}

/** Lichess-style win chance (0-100) for the side whose cp score this is. */
export function winPercent(cp: number): number {
  const c = Math.max(-1000, Math.min(1000, cp));
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * c)) - 1);
}

/** Accuracy of one move from the drop in win chance. */
export function moveAccuracy(winBefore: number, winAfter: number): number {
  const drop = Math.max(0, winBefore - winAfter);
  return Math.max(0, Math.min(100, 103.1668 * Math.exp(-0.04354 * drop) - 3.1669));
}

/** Eval of a mate in n (positive: White mates) on the shared cp scale. */
export const mateToCp = (mateForWhite: number): number => (mateForWhite > 0 ? 10000 - mateForWhite : -10000 - mateForWhite);

export function reviewGame(
  game: ChessGame,
  opts: { msPerMove: number; maxDepth?: number; onProgress?: (done: number, total: number) => void; shouldStop?: () => boolean },
): GameReview {
  clearEngine();
  const n = game.ply;
  const keys = game.keys();
  const evals: number[] = [];
  const lines: { best?: Move; san: string[]; depth: number }[] = [];
  for (let i = 0; i <= n; i++) {
    if (opts.shouldStop?.()) break;
    const p = game.positionAt(i);
    const o = p.outcome() ?? (i === n ? game.outcome() : null);
    if (o) {
      evals.push(o.winner === 'w' ? 10000 : o.winner === 'b' ? -10000 : 0);
      lines.push({ san: [], depth: 0 });
    } else {
      const [top] = search(p, keys.slice(0, i + 1), { maxMs: opts.msPerMove, maxDepth: opts.maxDepth ?? 24 });
      const sign = p.turn === 'w' ? 1 : -1;
      const own = top.mate !== undefined ? mateToCp(top.mate) : top.scoreCp ?? 0;
      evals.push(sign * own);
      const san: string[] = [];
      let q = p;
      for (const m of top.moves.slice(0, 12)) {
        if (!q.isLegal(m)) break;
        san.push(q.san(m));
        q = q.play(m);
      }
      lines.push({ best: top.moves[0], san, depth: top.depth });
    }
    opts.onProgress?.(i + 1, n + 1);
  }
  const sans = game.sanList();
  const book = game.variant === 'standard' ? bookPlies(sans) : 0;
  const reviews: MoveReview[] = [];
  const accs: { w: number[]; b: number[] } = { w: [], b: [] };
  const loss: { w: number[]; b: number[] } = { w: [], b: [] };
  const counts = { w: { inaccuracy: 0, mistake: 0, blunder: 0 }, b: { inaccuracy: 0, mistake: 0, blunder: 0 } };
  for (let j = 1; j < evals.length; j++) {
    const before = game.positionAt(j - 1);
    const mover = before.turn;
    const sign = mover === 'w' ? 1 : -1;
    const eb = evals[j - 1], ea = evals[j];
    const wb = winPercent(sign * eb), wa = winPercent(sign * ea);
    const played = game.moves[j - 1];
    const line = lines[j - 1];
    const best = line.best ?? played;
    const sameAsBest = best.from === played.from && best.to === played.to && best.promotion === played.promotion && best.drop === played.drop;
    const drop = wb - wa;
    let judgement: MoveJudgement;
    if (before.legalCodes().length === 1) judgement = 'forced';
    else if (j <= book) judgement = 'book';
    else if (sameAsBest) judgement = 'best';
    else if (drop >= 15) judgement = 'blunder';
    else if (drop >= 10) judgement = 'mistake';
    else if (drop >= 5) judgement = 'inaccuracy';
    else judgement = 'good';
    if (judgement === 'blunder' || judgement === 'mistake' || judgement === 'inaccuracy') counts[mover][judgement]++;
    // Accuracy and ACPL both come from the same eval drop (mates clamped to ±1000 cp), for every move.
    const acc = moveAccuracy(wb, wa);
    accs[mover].push(acc);
    const clamp = (x: number) => Math.max(-1000, Math.min(1000, x));
    loss[mover].push(Math.max(0, clamp(sign * eb) - clamp(sign * ea)));
    reviews.push({
      ply: j,
      san: sans[j - 1],
      evalBefore: eb,
      evalAfter: ea,
      best,
      bestSan: before.isLegal(best) ? before.san(best) : sans[j - 1],
      judgement,
      bestLine: line.san,
      depth: line.depth,
      accuracy: Math.round(acc * 10) / 10,
    });
  }
  const gameAcc = (xs: number[]): number => {
    if (!xs.length) return 100;
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    const harm = xs.length / xs.reduce((a, b) => a + 1 / Math.max(1, b), 0);
    return Math.round(((mean + harm) / 2) * 10) / 10;
  };
  const avg = (xs: number[]): number => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0);
  const opening = game.variant === 'standard' ? openingOf(sans) : undefined;
  return {
    moves: reviews,
    accuracy: { w: gameAcc(accs.w), b: gameAcc(accs.b) },
    acpl: { w: avg(loss.w), b: avg(loss.b) },
    counts,
    evals,
    ...(opening ? { opening } : {}),
  };
}
