// Move ordering and small search helpers.
import type { Board } from '../core/board.js';
import { F_DROP, isCaptureMove, mFlag, mFrom, mPromo, mTo } from '../core/movegen.js';
import type { Move, Role } from '../position.js';
import { VALUE_MG } from './eval.js';
import type { Tables } from './tt.js';

const ROLES: Role[] = ['p', 'p', 'n', 'b', 'r', 'q', 'k'];

export const toPublicMove = (m: number): Move => {
  if (mFlag(m) === F_DROP) return { from: mTo(m), to: mTo(m), drop: ROLES[mPromo(m)] };
  const out: Move = { from: mFrom(m), to: mTo(m) };
  if (mPromo(m)) out.promotion = ROLES[mPromo(m)];
  return out;
};

export function orderMoves(T: Tables, b: Board, base: number, n: number, ttMove: number, ply: number): void {
  const mv = T.moves, sc = T.scores, k1 = T.killers[ply * 2], k2 = T.killers[ply * 2 + 1];
  const hoff = b.turn * 4096;
  for (let i = base; i < n; i++) {
    const m = mv[i];
    let s: number;
    if (m === ttMove) s = 4000000;
    else if (isCaptureMove(b, m)) {
      const victim = mFlag(m) === 2 ? 1 : b.sq[mTo(m)] & 7;
      s = 2000000 + VALUE_MG[victim] * 10 - VALUE_MG[b.sq[mFrom(m)] & 7] / 10 + (mPromo(m) ? VALUE_MG[mPromo(m)] : 0);
    } else if (mPromo(m) && mFlag(m) !== F_DROP) s = 1500000 + VALUE_MG[mPromo(m)];
    else if (m === k1) s = 1000000;
    else if (m === k2) s = 990000;
    else s = T.history[hoff + mFrom(m) * 64 + mTo(m)] + (mFlag(m) === F_DROP ? 50 : 0);
    sc[i] = s;
  }
}

export function pickNext(T: Tables, i: number, n: number): void {
  const mv = T.moves, sc = T.scores;
  let best = i;
  for (let j = i + 1; j < n; j++) if (sc[j] > sc[best]) best = j;
  if (best !== i) {
    const m = mv[i], s = sc[i];
    mv[i] = mv[best];
    sc[i] = sc[best];
    mv[best] = m;
    sc[best] = s;
  }
}

// Antichess: captures are compulsory among pseudo-legal moves.
export function antiFilter(T: Tables, b: Board, base: number, n: number): number {
  let has = false;
  for (let i = base; i < n && !has; i++) if (isCaptureMove(b, T.moves[i])) has = true;
  if (!has) return n;
  let w = base;
  for (let i = base; i < n; i++) if (isCaptureMove(b, T.moves[i])) T.moves[w++] = T.moves[i];
  return w;
}

// Null move only with a rook's worth of pieces (zugzwang guard).
export function hasPieces(b: Board, c: number): boolean {
  let total = 0;
  for (let s = 0; s < 64; s++) {
    const x = b.sq[s];
    if (x && ((x >> 3) & 1) === c && (x & 7) !== 1 && (x & 7) !== 6) total += VALUE_MG[x & 7];
  }
  return total >= 480;
}
