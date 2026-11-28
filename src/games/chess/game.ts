import { secureRandom, type RandomInt } from '../../cards.js';
import { ChessGame as History } from '../../chess/game.js';
import { openingOf } from '../../chess/openings.js';
import { Position } from '../../chess/position.js';
import { GameError } from '../../game.js';
import type { BetResult, ChessEvent, GameEvent, PlayerStats, TableGame } from '../../models.js';
import {
  chessClockOf,
  chessPerfOf,
  chessSpeedOf,
  gameOpt,
  type Card,
  type ChessColor,
  type ChessEndReason,
  type ChessRatingBadge,
  type ChessSpeed,
  type ChessVariant,
  type ChessView,
  type GameConfig,
} from '../../types.js';

/** chess's per-account counters (stats.perGame.chess) */
export type ChessTally = { moves: number; mates: number };

/** timings the tests may shorten */
export const CHESS_TIMING = {
  /** first-move time by speed (ms); untimed games have none */
  firstMoveMs: { bullet: 30_000, blitz: 30_000, rapid: 45_000, classical: 60_000, untimed: 0 } as Record<ChessSpeed, number>,
  /** the shortest a bot takes over a move (ms), so it doesn't feel instant */
  botMinMs: 500,
  /** a bot's pause before answering a draw or takeback offer (ms) */
  botAnswerMs: 900,
};

const other = (c: ChessColor): ChessColor => (c === 'w' ? 'b' : 'w');
const ev = (e: ChessEvent): GameEvent => ({ kind: 'chess', ev: e });
const emptyStats = (): PlayerStats & { tallies: ChessTally } => ({ bluffs: 0, caught: 0, goodCalls: 0, wrongCalls: 0, pickedUp: 0, plays: 0, chances: 0, tallies: { moves: 0, mates: 0 } });

/** the last colours a pair played with, so a rematch swaps them (pair key → who had white, when) */
const lastColors = new Map<string, { white: string; at: number }>();
const REMATCH_MS = 60 * 60_000;
const pairKey = (a: string, b: string) => [a, b].sort().join('|');
/** tests: every game a first game */
export const forgetRematches = (): void => lastColors.clear();

/** a chess game at a table: the rules come from src/chess, the clocks, offers and results live here */
export class ChessTable implements TableGame<Card> {
  readonly hands = new Map<string, Card[]>();
  readonly stats = new Map<string, PlayerStats>();
  readonly kicked = new Set<string>();
  readonly forfeited = new Set<string>();
  readonly teams = null;
  readonly bets: BetResult[] = [];
  readonly endedEarly = false;
  pile: Card[] = [];
  places: string[] = [];
  over = false;
  aborted = false;
  closed = false;

  readonly variant: ChessVariant;
  readonly time: string;
  readonly speed: ChessSpeed;
  readonly perf;
  readonly inc: number;
  readonly initialFen: string;
  colors: { w: string; b: string };
  readonly history: History;
  uci: string[] = [];
  sans: string[] = [];
  /** ms left at the last move (null: untimed) */
  left: { w: number; b: number } | null;
  runningSince: number | null = null;
  abortAt: number | null = null;
  result: { winner: ChessColor | null; reason: ChessEndReason } | null = null;
  drawOffer: ChessColor | null = null;
  takebackOffer: ChessColor | null = null;
  rated: boolean;
  /** account ids by colour (null: guest or bot), set at the start */
  accounts: { w: string | null; b: string | null } = { w: null, b: null };
  names: Record<string, string> = {};
  ratings: Partial<Record<ChessColor, ChessRatingBadge>> = {};
  ratingDiff: { w: number; b: number } | null = null;
  gameId: string | null = null;
  /** the end is being stored (once per game) */
  settling = false;
  /** bot level by member id */
  readonly botLevels = new Map<string, number>();
  readonly startedAt = Date.now();
  /** goes up with every change: drivers key their timers on it */
  stepSeq = 0;
  /** server time; tests replace it */
  now: () => number = () => Date.now();

