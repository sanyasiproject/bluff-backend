// Immutable chess position for every variant.
import { Board, KING, KING_STEPS, PAWN, colorOf, fileOf } from './core/board.js';
import { boardFen, charRole, parseFen, roleChar, sqName, sqParse, writeFen } from './core/fen.js';
import {
  F_CASTLE, F_DROP, F_EP, genLegal, inCheck, isCaptureMove, makeMove, mFlag, mFrom, mPromo, mTo, mv,
} from './core/movegen.js';
import { insufficientFor, rawOutcome, variantEnd } from './core/rules.js';
import { parseSanCore, sanCore } from './core/san.js';
import { V_960, V_ATOM, V_3C, V_ZH, startFen, variantNum, type ChessVariant } from './variants.js';

export type Color = 'w' | 'b';
export type Role = 'p' | 'n' | 'b' | 'r' | 'q' | 'k';
export interface Piece { color: Color; role: Role }
export type Square = number; // 0 = a1 … 63 = h8
export interface Move { from: Square; to: Square; promotion?: Role; drop?: Role } // drop: from === to
export type ChessEndReason =
  | 'checkmate' | 'stalemate' | 'insufficient' | 'threefold' | 'fiftyMove' | 'variantWin' | 'variantLoss'
  | 'kingOfTheHill' | 'threeCheck' | 'atomicExplosion' | 'hordeDestroyed' | 'raceFinished'
  | 'resign' | 'timeout' | 'agreement' | 'abort';
export interface ChessOutcome { winner: Color | null; reason: ChessEndReason }

export const squareName = (s: Square): string => sqName(s);
export const parseSquare = (s: string): Square | undefined => sqParse(s);
const ROLES: Role[] = ['p', 'p', 'n', 'b', 'r', 'q', 'k'];
export const roleNum = (r: Role): number => charRole(r);
const colorCh = (c: number): Color => (c ? 'b' : 'w');

const tmp = new Board();

export class Position {
  readonly variant: ChessVariant;
  readonly turn: Color;
  private readonly b: Board;
  private legalCache: Int32Array | null = null;

  private constructor(b: Board, variant: ChessVariant) {
    this.b = b;
    this.variant = variant;
    this.turn = colorCh(b.turn);
  }

  static start(variant: ChessVariant, seed960?: number): Position {
    return Position.fromFen(startFen(variant, variant === 'chess960' ? seed960 ?? 518 : 518), variant);
  }

  static fromFen(fen: string, variant: ChessVariant): Position {
    return new Position(parseFen(fen, variantNum(variant)), variant);
  }

  /** Internal board for the engine; do not mutate. */
  raw(): Board {
    return this.b;
  }

  /** Wraps an internal board (copied). */
  static fromRaw(b: Board, variant: ChessVariant): Position {
    return new Position(b.clone(), variant);
  }

  fen(): string {
    return writeFen(this.b);
  }

  /** FEN board part only (with pockets). */
  boardFen(): string {
    return boardFen(this.b);
  }

  /** Repetition key: same for identical positions, side to move, rights, pockets and checks. */
  key(): string {
    return this.b.key().toString(36);
  }

  get halfmoves(): number {
    return this.b.half;
  }

  get fullmoves(): number {
    return this.b.full;
  }

  board(): (Piece | null)[] {
    const out: (Piece | null)[] = [];
    for (let s = 0; s < 64; s++) {
      const c = this.b.sq[s];
      out.push(c ? { color: colorCh(colorOf(c)), role: ROLES[c & 7] } : null);
    }
    return out;
  }

  pieceAt(s: Square): Piece | null {
    const c = this.b.sq[s];
    return c ? { color: colorCh(colorOf(c)), role: ROLES[c & 7] } : null;
  }

