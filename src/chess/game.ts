// Game history: moves, repetition, fifty-move rule and PGN.
import { Position, type ChessOutcome, type Move } from './position.js';
import { CHESS_VARIANTS, startFen, type ChessVariant } from './variants.js';

export class ChessGame {
  readonly variant: ChessVariant;
  readonly startFen: string;
  readonly moves: Move[] = [];
  private readonly positions: Position[];
  private readonly sans: string[] = [];
  private readonly ucis: string[] = [];

  constructor(variant: ChessVariant, startFenText?: string) {
    this.variant = variant;
    const p = startFenText ? Position.fromFen(startFenText, variant) : Position.start(variant);
    this.startFen = p.fen();
    this.positions = [p];
  }

  /** Builds a game from a start FEN and a UCI move list (throws on an illegal move). */
  static fromUci(variant: ChessVariant, startFenText: string | undefined, ucis: readonly string[]): ChessGame {
    const g = new ChessGame(variant, startFenText);
    for (const u of ucis) {
      const m = g.position().parseUci(u);
      if (!m) throw new Error(`illegal move ${u}`);
      g.play(m);
    }
    return g;
  }

  get ply(): number {
    return this.moves.length;
  }

  play(m: Move): void {
    const p = this.position();
    const norm = p.normalizeMove(m);
    if (!norm) throw new Error(`illegal move ${JSON.stringify(m)}`);
    this.sans.push(p.san(norm));
    this.ucis.push(p.uci(norm));
    this.moves.push(norm);
    this.positions.push(p.play(norm));
  }

  /** Removes the last move (for takebacks). */
  undo(): Move | undefined {
    if (!this.moves.length) return undefined;
    this.positions.pop();
    this.sans.pop();
    this.ucis.pop();
    return this.moves.pop();
  }

  position(): Position {
    return this.positions[this.positions.length - 1];
  }

  positionAt(ply: number): Position {
    return this.positions[Math.max(0, Math.min(ply, this.positions.length - 1))];
  }

  sanList(): string[] {
    return this.sans.slice();
  }

  uciList(): string[] {
    return this.ucis.slice();
  }

  /** Repetition keys of every position so far (pass to search/botMove). */
  keys(): string[] {
    return this.positions.map((p) => p.key());
  }

  isThreefold(): boolean {
    const cur = this.position();
    const key = cur.key();
    let count = 0;
    const from = Math.max(0, this.positions.length - 1 - cur.halfmoves);
    for (let i = this.positions.length - 1; i >= from; i -= 2) if (this.positions[i].key() === key) count++;
    return count >= 3;
  }

  isFiftyMove(): boolean {
    return this.position().halfmoves >= 100;
  }

  /** Position outcome first, then automatic threefold and fifty-move draws. */
  outcome(): ChessOutcome | null {
    const o = this.position().outcome();
    if (o) return o;
    if (this.isThreefold()) return { winner: null, reason: 'threefold' };
    if (this.isFiftyMove()) return { winner: null, reason: 'fiftyMove' };
    return null;
  }

  pgn(headers: Record<string, string>): string {
    const h: Record<string, string> = { Event: '?', Site: '?', Date: '????.??.??', White: '?', Black: '?', Result: '*', ...headers };
    const name = CHESS_VARIANTS.find((x) => x.id === this.variant)?.name ?? 'Standard';
    if (this.variant !== 'standard' && !h.Variant) h.Variant = name;
    const defaultStart = Position.start(this.variant).fen();
    if (this.startFen !== defaultStart || this.variant === 'chess960') {
      h.SetUp = '1';
      h.FEN = this.startFen;
    }
    const order = ['Event', 'Site', 'Date', 'Round', 'White', 'Black', 'Result'];
    const keys = [...order.filter((k) => k in h), ...Object.keys(h).filter((k) => !order.includes(k))];
    const lines = keys.map((k) => `[${k} "${String(h[k]).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`);
    const start = this.positions[0];
    let num = start.fullmoves;
    let white = start.turn === 'w';
    const tokens: string[] = [];
    this.sans.forEach((san, i) => {
      if (white) tokens.push(`${num}.`);
      else if (i === 0) tokens.push(`${num}...`);
      tokens.push(san);
      if (!white) num++;
      white = !white;
    });
    tokens.push(h.Result);
    const text: string[] = [];
    let line = '';
    for (const t of tokens) {
      if (line && line.length + 1 + t.length > 80) {
        text.push(line);
        line = t;
      } else line = line ? `${line} ${t}` : t;
    }
    if (line) text.push(line);
    return `${lines.join('\n')}\n\n${text.join('\n')}\n`;
  }

  static fromPgn(pgn: string, variant?: ChessVariant): { game: ChessGame; headers: Record<string, string> } {
    const headers: Record<string, string> = {};
    const re = /^\s*\[(\w+)\s+"((?:[^"\\]|\\.)*)"\]\s*$/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(pgn))) headers[m[1]] = m[2].replace(/\\(.)/g, '$1');
    let v: ChessVariant = variant ?? 'standard';
    if (!variant && headers.Variant) {
      const key = headers.Variant.toLowerCase().replace(/[^a-z0-9]/g, '');
      const hit = CHESS_VARIANTS.find((x) => x.id.toLowerCase() === key || x.name.toLowerCase().replace(/[^a-z0-9]/g, '') === key);
      if (hit) v = hit.id;
      else if (key === 'fromposition' || key === 'standard') v = 'standard';
    }
    const game = new ChessGame(v, headers.FEN || (v === 'chess960' ? startFen(v) : undefined));
    const body = pgn
      .replace(/^\s*\[.*\]\s*$/gm, ' ')
      .replace(/\{[^}]*\}/g, ' ')
      .replace(/;[^\n]*/g, ' ')
      .replace(/\$\d+/g, ' ');
    let depth = 0;
    let clean = '';
    for (const ch of body) {
      if (ch === '(') depth++;
      else if (ch === ')') depth = Math.max(0, depth - 1);
      else if (!depth) clean += ch;
    }
    for (const raw of clean.split(/\s+/)) {
      const tok = raw.replace(/^\d+\.(\.\.)?/, '');
      if (!tok || /^(1-0|0-1|1\/2-1\/2|\*)$/.test(tok)) continue;
      const mv = game.position().parseSan(tok);
      if (!mv) throw new Error(`bad PGN move ${tok}`);
      game.play(mv);
    }
    return { game, headers };
  }
}
