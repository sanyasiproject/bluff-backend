// Static evaluation: material, piece-square tables, tapered phases and variant terms.
import { BISHOP, Board, KING, KNIGHT, PAWN, QUEEN, ROOK } from '../core/board.js';
import { attackedBy } from '../core/movegen.js';
import { V_3C, V_ANTI, V_ATOM, V_HORDE, V_KOTH, V_RK, V_ZH } from '../variants.js';

export const VALUE_MG = [0, 100, 320, 330, 480, 950, 0];
export const VALUE_EG = [0, 120, 300, 320, 540, 1000, 0];
const PHASE = [0, 0, 1, 1, 2, 4, 0];

// Piece-square tables from white's view, indexed [role * 64 + square].
const PST_MG = new Int16Array(7 * 64);
const PST_EG = new Int16Array(7 * 64);
const cdist = (s: number): number => Math.max(Math.abs((s & 7) - 3.5), Math.abs((s >> 3) - 3.5));
for (let s = 0; s < 64; s++) {
  const f = s & 7, r = s >> 3, d = cdist(s);
  const centerFile = f === 3 || f === 4;
  PST_MG[PAWN * 64 + s] = [0, 0, 4, 10, 18, 30, 50, 0][r] + (centerFile && (r === 3 || r === 4) ? 14 : 0) + (centerFile && r === 1 ? -6 : 0);
  PST_EG[PAWN * 64 + s] = [0, 0, 8, 16, 30, 52, 85, 0][r];
  PST_MG[KNIGHT * 64 + s] = Math.round(22 - 12 * d) - (r === 0 ? 8 : 0);
  PST_EG[KNIGHT * 64 + s] = Math.round(16 - 10 * d);
  PST_MG[BISHOP * 64 + s] = Math.round(12 - 6 * d) + (f === r || f === 7 - r ? 6 : 0) - (r === 0 ? 6 : 0);
  PST_EG[BISHOP * 64 + s] = Math.round(10 - 5 * d);
  PST_MG[ROOK * 64 + s] = (r === 6 ? 18 : 0) + (f >= 2 && f <= 5 ? 4 : 0);
  PST_EG[ROOK * 64 + s] = r === 6 ? 12 : 0;
  PST_MG[QUEEN * 64 + s] = Math.round(4 - 3 * d) - (r >= 2 && r <= 5 ? 0 : 2);
  PST_EG[QUEEN * 64 + s] = Math.round(10 - 6 * d);
  PST_MG[KING * 64 + s] = r === 0 ? [18, 28, 8, -6, -6, 8, 30, 20][f] : r === 1 ? -8 : -30 - r * 6;
  PST_EG[KING * 64 + s] = Math.round(28 - 14 * d);
}

const fileCount = new Int8Array(16); // [color * 8 + file] pawns
const KOTH_BONUS = [0, 220, 90, 35, 0];
const RK_BONUS = [0, 25, 55, 90, 135, 190, 270, 400];
const THREE_CHECK_BONUS = [0, 140, 420, 3000];

const centerDist = (s: number): number => {
  const f = s & 7, r = s >> 3;
  return Math.max(f < 3 ? 3 - f : f > 4 ? f - 4 : 0, r < 3 ? 3 - r : r > 4 ? r - 4 : 0);
};
const kdist = (a: number, b: number): number => Math.max(Math.abs((a & 7) - (b & 7)), Math.abs((a >> 3) - (b >> 3)));

