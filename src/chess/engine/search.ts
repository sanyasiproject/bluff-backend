// Alpha-beta search: iterative deepening, PVS, TT, quiescence, killers/history, null move, LMR.
import { Board } from '../core/board.js';
import {
  F_DROP, genLegal, genPseudo, inCheck, isCaptureMove, legalAfter, makeMove, mFlag, mFrom, mPromo, mTo,
} from '../core/movegen.js';
export { toPublicMove } from './order.js';
import { variantEnd } from '../core/rules.js';
import type { Move, Position } from '../position.js';
import { antiFilter, hasPieces, orderMoves, pickNext, toPublicMove } from './order.js';
import { V_ANTI, V_ATOM, V_HORDE } from '../variants.js';
import { VALUE_MG, evaluate } from './eval.js';
import { INF, LIST, MATE, MATE_BOUND, MAX_PLY, TT_EXACT, TT_LOWER, TT_MASK, TT_UPPER, tables, type Tables } from './tt.js';

export interface SearchLimits { maxDepth?: number; maxMs?: number; nodes?: number; multiPv?: number }
export interface PvLine { moves: Move[]; scoreCp?: number; mate?: number; depth: number } // side to move's view

const boards: Board[] = [];
for (let i = 0; i < MAX_PLY + 2; i++) boards.push(new Board());
const keys = new Float64Array(MAX_PLY + 1200);
const rootTmp = new Board();

let T: Tables;
let nodes = 0, nodeLimit = Infinity, deadline = Infinity, stopped = false;
let histLen = 0, variant = 0, nullOk = true;
let excluded: number[] = [];
const LMR = new Int8Array(64 * 64);
for (let d = 1; d < 64; d++) for (let m = 1; m < 64; m++) LMR[d * 64 + m] = Math.floor(0.8 + (Math.log(d) * Math.log(m)) / 2.2);

function checkLimits(): void {
  if (nodes >= nodeLimit || Date.now() >= deadline) stopped = true;
}

function isRepetition(ply: number, b: Board): boolean {
  const idx = histLen + ply;
  const k = keys[idx];
  const lo = Math.max(0, idx - b.half);
  for (let i = idx - 2; i >= lo; i -= 2) if (keys[i] === k) return true;
  return false;
}

function endScore(winner: number, b: Board, ply: number): number {
  if (winner < 0) return 0;
  return winner === b.turn ? MATE - ply : -(MATE - ply);
}

function qsearch(ply: number, alpha: number, beta: number, qd: number): number {
  if ((++nodes & 255) === 0) checkLimits();
  if (stopped) return 0;
  const b = boards[ply];
  const ve = variantEnd(b);
  if (ve) return endScore(ve.winner, b, ply);
  if (ply >= MAX_PLY) return evaluate(b);
  const anti = variant === V_ANTI;
  const check = !anti && qd < 2 && inCheck(b, b.turn);
  const base = ply * LIST;
  let n = genPseudo(b, T.moves, base, !check && !anti);
  let stand = -INF;
  if (anti) {
    const m = antiFilter(T, b, base, n);
    let forced = false;
    for (let i = base; i < m && !forced; i++) if (isCaptureMove(b, T.moves[i])) forced = true;
    if (!forced || qd > 8) return evaluate(b);
    n = m;
  } else if (!check) {
    stand = evaluate(b);
    if (stand >= beta) return stand;
    if (stand > alpha) alpha = stand;
  }
  orderMoves(T, b, base, n, 0, ply);
  let best = stand, legal = 0;
  const child = boards[ply + 1];
  const delta = variant !== V_ATOM && !anti;
  for (let i = base; i < n; i++) {
    pickNext(T, i, n);
    const m = T.moves[i];
    const cap = isCaptureMove(b, m);
    if (!check && !anti) {
      const promo = mPromo(m) && mFlag(m) !== F_DROP;
      if (!cap && !promo) continue;
      if (delta && cap && !promo) {
        const victim = mFlag(m) === 2 ? 1 : b.sq[mTo(m)] & 7;
        if (stand + VALUE_MG[victim] + 200 < alpha) continue;
      }
    }
    child.copyFrom(b);
    makeMove(child, m);
    if (!legalAfter(child)) continue;
    legal++;
    keys[histLen + ply + 1] = child.key();
    const s = -qsearch(ply + 1, -beta, -alpha, qd + 1);
    if (stopped) return 0;
    if (s > best) {
      best = s;
      if (s > alpha) {
        alpha = s;
        if (s >= beta) break;
      }
    }
  }
  if (check && legal === 0) return -(MATE - ply);
  if (anti && legal === 0) return MATE - ply;
  return best;
}