  constructor(
    readonly order: string[],
    readonly config: GameConfig,
    rand: RandomInt = secureRandom,
    botIds: string[] = [],
    /** tests: start from this position instead */
    startFen?: string,
  ) {
    if (order.length !== 2) throw new GameError('Chess needs exactly 2 players');
    this.variant = gameOpt<ChessVariant>(config, 'variant');
    this.time = gameOpt<string>(config, 'time');
    this.speed = chessSpeedOf(this.time);
    this.perf = chessPerfOf(this.variant, this.time);
    const clock = chessClockOf(this.time);
    this.left = clock ? { w: clock.initialMs, b: clock.initialMs } : null;
    this.inc = clock?.incMs ?? 0;
    const start = startFen ? Position.fromFen(startFen, this.variant) : this.variant === 'chess960' ? Position.start('chess960', rand(960)) : Position.start(this.variant);
    this.initialFen = start.fen();
    this.history = new History(this.variant, this.initialFen);
    const level = Number(gameOpt<number>(config, 'level')) || 3;
    for (const id of botIds) this.botLevels.set(id, level);
    for (const id of order) this.stats.set(id, emptyStats());
    // the host (first seat until onStart says otherwise) gets the colour they chose
    this.colors = this.pickColors(order[0], rand);
    this.rated = gameOpt<string>(config, 'rated') === 'yes' && clock !== null && botIds.length === 0;
    this.armAbort();
  }

  /** the room's seats: the host's colour choice (a rematch swaps), accounts and names; a rated game needs two different accounts */
  seat(seats: { id: string; userId: string | null; name: string; bot: boolean; host: boolean }[]): void {
    const host = seats.find((s) => s.host)?.id ?? this.order[0];
    if (this.uci.length === 0) {
      this.colors = this.pickColors(host, secureRandom);
      this.armAbort();
    }
    for (const s of seats) this.names[s.id] = s.name;
    const acc = (c: ChessColor) => seats.find((s) => s.id === this.colors[c] && !s.bot)?.userId ?? null;
    this.accounts = { w: acc('w'), b: acc('b') };
    if (!this.accounts.w || !this.accounts.b || this.accounts.w === this.accounts.b) this.rated = false;
    lastColors.set(pairKey(this.order[0], this.order[1]), { white: this.colors.w, at: Date.now() });
    if (lastColors.size > 2000) for (const [k, v] of lastColors) if (Date.now() - v.at > REMATCH_MS) lastColors.delete(k);
  }

  private pickColors(host: string, rand: RandomInt): { w: string; b: string } {
    const guest = this.order.find((id) => id !== host)!;
    const last = lastColors.get(pairKey(host, guest));
    // a rematch: colours swap
    if (last && Date.now() - last.at < REMATCH_MS) return last.white === host ? { w: guest, b: host } : { w: host, b: guest };
    const pick = gameOpt<string>(this.config, 'color');
    const hostWhite = pick === 'white' ? true : pick === 'black' ? false : rand(2) === 0;
    return hostWhite ? { w: host, b: guest } : { w: guest, b: host };
  }

  get turn(): ChessColor {
    return this.position().turn;
  }

  get turnId(): string | null {
    return this.over ? null : this.colors[this.turn];
  }

  set turnId(_v: string | null) {
    // the side to move comes from the position
  }

  position(): Position {
    return this.history.position();
  }

  colorOf(id: string): ChessColor | null {
    return this.colors.w === id ? 'w' : this.colors.b === id ? 'b' : null;
  }

  /** ms left for a side right now */
  timeLeft(c: ChessColor, at = this.now()): number | null {
    if (!this.left) return null;
    const running = this.runningSince !== null && !this.over && this.turn === c;
    return running ? this.left[c] - (at - this.runningSince!) : this.left[c];
  }

  hand(_id: string): Card[] {
    return [];
  }

  handValueOf(_id: string): number {
    return 0;
  }

  inPlay(id: string): boolean {
    return this.order.includes(id) && !this.over;
  }

