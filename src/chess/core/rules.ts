// Variant endings, outcomes and insufficient material.
import { V_3C, V_960, V_ANTI, V_ATOM, V_HORDE, V_KOTH, V_RK, V_STD, V_ZH } from '../variants.js';
import { BISHOP, Board, KING, KNIGHT, PAWN, QUEEN, ROOK, WHITE, rankOf } from './board.js';
import { genLegal, inCheck, mFrom, mTo } from './movegen.js';

export type EndCode =
  | 'checkmate' | 'stalemate' | 'insufficient' | 'variantWin' | 'variantLoss'
  | 'kingOfTheHill' | 'threeCheck' | 'atomicExplosion' | 'hordeDestroyed' | 'raceFinished';
export interface RawOutcome { winner: number; reason: EndCode } // winner: 0 white, 1 black, -1 draw

const CENTER = [27, 28, 35, 36];
const scratch = new Int32Array(512);
const tmpBoard = new Board();

function blackCanReachGoal(b: Board): boolean {
  const n = genLegal(b, scratch, 0, tmpBoard);
  const k = b.king[1];
  for (let i = 0; i < n; i++) if (mFrom(scratch[i]) === k && rankOf(mTo(scratch[i])) === 7) return true;
  return false;
}

// Ends decided by variant rules alone (before looking at legal moves).
export function variantEnd(b: Board): RawOutcome | null {
  switch (b.v) {
    case V_KOTH:
      for (let c = 0; c < 2; c++) if (CENTER.includes(b.king[c])) return { winner: c, reason: 'kingOfTheHill' };
      return null;
    case V_3C:
      for (let c = 0; c < 2; c++) if (b.checks[c] >= 3) return { winner: c, reason: 'threeCheck' };
      return null;
    case V_ATOM:
      if (b.king[0] < 0) return { winner: 1, reason: 'atomicExplosion' };
      if (b.king[1] < 0) return { winner: 0, reason: 'atomicExplosion' };
      return null;
    case V_HORDE: {
      for (let s = 0; s < 64; s++) if (b.sq[s] && !(b.sq[s] & 8)) return null;
      return { winner: 1, reason: 'hordeDestroyed' };
    }
    case V_RK: {
      const wg = b.king[0] >= 0 && rankOf(b.king[0]) === 7;
      const bg = b.king[1] >= 0 && rankOf(b.king[1]) === 7;
      if (!wg && !bg) return null;
      if (wg && bg) return { winner: -1, reason: 'raceFinished' };
      if (bg) return { winner: 1, reason: 'raceFinished' };
      if (b.turn === 1 && blackCanReachGoal(b)) return null;
      return { winner: 0, reason: 'raceFinished' };
    }
    default:
      return null;
  }
}

const isLight = (s: number): boolean => ((s >> 3) + (s & 7)) % 2 === 1;

// Can color c never win by material, the way Lichess judges it per variant?
export function insufficientFor(b: Board, c: number): boolean {
  const sq = b.sq;
  let own = 0, ownKnights = 0, ownBishops = 0, ownHeavy = 0, ownBishopLight = 0, ownBishopDark = 0;
  let other = 0, otherNonKingQueen = 0, pawns = 0, knights = 0;
  let bishopsLight = 0, bishopsDark = 0;
  for (let s = 0; s < 64; s++) {
    const code = sq[s];
    if (!code) continue;
    const role = code & 7, col = (code >> 3) & 1;
    if (role === PAWN) pawns++;
    if (role === KNIGHT) knights++;
    if (role === BISHOP) {
      if (isLight(s)) bishopsLight++;
      else bishopsDark++;
    }
    if (col === c) {
      own++;
      if (role === KNIGHT) ownKnights++;
      if (role === BISHOP) {
        ownBishops++;
        if (isLight(s)) ownBishopLight++;
        else ownBishopDark++;
      }
      if (role === PAWN || role === ROOK || role === QUEEN) ownHeavy++;
    } else {
      other++;
      if (role !== KING && role !== QUEEN) otherNonKingQueen++;
    }
  }
  switch (b.v) {
    case V_KOTH:
    case V_RK:
    case V_HORDE:
      return false;
    case V_3C:
      return own === 1 && b.king[c] >= 0;
    case V_ZH: {
      for (let i = 0; i < 16; i++) if (b.pocket[i]) return false;
      return own + other <= 2;
    }
    case V_ANTI: {
      if (own === 0) return false;
      if (other === 0) return true;
      if (own + other !== bishopsLight + bishopsDark) return false;
      const otherLight = bishopsLight - ownBishopLight, otherDark = bishopsDark - ownBishopDark;
      return (ownBishopLight === 0 && otherDark === 0) || (ownBishopDark === 0 && otherLight === 0);
    }
    case V_ATOM: {
      if (ownHeavy) return false;
      if (own === 1) return true; // a bare king cannot explode anything
      if (other === 1) {
        if (ownKnights === 1 && own === 2) return true;
        if (ownKnights === 0 && (ownBishopLight === 0 || ownBishopDark === 0)) return true;
      }
      return false;
    }
    default: {
      if (ownHeavy) return false;
      if (ownKnights) return own <= 2 && otherNonKingQueen === 0;
      if (ownBishops) {
        const same = bishopsLight === 0 || bishopsDark === 0;
        return same && pawns === 0 && knights === 0;
      }
      return true;
    }
  }
}

const outBuf = new Int32Array(512);

export function rawOutcome(b: Board): RawOutcome | null {
  const ve = variantEnd(b);
  if (ve) return ve;
  const n = genLegal(b, outBuf, 0, tmpBoard);
  if (n === 0) {
    if (b.v === V_ANTI) return { winner: b.turn, reason: 'variantWin' };
    if (inCheck(b, b.turn)) return { winner: b.turn ^ 1, reason: 'checkmate' };
    return { winner: -1, reason: 'stalemate' };
  }
  if (b.v !== V_STD && b.v !== V_960 && b.v !== V_ATOM && b.v !== V_ANTI && b.v !== V_3C && b.v !== V_ZH) return null;
  if (insufficientFor(b, WHITE) && insufficientFor(b, 1)) return { winner: -1, reason: 'insufficient' };
  return null;
}