function negamax(ply: number, depth: number, alpha: number, beta: number, isPv: boolean): number {
  const b = boards[ply];
  T.pvLen[ply] = ply;
  if ((++nodes & 255) === 0) checkLimits();
  if (stopped) return 0;
  if (ply > 0) {
    const ve = variantEnd(b);
    if (ve) return endScore(ve.winner, b, ply);
    if (b.half >= 100 || isRepetition(ply, b)) return 0;
    if (alpha < -(MATE - ply)) alpha = -(MATE - ply);
    if (beta > MATE - ply - 1) beta = MATE - ply - 1;
    if (alpha >= beta) return alpha;
  }
  const check = inCheck(b, b.turn);
  if (check && ply < MAX_PLY - 8) depth++;
  if (depth <= 0) return qsearch(ply, alpha, beta, 0);
  if (ply >= MAX_PLY - 2) return evaluate(b);

  const ti = b.hlo & TT_MASK;
  let ttMove = 0;
  if (T.ttFlag[ti] && T.ttLo[ti] === b.hlo && T.ttHi[ti] === b.hhi) {
    ttMove = T.ttMove[ti];
    if (!isPv && T.ttDepth[ti] >= depth) {
      const s = T.scoreAt(ti, ply), f = T.ttFlag[ti];
      if (f === TT_EXACT || (f === TT_LOWER && s >= beta) || (f === TT_UPPER && s <= alpha)) return s;
    }
  }
  const anti = variant === V_ANTI;
  const staticEval = check ? -INF : evaluate(b);
  if (!isPv && !check && !anti && depth <= 3 && Math.abs(beta) < MATE_BOUND && staticEval - 110 * depth >= beta) return staticEval;
  if (!isPv && !check && nullOk && depth >= 3 && staticEval >= beta && hasPieces(b, b.turn)) {
    const c = boards[ply + 1];
    c.copyFrom(b);
    c.toggleAux();
    c.ep = -1;
    c.turn ^= 1;
    c.half++;
    c.toggleAux();
    keys[histLen + ply + 1] = c.key();
    const r = 2 + (depth >= 7 ? 1 : 0);
    const s = -negamax(ply + 1, depth - 1 - r, -beta, -beta + 1, false);
    if (stopped) return 0;
    if (s >= beta) return s >= MATE_BOUND ? beta : s;
  }

  const base = ply * LIST;
  let n = genPseudo(b, T.moves, base);
  if (anti) n = antiFilter(T, b, base, n);
  orderMoves(T, b, base, n, ttMove, ply);
  let best = -INF, bestMove = 0, legal = 0;
  const origAlpha = alpha;
  const child = boards[ply + 1];
  const futile = !isPv && !check && !anti && depth <= 2 && Math.abs(alpha) < MATE_BOUND && staticEval + 130 * depth <= alpha;
  const lmpLimit = !isPv && !check && !anti && depth <= 3 ? 4 + depth * depth * 2 : 9999;
  for (let i = base; i < n; i++) {
    pickNext(T, i, n);
    const m = T.moves[i];
    if (ply === 0 && excluded.includes(m)) continue;
    child.copyFrom(b);
    makeMove(child, m);
    if (!legalAfter(child)) continue;
    legal++;
    keys[histLen + ply + 1] = child.key();
    const quiet = !isCaptureMove(b, m) && !(mPromo(m) && mFlag(m) !== F_DROP);
    if (quiet && legal > 1 && (futile || legal > lmpLimit) && T.scores[i] < 990000 && !inCheck(child, child.turn)) continue;
    let s: number;
    if (legal === 1) s = -negamax(ply + 1, depth - 1, -beta, -alpha, isPv);
    else {
      let red = 0;
      if (depth >= 3 && legal > 3 && quiet && !check && T.scores[i] < 990000) {
        red = LMR[Math.min(63, depth) * 64 + Math.min(63, legal)] + (isPv ? 0 : 1) - (T.scores[i] > 20000 ? 1 : 0);
        if (red < 1) red = 1;
        if (red > depth - 2) red = depth - 2;
      }
      s = -negamax(ply + 1, depth - 1 - red, -alpha - 1, -alpha, false);
      if (s > alpha && red) s = -negamax(ply + 1, depth - 1, -alpha - 1, -alpha, false);
      if (s > alpha && s < beta) s = -negamax(ply + 1, depth - 1, -beta, -alpha, true);
    }
    if (stopped) return 0;
    if (s > best) {
      best = s;
      bestMove = m;
      if (s > alpha) {
        alpha = s;
        const row = ply * (MAX_PLY + 2), next = (ply + 1) * (MAX_PLY + 2);
        T.pv[row + ply] = m;
        for (let j = ply + 1; j < T.pvLen[ply + 1]; j++) T.pv[row + j] = T.pv[next + j];
        T.pvLen[ply] = Math.max(ply + 1, T.pvLen[ply + 1]);
        if (s >= beta) {
          if (quiet) {
            if (T.killers[ply * 2] !== m) {
              T.killers[ply * 2 + 1] = T.killers[ply * 2];
              T.killers[ply * 2] = m;
            }
            const h = b.turn * 4096 + mFrom(m) * 64 + mTo(m);
            T.history[h] = Math.min(900000, T.history[h] + depth * depth);
          }
          break;
        }
      }
    }
  }
  if (legal === 0) {
    if (ply === 0 && excluded.length) return -INF;
    if (anti) return MATE - ply;
    return check ? -(MATE - ply) : 0;
  }
  if (!(ply === 0 && excluded.length)) {
    const flag = best >= beta ? TT_LOWER : best > origAlpha ? TT_EXACT : TT_UPPER;
    T.store(b.hlo, b.hhi, bestMove, best, depth, flag, ply);
  }
  return best;
}