  private armAbort(): void {
    const ms = CHESS_TIMING.firstMoveMs[this.speed];
    this.abortAt = this.uci.length < 2 && ms > 0 && !this.over ? this.now() + ms : null;
  }

  /** a move in UCI at ply (stale plies are refused) */
  play(id: string, uci: string, ply: number): GameEvent[] {
    const c = this.mustMove(id);
    if (ply !== this.uci.length) throw new GameError('The position has changed, try again');
    const pos = this.position();
    const move = pos.parseUci(uci);
    if (!move || !pos.isLegal(move)) throw new GameError('Illegal move');
    const at = this.now();
    // the flag fell before this move arrived
    if (this.flagDue(at)) return this.timeUp();
    if (this.left && this.runningSince !== null) this.left[c] = this.left[c] - (at - this.runningSince) + this.inc;
    const san = pos.san(move);
    const norm = pos.uci(move);
    this.history.play(move);
    this.uci.push(norm);
    this.sans.push(san);
    const t = this.stats.get(id)!.tallies as ChessTally;
    t.moves++;
    // moving answers the other side's draw offer with no; takebacks lapse
    if (this.drawOffer === other(c)) this.drawOffer = null;
    this.takebackOffer = null;
    // clocks run once both sides have moved
    if (this.left && this.uci.length >= 2) this.runningSince = at;
    this.armAbort();
    this.stepSeq++;
    const events: GameEvent[] = [ev({ type: 'move', playerId: id, uci: norm, san, ply: this.uci.length })];
    const end = this.history.position().outcome();
    if (end) {
      if (end.reason === 'checkmate' && end.winner === c) t.mates++;
      return [...events, ...this.end(end.winner, end.reason)];
    }
    if (this.history.isThreefold()) return [...events, ...this.end(null, 'threefold')];
    if (this.history.isFiftyMove()) return [...events, ...this.end(null, 'fiftyMove')];
    return events;
  }

  resign(id: string): GameEvent[] {
    const c = this.mustPlay(id);
    // before both sides moved, giving up is an abort
    if (this.uci.length < 2) return this.abort(id);
    return this.end(other(c), 'resign');
  }

  abort(id: string): GameEvent[] {
    this.mustPlay(id);
    if (this.uci.length >= 2) throw new GameError('Too late to abort, both sides have moved');
    this.aborted = true;
    return this.end(null, 'abort');
  }

  /** offer true: offer, or accept the other side's offer; false: decline it, or take yours back */
  draw(id: string, offer: boolean): GameEvent[] {
    const c = this.mustPlay(id);
    if (offer) {
      if (this.drawOffer === other(c)) return [ev({ type: 'offer', playerId: id, offer: 'draw', answer: 'yes' }), ...this.end(null, 'agreement')];
      if (this.uci.length < 2) throw new GameError('Make a move first');
      if (this.drawOffer === c) return [];
      this.drawOffer = c;
      this.stepSeq++;
      return [ev({ type: 'offer', playerId: id, offer: 'draw', answer: 'ask' })];
    }
    if (!this.drawOffer) return [];
    const theirs = this.drawOffer === other(c);
    this.drawOffer = null;
    this.stepSeq++;
    return theirs ? [ev({ type: 'offer', playerId: id, offer: 'draw', answer: 'no' })] : [];
  }

