import { UTTT_LINES } from '../../types.js';

/** 0 empty / open, 1 X, 2 O; boards also 3 for full with no line */
export type Side = 1 | 2;
export const other = (s: Side): Side => (s === 1 ? 2 : 1);

// the lines through each cell of a 3 × 3
const LINES_AT: number[][][] = Array.from({ length: 9 }, (_, i) => UTTT_LINES.filter((l) => l.includes(i)).map((l) => [...l]));

interface Undo {
  move: number;
  forced: number;
  board: number;
  result: number;
}

/** the whole rules state, small and fast enough for the bots' search; the game and the bots share it */
export class UtttCore {
  readonly cells = new Int8Array(81);
  readonly boards = new Int8Array(9);
  /** the board the side to move must play in, -1 for anywhere open */
  forced = -1;
  toMove: Side = 1;
  moves = 0;
  /** 0 playing, 1 X won, 2 O won, 3 draw */
  result = 0;
  private readonly stack: Undo[] = [];

  clone(): UtttCore {
    const c = new UtttCore();
    c.cells.set(this.cells);
    c.boards.set(this.boards);
    c.forced = this.forced;
    c.toMove = this.toMove;
    c.moves = this.moves;
    c.result = this.result;
    return c;
  }

  /** boards the side to move may play in */
  activeBoards(): number[] {
    if (this.result) return [];
    if (this.forced >= 0) return [this.forced];
    const out: number[] = [];
    for (let b = 0; b < 9; b++) if (this.boards[b] === 0) out.push(b);
    return out;
  }

  /** legal moves as board * 9 + cell */
  legal(): number[] {
    const out: number[] = [];
    for (const b of this.activeBoards()) for (let c = 0; c < 9; c++) if (this.cells[b * 9 + c] === 0) out.push(b * 9 + c);
    return out;
  }

  isLegal(move: number): boolean {
    if (this.result || !Number.isInteger(move) || move < 0 || move >= 81 || this.cells[move] !== 0) return false;
    const b = Math.floor(move / 9);
    return this.boards[b] === 0 && (this.forced < 0 || this.forced === b);
  }

  /** plays a legal move; true when it took its small board */
  play(move: number): boolean {
    const b = Math.floor(move / 9);
    const c = move % 9;
    const s = this.toMove;
    this.stack.push({ move, forced: this.forced, board: this.boards[b], result: this.result });
    this.cells[move] = s;
    this.moves++;
    let won = false;
    for (const l of LINES_AT[c]) {
      if (this.cells[b * 9 + l[0]] === s && this.cells[b * 9 + l[1]] === s && this.cells[b * 9 + l[2]] === s) {
        won = true;
        break;
      }
    }
    if (won) this.boards[b] = s;
    else {
      let full = true;
      for (let k = 0; k < 9; k++) if (this.cells[b * 9 + k] === 0) full = false;
      if (full) this.boards[b] = 3;
    }
    if (this.boards[b] !== 0) this.result = this.bigResult(b);
    this.forced = this.boards[c] === 0 ? c : -1;
    this.toMove = other(s);
    return won;
  }

  undo(): void {
    const u = this.stack.pop()!;
    this.cells[u.move] = 0;
    this.boards[Math.floor(u.move / 9)] = u.board;
    this.forced = u.forced;
    this.result = u.result;
    this.moves--;
    this.toMove = other(this.toMove);
  }

  // after board b was decided: a big line, a draw, or still playing
  private bigResult(b: number): number {
    const s = this.boards[b];
    if (s === 1 || s === 2) for (const l of LINES_AT[b]) if (this.boards[l[0]] === s && this.boards[l[1]] === s && this.boards[l[2]] === s) return s;
    for (let k = 0; k < 9; k++) if (this.boards[k] === 0) return 0;
    return 3;
  }

  /** the winning big line, once won */
  bigLine(): number[] | null {
    if (this.result !== 1 && this.result !== 2) return null;
    const l = UTTT_LINES.find((l) => l.every((b) => this.boards[b] === this.result));
    return l ? [...l] : null;
  }
}