function toLine(score: number, depth: number): PvLine {
  const row = 0;
  const moves: Move[] = [];
  for (let j = 0; j < T.pvLen[0]; j++) moves.push(toPublicMove(T.pv[row + j]));
  const line: PvLine = { moves, depth };
  if (Math.abs(score) >= MATE_BOUND) {
    const plies = MATE - Math.abs(score);
    line.mate = score > 0 ? Math.ceil(plies / 2) : -Math.ceil(plies / 2);
  } else line.scoreCp = score + 0;
  return line;
}

/** Internal: search a raw board; returns lines with their first move codes. */
export function searchBoard(root: Board, history: readonly string[], limits: SearchLimits, onInfo?: (lines: PvLine[]) => void): { lines: PvLine[]; codes: number[] } {
  T = tables();
  const maxDepth = Math.max(1, Math.min(limits.maxDepth ?? 64, MAX_PLY - 10));
  nodes = 0;
  stopped = false;
  nodeLimit = limits.nodes ?? Infinity;
  const start = Date.now();
  const budget = limits.maxMs ?? (limits.nodes || limits.maxDepth ? Infinity : 1000);
  deadline = start + budget;
  variant = root.v;
  nullOk = variant !== V_ANTI && variant !== V_ATOM && !(variant === V_HORDE && root.turn === 0);
  const hist = history.slice(-1000);
  histLen = hist.length;
  for (let i = 0; i < histLen; i++) keys[i] = parseInt(hist[i], 36);
  boards[0].copyFrom(root);
  keys[histLen] = root.key();
  if (histLen && keys[histLen - 1] === keys[histLen]) histLen--;
  if (variantEnd(root)) return { lines: [], codes: [] };
  const legalBuf = new Int32Array(LIST);
  const legalN = genLegal(root, legalBuf, 0, rootTmp);
  if (!legalN) return { lines: [], codes: [] };
  const multi = Math.max(1, Math.min(limits.multiPv ?? 1, legalN));
  for (let i = 0; i < T.killers.length; i++) T.killers[i] = 0;
  for (let i = 0; i < T.history.length; i++) T.history[i] >>= 2;
  let lines: PvLine[] = [], codes: number[] = [];
  let prevScore = 0;
  for (let depth = 1; depth <= maxDepth; depth++) {
    excluded = [];
    const cur: PvLine[] = [], curCodes: number[] = [];
    for (let k = 0; k < multi; k++) {
      let alpha = -INF, beta = INF, s = 0;
      if (k === 0 && depth >= 4 && Math.abs(prevScore) < MATE_BOUND) {
        let w = 35;
        alpha = prevScore - w;
        beta = prevScore + w;
        for (;;) {
          s = negamax(0, depth, alpha, beta, true);
          if (stopped) break;
          if (s <= alpha) alpha = Math.max(-INF, alpha - w * 3);
          else if (s >= beta) beta = Math.min(INF, beta + w * 3);
          else break;
          w *= 3;
          if (w > 1000) {
            alpha = -INF;
            beta = INF;
          }
        }
      } else s = negamax(0, depth, alpha, beta, true);
      if (stopped || T.pvLen[0] < 1 || s === -INF) break;
      if (k === 0) prevScore = s;
      cur.push(toLine(s, depth));
      curCodes.push(T.pv[0]);
      excluded.push(T.pv[0]);
    }
    if (stopped && lines.length) {
      if (cur.length && cur[0].moves.length) {
        // A finished first line at the new depth beats the old one.
        lines = [cur[0], ...lines.filter((_l, i) => codes[i] !== curCodes[0])].slice(0, multi);
        codes = [curCodes[0], ...codes.filter((c) => c !== curCodes[0])].slice(0, multi);
      }
      break;
    }
    if (cur.length) {
      const order = cur.map((_, i) => i).sort((a, c) => score(cur[c]) - score(cur[a]));
      lines = order.map((i) => cur[i]);
      codes = order.map((i) => curCodes[i]);
      onInfo?.(lines);
    }
    if (stopped) break;
    const top = lines[0];
    if (top?.mate !== undefined && depth >= Math.abs(top.mate) * 2 + 2) break;
    if (legalN === 1 && depth >= 4 && multi === 1) break;
    if (Date.now() - start > budget * 0.55) break;
  }
  if (!lines.length) {
    const m = legalBuf[0];
    lines = [{ moves: [toPublicMove(m)], depth: 0, scoreCp: evaluate(root) }];
    codes = [m];
  }
  return { lines, codes };
}

const score = (l: PvLine): number => (l.mate !== undefined ? (l.mate > 0 ? MATE - l.mate : -MATE - l.mate) : l.scoreCp ?? 0);

/** Nodes searched by the last search call. */
export const lastNodes = (): number => nodes;

export function search(pos: Position, history: readonly string[], limits: SearchLimits, onInfo?: (lines: PvLine[]) => void): PvLine[] {
  return searchBoard(pos.raw(), history, limits, onInfo).lines;
}