/** Score in centipawns from the side to move's view. */
export function evaluate(b: Board): number {
  const sq = b.sq, v = b.v;
  if (v === V_ANTI) return evalAnti(b);
  let mg = 0, eg = 0, phase = 0;
  const bishops = [0, 0], nonPawn = [0, 0], pawnsN = [0, 0];
  fileCount.fill(0);
  for (let s = 0; s < 64; s++) {
    const c = sq[s];
    if (!c) continue;
    const role = c & 7, col = (c >> 3) & 1;
    const ps = col ? s ^ 56 : s;
    const sign = col ? -1 : 1;
    mg += sign * (VALUE_MG[role] + PST_MG[role * 64 + ps]);
    eg += sign * (VALUE_EG[role] + PST_EG[role * 64 + ps]);
    phase += PHASE[role];
    if (role === PAWN) {
      fileCount[col * 8 + (s & 7)]++;
      pawnsN[col]++;
    } else if (role !== KING) nonPawn[col] += VALUE_MG[role];
    if (role === BISHOP) bishops[col]++;
  }
  for (let c = 0; c < 2; c++) {
    const sign = c ? -1 : 1;
    if (bishops[c] >= 2) {
      mg += sign * 30;
      eg += sign * 45;
    }
    for (let f = 0; f < 8; f++) {
      const n = fileCount[c * 8 + f];
      if (!n) continue;
      if (n > 1) {
        mg -= sign * 12 * (n - 1);
        eg -= sign * 18 * (n - 1);
      }
      const left = f > 0 ? fileCount[c * 8 + f - 1] : 0, right = f < 7 ? fileCount[c * 8 + f + 1] : 0;
      if (!left && !right) {
        mg -= sign * 10;
        eg -= sign * 14;
      }
    }
  }
  // Passed pawns, rook files and king shelter.
  for (let s = 0; s < 64; s++) {
    const c = sq[s];
    if (!c) continue;
    const role = c & 7, col = (c >> 3) & 1, f = s & 7, sign = col ? -1 : 1;
    if (role === PAWN && v !== V_HORDE) {
      if (isPassed(b, s, col)) {
        const rr = col ? 7 - (s >> 3) : s >> 3;
        mg += sign * [0, 4, 8, 14, 24, 40, 64, 0][rr];
        eg += sign * [0, 10, 18, 30, 50, 80, 120, 0][rr];
      }
    } else if (role === ROOK) {
      if (!fileCount[col * 8 + f]) mg += sign * (fileCount[(col ^ 1) * 8 + f] ? 8 : 18);
    } else if (role === KING && v !== V_RK) {
      mg += sign * shelter(b, s, col);
    }
  }
  if (phase > 24) phase = 24;
  let score = Math.round((mg * phase + eg * (24 - phase)) / 24);
  score += mopUp(b, nonPawn, pawnsN);
  score += variantTerms(b);
  score = b.turn ? -score : score;
  return score + 12;
}

function isPassed(b: Board, s: number, col: number): boolean {
  const f = s & 7;
  const enemy = PAWN | ((col ^ 1) << 3);
  const step = col ? -8 : 8;
  for (let t = s + step; t >= 0 && t < 64; t += step) {
    if ((b.sq[t] & 15) === enemy) return false;
    if (f > 0 && (b.sq[t - 1] & 15) === enemy) return false;
    if (f < 7 && (b.sq[t + 1] & 15) === enemy) return false;
  }
  return true;
}

function shelter(b: Board, k: number, col: number): number {
  const rr = col ? 7 - (k >> 3) : k >> 3;
  if (rr > 1) return b.v === V_ZH || b.v === V_3C ? -30 : 0;
  const own = PAWN | (col << 3);
  const step = col ? -8 : 8;
  let n = 0;
  for (let df = -1; df <= 1; df++) {
    const f = (k & 7) + df;
    if (f < 0 || f > 7) continue;
    const a = k + step + df, c = a + step;
    if (a >= 0 && a < 64 && (b.sq[a] & 15) === own) n += 2;
    else if (c >= 0 && c < 64 && (b.sq[c] & 15) === own) n += 1;
  }
  const w = b.v === V_ZH || b.v === V_3C ? 14 : 6;
  return (n - 4) * w;
}

// Drive a lone king to the edge when far ahead without pawns to promote.
function mopUp(b: Board, nonPawn: number[], pawnsN: number[]): number {
  if (b.v !== 0 && b.v !== 1) return 0;
  const k0 = b.king[0], k1 = b.king[1];
  if (k0 < 0 || k1 < 0) return 0;
  for (let c = 0; c < 2; c++) {
    const o = c ^ 1;
    if (pawnsN[o] === 0 && nonPawn[o] <= 330 && nonPawn[c] >= nonPawn[o] + 400) {
      const loser = o ? k1 : k0, winner = c ? k1 : k0;
      const bonus = Math.round(cdist(loser) * 2) * 10 + (7 - kdist(loser, winner)) * 8;
      return c ? -bonus : bonus;
    }
  }
  return 0;
}

