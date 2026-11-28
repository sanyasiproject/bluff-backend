// Move generation, make-move and legality for every variant.
import { V_3C, V_ANTI, V_ATOM, V_HORDE, V_RK, V_ZH } from '../variants.js';
import {
  BISHOP, Board, KING, KING_STEPS, KNIGHT, KNIGHT_STEPS, PAWN, PROMO_BIT, QUEEN, ROOK, WHITE, fileOf, rankOf, ray,
} from './board.js';

export const F_NORMAL = 0, F_DOUBLE = 1, F_EP = 2, F_CASTLE = 3, F_DROP = 4;
export const mv = (from: number, to: number, promo = 0, flag = 0): number => from | (to << 6) | (promo << 12) | (flag << 15);
export const mFrom = (m: number): number => m & 63;
export const mTo = (m: number): number => (m >> 6) & 63;
export const mPromo = (m: number): number => (m >> 12) & 7;
export const mFlag = (m: number): number => (m >> 15) & 7;

export const adjacent = (a: number, b: number): boolean =>
  Math.abs(fileOf(a) - fileOf(b)) <= 1 && Math.abs(rankOf(a) - rankOf(b)) <= 1;

// Is square s attacked by color `by`? Kings are skipped when noKing is set.
export function attackedBy(b: Board, s: number, by: number, noKing: boolean): boolean {
  const sq = b.sq, f = s & 7;
  const bb = by << 3;
  if (by === WHITE) {
    if (f > 0 && s >= 9 && (sq[s - 9] & 15) === PAWN) return true;
    if (f < 7 && s >= 7 && (sq[s - 7] & 15) === PAWN) return true;
  } else {
    if (f < 7 && s <= 54 && (sq[s + 9] & 15) === (PAWN | 8)) return true;
    if (f > 0 && s <= 56 && (sq[s + 7] & 15) === (PAWN | 8)) return true;
  }
  const kn = KNIGHT_STEPS[s];
  for (let i = 0; i < kn.length; i++) if ((sq[kn[i]] & 15) === (KNIGHT | bb)) return true;
  if (!noKing) {
    const ks = KING_STEPS[s];
    for (let i = 0; i < ks.length; i++) if ((sq[ks[i]] & 15) === (KING | bb)) return true;
  }
  for (let d = 0; d < 8; d++) {
    const r = ray(d, s);
    for (let i = 0; i < r.length; i++) {
      const c = sq[r[i]];
      if (!c) continue;
      if (((c >> 3) & 1) === by) {
        const role = c & 7;
        if (role === QUEEN || (d < 4 ? role === ROOK : role === BISHOP)) return true;
      }
      break;
    }
  }
  return false;
}

export function inCheck(b: Board, c: number): boolean {
  if (b.v === V_ANTI) return false;
  const k = b.king[c];
  if (k < 0) return false;
  if (b.v === V_ATOM) {
    const ek = b.king[c ^ 1];
    if (ek < 0 || adjacent(k, ek)) return false;
    return attackedBy(b, k, c ^ 1, true);
  }
  return attackedBy(b, k, c ^ 1, false);
}

// Would a king of color c standing on s be attacked?
function kingAttackedAt(b: Board, s: number, c: number): boolean {
  if (b.v === V_ATOM) {
    const ek = b.king[c ^ 1];
    if (ek < 0 || adjacent(s, ek)) return false;
    return attackedBy(b, s, c ^ 1, true);
  }
  return attackedBy(b, s, c ^ 1, false);
}

function pushPawn(out: Int32Array, n: number, from: number, to: number, flag: number, promoRank: boolean, anti: boolean): number {
  if (!promoRank) {
    out[n++] = mv(from, to, 0, flag);
    return n;
  }
  out[n++] = mv(from, to, QUEEN);
  out[n++] = mv(from, to, ROOK);
  out[n++] = mv(from, to, BISHOP);
  out[n++] = mv(from, to, KNIGHT);
  if (anti) out[n++] = mv(from, to, KING);
  return n;
}