  /** no accept: ask to take your last move back; accept: answer the other side (casual games only) */
  takeback(id: string, accept?: boolean): GameEvent[] {
    const c = this.mustPlay(id);
    if (this.rated) throw new GameError('No takebacks in rated games');
    if (accept === undefined) {
      if (this.takebackOffer === other(c)) return this.takeback(id, true);
      const mine = this.uci.length - (this.turn === other(c) ? 1 : 2);
      if (mine < 0) throw new GameError('Nothing to take back');
      if (this.takebackOffer === c) return [];
      this.takebackOffer = c;
      this.stepSeq++;
      return [ev({ type: 'offer', playerId: id, offer: 'takeback', answer: 'ask' })];
    }
    if (this.takebackOffer !== other(c)) throw new GameError('No takeback to answer');
    const asker = this.takebackOffer;
    this.takebackOffer = null;
    this.stepSeq++;
    if (!accept) return [ev({ type: 'offer', playerId: id, offer: 'takeback', answer: 'no' })];
    // back to the asker's turn: one ply if they moved last, else two
    const plies = Math.min(this.uci.length, this.turn === other(asker) ? 1 : 2);
    const at = this.now();
    if (this.left && this.runningSince !== null) this.left[this.turn] -= at - this.runningSince;
    this.uci = this.uci.slice(0, this.uci.length - plies);
    this.sans = this.sans.slice(0, this.sans.length - plies);
    for (let i = 0; i < plies; i++) this.history.undo();
    this.drawOffer = null;
    this.runningSince = this.left && this.uci.length >= 2 ? at : null;
    this.armAbort();
    return [ev({ type: 'offer', playerId: id, offer: 'takeback', answer: 'yes' }), ev({ type: 'takeback', plies })];
  }

  /** the side to move ran out of time (or never made a first move): what's due now, [] when nothing is */
  checkTimers(): GameEvent[] {
    if (this.over) return [];
    const at = this.now();
    if (this.abortAt !== null && at >= this.abortAt) {
      this.aborted = true;
      return this.end(null, 'abort');
    }
    return this.flagDue(at) ? this.timeUp() : [];
  }

  flagDue(at = this.now()): boolean {
    const left = this.timeLeft(this.turn, at);
    return !this.over && left !== null && this.runningSince !== null && left <= 0;
  }

  /** the side to move flagged: the other wins, unless they could never mate (then a draw) */
  private timeUp(): GameEvent[] {
    const loser = this.turn;
    if (this.left) this.left[loser] = 0;
    const winner = other(loser);
    return this.end(this.position().hasInsufficientMaterial(winner) ? null : winner, 'timeout');
  }

  private mustPlay(id: string): ChessColor {
    if (this.over) throw new GameError('The game is over');
    const c = this.colorOf(id);
    if (!c) throw new GameError("You're not playing this game");
    return c;
  }

  private mustMove(id: string): ChessColor {
    const c = this.mustPlay(id);
    if (this.turn !== c) throw new GameError('Not your turn');
    return c;
  }

  private end(winner: ChessColor | null, reason: ChessEndReason): GameEvent[] {
    const at = this.now();
    if (this.left && this.runningSince !== null && reason !== 'timeout') this.left[this.turn] = Math.max(0, this.left[this.turn] - (at - this.runningSince));
    this.over = true;
    this.result = { winner, reason };
    this.runningSince = null;
    this.abortAt = null;
    this.drawOffer = null;
    this.takebackOffer = null;
    this.stepSeq++;
    this.places = winner ? [this.colors[winner], this.colors[other(winner)]] : [...this.order];
    return [{ kind: 'gameOver', loserId: winner ? this.colors[other(winner)] : null }];
  }

  /** walking out: an abort before both sides moved, else a loss */
  leave(id: string): GameEvent[] {
    const c = this.colorOf(id);
    if (this.over || !c) return [];
    this.forfeited.add(id);
    if (this.uci.length < 2) {
      this.aborted = true;
      return this.end(null, 'abort');
    }
    return this.end(other(c), 'resign');
  }

  /** a kick leaves no fair result */
  removePlayer(id: string): GameEvent[] {
    if (this.over || !this.colorOf(id)) return [];
    this.kicked.add(id);
    this.aborted = true;
    return this.end(null, 'abort');
  }

  /** stopped with only bots left: no result */
  close(): GameEvent[] {
    if (this.over) return [];
    this.closed = true;
    this.aborted = true;
    return this.end(null, 'abort');
  }

  winners(): string[] {
    return this.over && !this.aborted && this.result?.winner ? [this.colors[this.result.winner]] : [];
  }

  losers(): string[] {
    return this.over && !this.aborted && this.result?.winner ? [this.colors[other(this.result.winner)]] : [];
  }