function variantTerms(b: Board): number {
  const v = b.v;
  let s = 0;
  if (v === V_KOTH) {
    for (let c = 0; c < 2; c++) if (b.king[c] >= 0) s += (c ? -1 : 1) * KOTH_BONUS[centerDist(b.king[c])];
  } else if (v === V_3C) {
    s += THREE_CHECK_BONUS[Math.min(3, b.checks[0])] - THREE_CHECK_BONUS[Math.min(3, b.checks[1])];
  } else if (v === V_ZH) {
    for (let r = PAWN; r <= QUEEN; r++) {
      const val = r === PAWN ? 110 : Math.round(VALUE_MG[r] * 0.9);
      s += (b.pocket[r] - b.pocket[8 + r]) * val;
    }
    s += kingZone(b, 0) - kingZone(b, 1);
  } else if (v === V_ATOM) {
    for (let c = 0; c < 2; c++) {
      const k = b.king[c];
      if (k < 0) continue;
      let near = 0;
      for (let t = 0; t < 64; t++) if (b.sq[t] && t !== k && kdist(t, k) === 1 && ((b.sq[t] >> 3) & 1) === c && (b.sq[t] & 7) !== PAWN) near++;
      s += (c ? 1 : -1) * near * 18;
    }
  } else if (v === V_HORDE) {
    for (let t = 8; t < 64; t++) if (b.sq[t] === PAWN) s += (t >> 3) * 4;
  } else if (v === V_RK) {
    for (let c = 0; c < 2; c++) {
      const k = b.king[c];
      if (k < 0) continue;
      const r = k >> 3;
      let pen = 0;
      if (r < 7) {
        for (let df = -1; df <= 1; df++) {
          const f = (k & 7) + df;
          if (f < 0 || f > 7) continue;
          const t = k + 8 + df;
          if (attackedBy(b, t, c ^ 1, false)) pen += 22;
          else if (b.sq[t] && ((b.sq[t] >> 3) & 1) === c) pen += 8;
        }
      }
      s += (c ? -1 : 1) * (RK_BONUS[r] - pen);
    }
  }
  return s;
}

// Crazyhouse king danger: enemy pieces close by and holes next to the king.
function kingZone(b: Board, c: number): number {
  const k = b.king[c];
  if (k < 0) return 0;
  let danger = 0;
  for (let t = 0; t < 64; t++) {
    const x = b.sq[t];
    if (!x || ((x >> 3) & 1) === c) continue;
    const d = kdist(t, k);
    if (d <= 2 && (x & 7) !== PAWN) danger += (x & 7) === QUEEN ? 30 : 15;
  }
  let holes = 0;
  const fk = k & 7, rk = k >> 3;
  for (let df = -1; df <= 1; df++) {
    for (let dr = -1; dr <= 1; dr++) {
      const f = fk + df, r = rk + dr;
      if ((df || dr) && f >= 0 && f < 8 && r >= 0 && r < 8 && !b.sq[r * 8 + f]) holes++;
    }
  }
  const handPieces = b.pocket[(c ^ 1) * 8 + KNIGHT] + b.pocket[(c ^ 1) * 8 + BISHOP] + b.pocket[(c ^ 1) * 8 + ROOK] + b.pocket[(c ^ 1) * 8 + QUEEN];
  return -(danger + holes * (6 + handPieces * 4));
}

function evalAnti(b: Board): number {
  let s = 0;
  const counts = [0, 0];
  for (let t = 0; t < 64; t++) {
    const x = b.sq[t];
    if (!x) continue;
    const col = (x >> 3) & 1;
    counts[col]++;
    const role = x & 7;
    const w = role === PAWN ? 80 : role === KING ? 120 : role === QUEEN ? 160 : 110;
    s += col ? w : -w;
  }
  if (counts[0] === 0) return b.turn ? -20000 : 20000;
  if (counts[1] === 0) return b.turn ? 20000 : -20000;
  return b.turn ? -s : s;
}