// Pseudo-legal moves for the side to move, written from out[n].
export function genPseudo(b: Board, out: Int32Array, n: number, capsOnly = false): number {
  const sq = b.sq, us = b.turn, v = b.v;
  const anti = v === V_ANTI;
  for (let s = 0; s < 64; s++) {
    const code = sq[s];
    if (!code || ((code >> 3) & 1) !== us) continue;
    const role = code & 7;
    if (role === PAWN) {
      const fwd = us === WHITE ? 8 : -8;
      const r = rankOf(s);
      const last = us === WHITE ? 6 : 1;
      const t = s + fwd;
      if (t >= 0 && t < 64) {
        if (!sq[t] && (!capsOnly || r === last)) {
          n = pushPawn(out, n, s, t, 0, r === last, anti);
          const dbl = us === WHITE ? r === 1 || (r === 0 && v === V_HORDE) : r === 6;
          if (dbl && !capsOnly && !sq[t + fwd]) out[n++] = mv(s, t + fwd, 0, 1);
        }
        const f = s & 7;
        for (let df = -1; df <= 1; df += 2) {
          if ((df < 0 && f === 0) || (df > 0 && f === 7)) continue;
          const c = t + df;
          const tc = sq[c];
          if (tc) {
            if (((tc >> 3) & 1) !== us) n = pushPawn(out, n, s, c, 0, r === last, anti);
          } else if (c === b.ep) out[n++] = mv(s, c, 0, 2);
        }
      }
    } else if (role === KNIGHT || role === KING) {
      const st = role === KNIGHT ? KNIGHT_STEPS[s] : KING_STEPS[s];
      const noCap = role === KING && v === V_ATOM;
      for (let i = 0; i < st.length; i++) {
        const t = st[i], tc = sq[t];
        if (!tc) {
          if (!capsOnly) out[n++] = mv(s, t);
        } else if (((tc >> 3) & 1) !== us && !noCap) out[n++] = mv(s, t);
      }
    } else {
      const d0 = role === BISHOP ? 4 : 0, d1 = role === ROOK ? 4 : 8;
      for (let d = d0; d < d1; d++) {
        const r = ray(d, s);
        for (let i = 0; i < r.length; i++) {
          const t = r[i], tc = sq[t];
          if (!tc) {
            if (!capsOnly) out[n++] = mv(s, t);
          } else {
            if (((tc >> 3) & 1) !== us) out[n++] = mv(s, t);
            break;
          }
        }
      }
    }
  }
  if (capsOnly) return n;
  if (!anti && v !== V_RK) n = genCastles(b, out, n);
  if (v === V_ZH) {
    for (let role = PAWN; role <= QUEEN; role++) {
      if (!b.pocket[us * 8 + role]) continue;
      const lo = role === PAWN ? 8 : 0, hi = role === PAWN ? 56 : 64;
      for (let t = lo; t < hi; t++) if (!sq[t]) out[n++] = mv(t, t, role, 4);
    }
  }
  return n;
}

function genCastles(b: Board, out: Int32Array, n: number): number {
  const us = b.turn, k = b.king[us];
  if (k < 0 || k !== b.kingFrom[us]) return n;
  if (b.castle[us * 2] < 0 && b.castle[us * 2 + 1] < 0) return n;
  if (inCheck(b, us)) return n;
  const back = us === WHITE ? 0 : 56;
  for (let side = 0; side < 2; side++) {
    const r = b.castle[us * 2 + side];
    if (r < 0) continue;
    const kd = back + (side === 0 ? 6 : 2), rd = back + (side === 0 ? 5 : 3);
    const lo = Math.min(k, kd, r, rd), hi = Math.max(k, kd, r, rd);
    let ok = true;
    for (let s = lo; s <= hi && ok; s++) if (s !== k && s !== r && b.sq[s]) ok = false;
    if (!ok) continue;
    const kc = b.sq[k];
    b.sq[k] = 0;
    const step = kd > k ? 1 : -1;
    if (k !== kd) for (let s = k + step; s !== kd && ok; s += step) if (kingAttackedAt(b, s, us)) ok = false;
    b.sq[k] = kc;
    if (ok) out[n++] = mv(k, r, 0, 3);
  }
  return n;
}

