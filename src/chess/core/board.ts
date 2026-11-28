// Mutable board state shared by the rules and the engine.
import { V_3C, V_ZH } from '../variants.js';

export const PAWN = 1, KNIGHT = 2, BISHOP = 3, ROOK = 4, QUEEN = 5, KING = 6;
export const BLACK_BIT = 8, PROMO_BIT = 16;
export const WHITE = 0, BLACK = 1;

export const roleOf = (code: number): number => code & 7;
export const colorOf = (code: number): number => (code >> 3) & 1;
export const fileOf = (s: number): number => s & 7;
export const rankOf = (s: number): number => s >> 3;

// Attack tables.
function stepTable(steps: readonly [number, number][]): Int8Array[] {
  const out: Int8Array[] = [];
  for (let s = 0; s < 64; s++) {
    const l: number[] = [];
    for (const [df, dr] of steps) {
      const f = fileOf(s) + df, r = rankOf(s) + dr;
      if (f >= 0 && f < 8 && r >= 0 && r < 8) l.push(r * 8 + f);
    }
    out.push(Int8Array.from(l));
  }
  return out;
}
export const KNIGHT_STEPS = stepTable([[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]]);
export const KING_STEPS = stepTable([[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]]);
// Directions 0-3 orthogonal, 4-7 diagonal.
export const DIRS: readonly [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
export const RAYS: Int8Array[] = [];
for (let d = 0; d < 8; d++) {
  for (let s = 0; s < 64; s++) {
    const l: number[] = [];
    let f = fileOf(s) + DIRS[d][0], r = rankOf(s) + DIRS[d][1];
    while (f >= 0 && f < 8 && r >= 0 && r < 8) {
      l.push(r * 8 + f);
      f += DIRS[d][0];
      r += DIRS[d][1];
    }
    RAYS.push(Int8Array.from(l));
  }
}
export const ray = (d: number, s: number): Int8Array => RAYS[d * 64 + s];

// Zobrist keys (two 32-bit halves).
let seed = 0x9e3779b9 | 0;
const rnd = (): number => {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return seed | 0;
};
const table = (n: number): Int32Array => {
  const a = new Int32Array(n);
  for (let i = 0; i < n; i++) a[i] = rnd();
  return a;
};
export const Z_PIECE_LO = table(32 * 64), Z_PIECE_HI = table(32 * 64);
const Z_CASTLE_LO = table(64), Z_CASTLE_HI = table(64);
const Z_EP_LO = table(8), Z_EP_HI = table(8);
export const Z_TURN_LO = rnd(), Z_TURN_HI = rnd();
const Z_POCKET_LO = table(16 * 32), Z_POCKET_HI = table(16 * 32);
const Z_CHECK_LO = table(8), Z_CHECK_HI = table(8);

export class Board {
  sq = new Int8Array(64);
  pocket = new Uint8Array(16); // [color * 8 + role]
  castle = new Int8Array([-1, -1, -1, -1]); // rook squares: w short, w long, b short, b long
  kingFrom = new Int8Array([-1, -1]); // king square castling starts from
  king = new Int8Array([-1, -1]);
  checks = new Uint8Array(2); // checks given (three-check)
  v = 0;
  turn = 0;
  ep = -1;
  half = 0;
  full = 1;
  hlo = 0; // hash of pieces and aux fields
  hhi = 0;

  copyFrom(o: Board): void {
    this.sq.set(o.sq);
    this.pocket.set(o.pocket);
    this.castle.set(o.castle);
    this.kingFrom.set(o.kingFrom);
    this.king.set(o.king);
    this.checks.set(o.checks);
    this.v = o.v;
    this.turn = o.turn;
    this.ep = o.ep;
    this.half = o.half;
    this.full = o.full;
    this.hlo = o.hlo;
    this.hhi = o.hhi;
  }

  clone(): Board {
    const b = new Board();
    b.copyFrom(this);
    return b;
  }

  put(s: number, code: number): void {
    this.sq[s] = code;
    const i = (code & 31) * 64 + s;
    this.hlo ^= Z_PIECE_LO[i];
    this.hhi ^= Z_PIECE_HI[i];
    if ((code & 7) === KING) this.king[(code >> 3) & 1] = s;
  }

  remove(s: number): number {
    const code = this.sq[s];
    if (!code) return 0;
    this.sq[s] = 0;
    const i = (code & 31) * 64 + s;
    this.hlo ^= Z_PIECE_LO[i];
    this.hhi ^= Z_PIECE_HI[i];
    if ((code & 7) === KING && this.king[(code >> 3) & 1] === s) this.king[(code >> 3) & 1] = -1;
    return code;
  }

  // Xor the non-piece state in or out of the hash.
  toggleAux(): void {
    let lo = 0, hi = 0;
    if (this.turn) {
      lo ^= Z_TURN_LO;
      hi ^= Z_TURN_HI;
    }
    for (let i = 0; i < 4; i++) {
      const r = this.castle[i];
      if (r >= 0) {
        lo ^= Z_CASTLE_LO[r];
        hi ^= Z_CASTLE_HI[r];
      }
    }
    if (this.ep >= 0 && this.epCapturable()) {
      lo ^= Z_EP_LO[this.ep & 7];
      hi ^= Z_EP_HI[this.ep & 7];
    }
    if (this.v === V_ZH) {
      for (let i = 0; i < 16; i++) {
        const n = this.pocket[i];
        if (n) {
          const k = i * 32 + (n & 31);
          lo ^= Z_POCKET_LO[k];
          hi ^= Z_POCKET_HI[k];
        }
      }
    } else if (this.v === V_3C) {
      for (let c = 0; c < 2; c++) {
        const k = c * 4 + Math.min(3, this.checks[c]);
        lo ^= Z_CHECK_LO[k];
        hi ^= Z_CHECK_HI[k];
      }
    }
    this.hlo ^= lo;
    this.hhi ^= hi;
  }

  // A pawn of the side to move stands next to the double-pushed pawn.
  epCapturable(): boolean {
    const ep = this.ep;
    const pawnSq = this.turn === WHITE ? ep - 8 : ep + 8;
    const mine = PAWN | (this.turn << 3);
    const f = ep & 7;
    if (f > 0 && (this.sq[pawnSq - 1] & 15) === mine) return true;
    if (f < 7 && (this.sq[pawnSq + 1] & 15) === mine) return true;
    return false;
  }

  rehash(): void {
    this.hlo = 0;
    this.hhi = 0;
    for (let s = 0; s < 64; s++) {
      const c = this.sq[s];
      if (c) {
        const i = (c & 31) * 64 + s;
        this.hlo ^= Z_PIECE_LO[i];
        this.hhi ^= Z_PIECE_HI[i];
      }
    }
    this.toggleAux();
  }

  findKings(): void {
    this.king[0] = this.king[1] = -1;
    for (let s = 0; s < 64; s++) {
      const c = this.sq[s];
      if ((c & 7) === KING && this.king[(c >> 3) & 1] < 0) this.king[(c >> 3) & 1] = s;
    }
  }

  // 53-bit numeric key for repetition checks.
  key(): number {
    return (this.hhi & 0x1fffff) * 4294967296 + (this.hlo >>> 0);
  }
}