  pockets(): { w: Partial<Record<Role, number>>; b: Partial<Record<Role, number>> } | null {
    if (this.b.v !== V_ZH) return null;
    const side = (c: number): Partial<Record<Role, number>> => {
      const o: Partial<Record<Role, number>> = {};
      for (let r = 1; r <= 5; r++) if (this.b.pocket[c * 8 + r]) o[ROLES[r]] = this.b.pocket[c * 8 + r];
      return o;
    };
    return { w: side(0), b: side(1) };
  }

  checks(): { w: number; b: number } | null {
    return this.b.v === V_3C ? { w: this.b.checks[0], b: this.b.checks[1] } : null;
  }

  kingSquare(color: Color): Square | undefined {
    const k = this.b.king[color === 'w' ? 0 : 1];
    return k >= 0 ? k : undefined;
  }

  /** Internal legal move codes (empty once a variant rule ended the game). */
  legalCodes(): Int32Array {
    if (!this.legalCache) {
      if (variantEnd(this.b)) this.legalCache = new Int32Array(0);
      else {
        const buf = new Int32Array(512);
        this.legalCache = buf.slice(0, genLegal(this.b, buf, 0, tmp));
      }
    }
    return this.legalCache;
  }

  legalMoves(): Move[] {
    return Array.from(this.legalCodes(), (m) => this.toMove(m));
  }

  /** Targets per origin square; castling lists both the rook and the king's destination. */
  dests(): Map<Square, Square[]> {
    const map = new Map<Square, Square[]>();
    for (const m of this.legalCodes()) {
      if (mFlag(m) === F_DROP) continue;
      const from = mFrom(m);
      const list = map.get(from) ?? [];
      const add = (t: number) => {
        if (!list.includes(t)) list.push(t);
      };
      add(mTo(m));
      if (mFlag(m) === F_CASTLE) add(this.castleKingDest(m));
      map.set(from, list);
    }
    return map;
  }

  private castleKingDest(m: number): number {
    const from = mFrom(m), back = from & 56;
    return back + (fileOf(mTo(m)) > fileOf(from) ? 6 : 2);
  }

  toMove(m: number): Move {
    const flag = mFlag(m);
    if (flag === F_DROP) return { from: mTo(m), to: mTo(m), drop: ROLES[mPromo(m)] };
    const out: Move = { from: mFrom(m), to: mTo(m) };
    if (mPromo(m)) out.promotion = ROLES[mPromo(m)];
    return out;
  }

  /** Internal code of a legal move, accepting king→destination for castling. */
  codeOf(m: Move): number | undefined {
    const legal = this.legalCodes();
    if (m.drop) {
      const role = roleNum(m.drop);
      for (const c of legal) if (mFlag(c) === F_DROP && mTo(c) === m.to && mPromo(c) === role) return c;
      return undefined;
    }
    const promo = m.promotion ? roleNum(m.promotion) : 0;
    for (const c of legal) if (mFlag(c) !== F_DROP && mFrom(c) === m.from && mTo(c) === m.to && mPromo(c) === promo) return c;
    for (const c of legal) if (mFlag(c) === F_CASTLE && mFrom(c) === m.from && this.castleKingDest(c) === m.to && !promo) return c;
    return undefined;
  }

  isLegal(m: Move): boolean {
    return this.codeOf(m) !== undefined;
  }

  /** The legal move in canonical form (castling as king→rook), or undefined. */
  normalizeMove(m: Move): Move | undefined {
    const c = this.codeOf(m);
    return c === undefined ? undefined : this.toMove(c);
  }

  play(m: Move): Position {
    const c = this.codeOf(m);
    if (c === undefined) throw new Error(`illegal move ${JSON.stringify(m)}`);
    return this.playCode(c);
  }

  playCode(c: number): Position {
    const b = this.b.clone();
    makeMove(b, c);
    return new Position(b, this.variant);
  }

  inCheck(): boolean {
    return inCheck(this.b, this.b.turn);
  }

