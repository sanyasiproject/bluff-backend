// Transposition table and shared search buffers (typed arrays, allocated once).
export const MATE = 30000;
export const MATE_BOUND = MATE - 256;
export const INF = 32000;
export const MAX_PLY = 96;
export const LIST = 640;

export const TT_EXACT = 1, TT_LOWER = 2, TT_UPPER = 3;
const TT_BITS = 19;
export const TT_MASK = (1 << TT_BITS) - 1;

export class Tables {
  ttLo = new Int32Array(1 << TT_BITS);
  ttHi = new Int32Array(1 << TT_BITS);
  ttMove = new Int32Array(1 << TT_BITS);
  ttScore = new Int16Array(1 << TT_BITS);
  ttDepth = new Int8Array(1 << TT_BITS);
  ttFlag = new Uint8Array(1 << TT_BITS);
  moves = new Int32Array((MAX_PLY + 2) * LIST);
  scores = new Int32Array((MAX_PLY + 2) * LIST);
  killers = new Int32Array((MAX_PLY + 2) * 2);
  history = new Int32Array(2 * 64 * 64);
  pv = new Int32Array((MAX_PLY + 2) * (MAX_PLY + 2));
  pvLen = new Int32Array(MAX_PLY + 2);

  clear(): void {
    this.ttLo.fill(0);
    this.ttHi.fill(0);
    this.ttMove.fill(0);
    this.ttDepth.fill(0);
    this.ttFlag.fill(0);
    this.history.fill(0);
    this.killers.fill(0);
  }

  // Mate scores are stored relative to the node.
  store(lo: number, hi: number, move: number, score: number, depth: number, flag: number, ply: number): void {
    const i = lo & TT_MASK;
    if (this.ttFlag[i] && this.ttHi[i] === hi && this.ttLo[i] === lo && this.ttDepth[i] > depth && flag !== TT_EXACT) return;
    let s = score;
    if (s >= MATE_BOUND) s += ply;
    else if (s <= -MATE_BOUND) s -= ply;
    this.ttLo[i] = lo;
    this.ttHi[i] = hi;
    this.ttMove[i] = move;
    this.ttScore[i] = s;
    this.ttDepth[i] = Math.max(-1, Math.min(127, depth));
    this.ttFlag[i] = flag;
  }

  scoreAt(i: number, ply: number): number {
    const s = this.ttScore[i];
    if (s >= MATE_BOUND) return s - ply;
    if (s <= -MATE_BOUND) return s + ply;
    return s;
  }
}

let shared: Tables | null = null;
export const tables = (): Tables => {
  if (!shared) shared = new Tables();
  return shared;
};

/** Forget everything learned (new game). */
export function clearEngine(): void {
  tables().clear();
}