export const isCaptureMove = (b: Board, m: number): boolean => {
  const f = mFlag(m);
  if (f === F_EP) return true;
  if (f === F_CASTLE || f === F_DROP) return false;
  return b.sq[mTo(m)] !== 0;
};

// Plays move m on b (no legality check).
export function makeMove(b: Board, m: number): void {
  const us = b.turn, them = us ^ 1, v = b.v;
  const from = mFrom(m), to = mTo(m), promo = mPromo(m), flag = mFlag(m);
  b.toggleAux();
  let newEp = -1;
  let resetHalf = false;
  if (flag === F_DROP) {
    b.put(to, promo | (us << 3));
    b.pocket[us * 8 + promo]--;
    resetHalf = promo === PAWN;
  } else if (flag === F_CASTLE) {
    const side = fileOf(to) > fileOf(from) ? 0 : 1;
    const back = us === WHITE ? 0 : 56;
    const kc = b.remove(from), rc = b.remove(to);
    b.put(back + (side === 0 ? 6 : 2), kc);
    b.put(back + (side === 0 ? 5 : 3), rc);
    b.castle[us * 2] = b.castle[us * 2 + 1] = -1;
  } else {
    const piece = b.remove(from);
    const capSq = flag === F_EP ? (us === WHITE ? to - 8 : to + 8) : to;
    const captured = b.remove(capSq);
    if ((piece & 7) === PAWN || captured) resetHalf = true;
    if ((piece & 7) === KING && from === b.kingFrom[us]) b.castle[us * 2] = b.castle[us * 2 + 1] = -1;
    const placed = promo ? promo | (us << 3) | (v === V_ZH ? PROMO_BIT : 0) : piece;
    if (captured && v === V_ATOM) {
      const ks = KING_STEPS[to];
      for (let i = 0; i < ks.length; i++) {
        const c = b.sq[ks[i]];
        if (c && (c & 7) !== PAWN) b.remove(ks[i]);
      }
    } else b.put(to, placed);
    if (captured && v === V_ZH) b.pocket[us * 8 + (captured & PROMO_BIT ? PAWN : captured & 7)]++;
    if (flag === F_DOUBLE) newEp = (from + to) >> 1;
  }
  for (let i = 0; i < 4; i++) {
    const r = b.castle[i];
    if (r < 0) continue;
    const c = i >> 1;
    if ((b.sq[r] & 15) !== (ROOK | (c << 3)) || (b.sq[b.kingFrom[c]] & 15) !== (KING | (c << 3))) b.castle[i] = -1;
  }
  b.ep = newEp;
  b.half = resetHalf ? 0 : b.half + 1;
  if (us === 1) b.full++;
  b.turn = them;
  if (v === V_3C && inCheck(b, them)) b.checks[us]++;
  b.toggleAux();
}

// After makeMove: did the mover leave the position legal?
export function legalAfter(b: Board): boolean {
  const mover = b.turn ^ 1, v = b.v;
  if (v === V_ANTI) return true;
  if (v === V_ATOM) {
    if (b.king[mover] < 0) return false;
    if (b.king[b.turn] < 0) return true;
    return !inCheck(b, mover);
  }
  if (v === V_RK) return !inCheck(b, mover) && !inCheck(b, b.turn);
  if (b.king[mover] < 0) return v === V_HORDE;
  return !inCheck(b, mover);
}

// Legal moves (without the variant-end check), written from out[n].
export function genLegal(b: Board, out: Int32Array, n: number, tmp: Board): number {
  const start = n;
  const end = genPseudo(b, out, n);
  let w = start;
  for (let i = start; i < end; i++) {
    const m = out[i];
    tmp.copyFrom(b);
    makeMove(tmp, m);
    if (legalAfter(tmp)) out[w++] = m;
  }
  if (b.v === V_ANTI) {
    let hasCap = false;
    for (let i = start; i < w && !hasCap; i++) if (isCaptureMove(b, out[i])) hasCap = true;
    if (hasCap) {
      let c = start;
      for (let i = start; i < w; i++) if (isCaptureMove(b, out[i])) out[c++] = out[i];
      w = c;
    }
  }
  return w;
}