  isCapture(m: Move): boolean {
    const c = this.codeOf(m);
    return c !== undefined && isCaptureMove(this.b, c);
  }

  isCastle(m: Move): boolean {
    const c = this.codeOf(m);
    return c !== undefined && mFlag(c) === F_CASTLE;
  }

  /** Atomic: squares whose pieces vanish when m is played (empty if no explosion). */
  explosion(m: Move): Square[] {
    const c = this.codeOf(m);
    if (c === undefined || this.b.v !== V_ATOM || !isCaptureMove(this.b, c)) return [];
    const to = mTo(c);
    const out = [mFrom(c), to];
    if (mFlag(c) === F_EP) out.push(this.b.turn === 0 ? to - 8 : to + 8);
    for (const s of KING_STEPS[to]) if (this.b.sq[s] && (this.b.sq[s] & 7) !== PAWN) out.push(s);
    return out;
  }

  outcome(): ChessOutcome | null {
    const o = rawOutcome(this.b);
    if (!o) return null;
    return { winner: o.winner < 0 ? null : colorCh(o.winner), reason: o.reason };
  }

  /** Lichess-style: could this side never win by any series of moves (used for timeouts)? */
  hasInsufficientMaterial(color: Color): boolean {
    return insufficientFor(this.b, color === 'w' ? 0 : 1);
  }

  san(m: Move): string {
    const c = this.codeOf(m);
    if (c === undefined) throw new Error(`illegal move ${JSON.stringify(m)}`);
    return this.sanOf(c);
  }

  sanOf(c: number): string {
    const legal = this.legalCodes();
    let s = sanCore(this.b, c, legal, legal.length);
    const next = this.playCode(c);
    if (next.inCheck()) s += next.legalCodes().length === 0 ? '#' : '+';
    return s;
  }

  parseSan(san: string): Move | undefined {
    const legal = this.legalCodes();
    const c = parseSanCore(this.b, san, legal, legal.length);
    return c === undefined ? undefined : this.toMove(c);
  }

  uci(m: Move): string {
    const c = this.codeOf(m);
    if (c === undefined) {
      if (m.drop) return `${m.drop.toUpperCase()}@${sqName(m.to)}`;
      return sqName(m.from) + sqName(m.to) + (m.promotion ?? '');
    }
    return this.uciOf(c);
  }

  uciOf(c: number): string {
    const flag = mFlag(c);
    if (flag === F_DROP) return `${roleChar(mPromo(c)).toUpperCase()}@${sqName(mTo(c))}`;
    const to = flag === F_CASTLE && this.b.v !== V_960 ? this.castleKingDest(c) : mTo(c);
    return sqName(mFrom(c)) + sqName(to) + (mPromo(c) ? roleChar(mPromo(c)) : '');
  }

  parseUci(u: string): Move | undefined {
    const t = u.trim();
    const drop = /^([PNBRQ])@([a-h][1-8])$/i.exec(t);
    if (drop) {
      const m: Move = { from: sqParse(drop[2].toLowerCase()) as number, to: sqParse(drop[2].toLowerCase()) as number, drop: drop[1].toLowerCase() as Role };
      return this.normalizeMove(m);
    }
    const re = /^([a-h][1-8])([a-h][1-8])([nbrqk]?)$/.exec(t);
    if (!re) return undefined;
    const m: Move = { from: sqParse(re[1]) as number, to: sqParse(re[2]) as number };
    if (re[3]) m.promotion = re[3] as Role;
    return this.normalizeMove(m);
  }

  /** Is the piece on `from` the side to move's king (helps UIs with castling taps)? */
  isOwnKing(from: Square): boolean {
    const c = this.b.sq[from];
    return (c & 7) === KING && colorOf(c) === this.b.turn;
  }

  /** Internal: code for a raw move triple. */
  static code(from: number, to: number, promo = 0, flag = 0): number {
    return mv(from, to, promo, flag);
  }
}