  /** winner 1, loser 2; a draw shares first */
  placeOf(id: string): number | null {
    if (!this.over || this.aborted || !this.colorOf(id)) return null;
    const w = this.result?.winner;
    return !w || this.colors[w] === id ? 1 : 2;
  }

  /** the opening by the moves so far (Standard only) */
  openingName(): { eco: string; name: string } | null {
    return this.variant === 'standard' ? (openingOf(this.sans) ?? null) : null;
  }

  /** the game as PGN, Lichess-style headers */
  pgn(names: Record<ChessColor, string>): string {
    const r = this.result;
    const res = !r || r.reason === 'abort' ? '*' : r.winner === 'w' ? '1-0' : r.winner === 'b' ? '0-1' : '1/2-1/2';
    const d = new Date(this.startedAt);
    const headers: Record<string, string> = {
      Event: `${this.rated ? 'Rated' : 'Casual'} ${this.perf} game`,
      Site: 'Game Baithak',
      Date: `${d.getUTCFullYear()}.${String(d.getUTCMonth() + 1).padStart(2, '0')}.${String(d.getUTCDate()).padStart(2, '0')}`,
      White: names.w,
      Black: names.b,
      Result: res,
      Variant: VARIANT_PGN[this.variant],
      TimeControl: this.left ? `${chessClockOf(this.time)!.initialMs / 1000}+${this.inc / 1000}` : '-',
      Termination: !r ? 'Unterminated' : r.reason === 'timeout' ? 'Time forfeit' : r.reason === 'abort' ? 'Abandoned' : 'Normal',
    };
    if (this.variant !== 'standard') Object.assign(headers, { FEN: this.initialFen, SetUp: '1' });
    const o = this.openingName();
    if (o) Object.assign(headers, { ECO: o.eco, Opening: o.name });
    return this.history.pgn(headers);
  }

  /** the table as everyone sees it (no secrets in chess) */
  view(): ChessView {
    const pos = this.position();
    const n = this.uci.length;
    const bots: Partial<Record<ChessColor, number>> = {};
    for (const c of ['w', 'b'] as const) {
      const lvl = this.botLevels.get(this.colors[c]);
      if (lvl) bots[c] = lvl;
    }
    const checks = pos.checks();
    const pockets = pos.pockets();
    const o = this.openingName();
    return {
      variant: this.variant,
      time: this.time,
      speed: this.speed,
      fen: pos.fen(),
      initialFen: this.initialFen,
      moves: [...this.uci],
      sans: [...this.sans],
      turn: pos.turn,
      lastMove: n > 0 ? this.uci[n - 1] : null,
      players: { ...this.colors },
      bots,
      clock: this.left ? { w: Math.max(0, this.left.w), b: Math.max(0, this.left.b), runningSince: this.over ? null : this.runningSince, inc: this.inc } : null,
      abortAt: this.over ? null : this.abortAt,
      ...(checks ? { checks } : {}),
      ...(pockets ? { pockets } : {}),
      check: !this.over && pos.inCheck(),
      status: this.over ? 'over' : 'playing',
      ...(this.result ? { result: { ...this.result } } : {}),
      ...(this.drawOffer ? { drawOffer: this.drawOffer } : {}),
      ...(this.takebackOffer ? { takebackOffer: this.takebackOffer } : {}),
      rated: this.rated,
      perf: this.perf,
      ratings: { ...this.ratings },
      ...(this.ratingDiff ? { ratingDiff: { ...this.ratingDiff } } : {}),
      ...(this.gameId ? { gameId: this.gameId } : {}),
      now: this.now(),
      ...(o ? { opening: o } : {}),
    };
  }
}

const VARIANT_PGN: Record<ChessVariant, string> = {
  standard: 'Standard',
  chess960: 'Chess960',
  crazyhouse: 'Crazyhouse',
  kingOfTheHill: 'King of the Hill',
  threeCheck: 'Three-check',
  antichess: 'Antichess',
  atomic: 'Atomic',
  horde: 'Horde',
  racingKings: 'Racing Kings',
};
