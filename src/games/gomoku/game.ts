import { secureRandom, type RandomInt } from '../../cards.js';
import { GameError } from '../../game.js';
import type { BetResult, GameEvent, GomokuEvent, PlayerStats, TableGame } from '../../models.js';
import { GOMOKU_WIN, gomokuCentre, gomokuSizeOf, type Card, type GameConfig, type GomokuView } from '../../types.js';
import { DIRS, longestAt, runThrough, threatAt } from './shape.js';

/** Five in a Row's per-account counters (stats.perGame.gomoku) */
export type GomokuTally = { fives: number; blocks: number };

const emptyStats = (): PlayerStats & { tallies: GomokuTally } => ({
  bluffs: 0, caught: 0, goodCalls: 0, wrongCalls: 0, pickedUp: 0, plays: 0, chances: 0,
  tallies: { fives: 0, blocks: 0 },
});

const ev = (e: GomokuEvent): GameEvent => ({ kind: 'gomoku', ev: e });

/** Five in a Row: take turns placing stones; the first line of five or more wins; a full board is a draw */
export class GomokuGame implements TableGame<Card> {
  readonly hands = new Map<string, Card[]>();
  readonly stats = new Map<string, PlayerStats>();
  readonly kicked = new Set<string>();
  readonly forfeited = new Set<string>();
  readonly teams = null;
  readonly bets: BetResult[] = [];
  readonly endedEarly = false;
  pile: Card[] = [];
  places: string[] = [];
  turnId: string | null = null;
  over = false;
  aborted = false;
  closed = false;
  readonly size: number;
  readonly bots: Set<string>;
  /** -1 empty, else the seat whose stone it is */
  readonly cells: Int8Array;
  moves = 0;
  last: GomokuView['last'] = null;
  line: number[] | null = null;
  winner: string | null = null;
  draw = false;
  /** each player's longest line so far */
  readonly best = new Map<string, number>();
  stepSeq = 0;

  constructor(
    readonly order: string[],
    readonly config: GameConfig,
    rand: RandomInt = secureRandom,
    botIds: string[] = [],
  ) {
    if (order.length < 2 || order.length > 4) throw new GameError('Five in a Row needs 2 to 4 players');
    this.size = gomokuSizeOf(order.length);
    this.cells = new Int8Array(this.size * this.size).fill(-1);
    this.bots = new Set(botIds);
    for (const id of order) {
      this.stats.set(id, emptyStats());
      this.best.set(id, 0);
    }
    this.turnId = order[rand(order.length)];
  }

  hand(_id: string): Card[] {
    return [];
  }

  handValueOf(id: string): number {
    return -(this.best.get(id) ?? 0);
  }

  isOut(id: string): boolean {
    return this.kicked.has(id) || this.forfeited.has(id);
  }

  inPlay(id: string): boolean {
    return this.order.includes(id) && !this.isOut(id) && !this.over;
  }

  seatOf(id: string): number {
    return this.order.indexOf(id);
  }

  /** seats still playing, in turn order starting after id */
  othersAfter(id: string): string[] {
    const n = this.order.length;
    const at = this.order.indexOf(id);
    const out: string[] = [];
    for (let s = 1; s < n; s++) {
      const o = this.order[(at + s) % n];
      if (!this.isOut(o)) out.push(o);
    }
    return out;
  }

  /** put a stone on point at */
  place(id: string, at: number): GameEvent[] {
    if (this.over) throw new GameError('The game is over');
    if (!this.order.includes(id)) throw new GameError("You're not playing this game");
    if (this.turnId !== id) throw new GameError('Not your turn');
    if (!Number.isInteger(at) || at < 0 || at >= this.cells.length) throw new GameError('Pick a point on the board');
    if (this.cells[at] !== -1) throw new GameError('That point is taken');
    if (this.moves === 0 && at !== gomokuCentre(this.size)) throw new GameError('The first stone goes on the centre point');
    const seat = this.seatOf(id);
    // a block: this point would have given someone else five or an open four
    const blocked = this.othersAfter(id).some((o) => {
      const t = threatAt(this.cells, this.size, at, this.seatOf(o));
      return t.five > 0 || t.openFour > 0;
    });
    const tally = this.stats.get(id)!.tallies as GomokuTally;
    if (blocked) tally.blocks++;
    this.cells[at] = seat;
    this.moves++;
    this.stepSeq++;
    this.last = { seq: this.moves, playerId: id, at };
    const run = longestAt(this.cells, this.size, at, seat);
    if (run.length > (this.best.get(id) ?? 0)) this.best.set(id, run.length);
    const events: GameEvent[] = [ev({ type: 'stone', playerId: id, at, blocked })];
    if (run.length >= GOMOKU_WIN) {
      tally.fives++;
      this.winner = id;
      this.line = run;
      return [...events, ...this.end()];
    }
    if (this.moves === this.cells.length) {
      this.draw = true;
      return [...events, ...this.end()];
    }
    this.turnId = this.othersAfter(id)[0] ?? null;
    return events;
  }

  /** the longest line a seat has anywhere on the board */
  longestOf(seat: number): number {
    let best = 0;
    for (let i = 0; i < this.cells.length; i++) {
      if (this.cells[i] !== seat) continue;
      for (const [dx, dy] of DIRS) best = Math.max(best, runThrough(this.cells, this.size, i, seat, dx, dy).length);
    }
    return best;
  }

  private end(): GameEvent[] {
    this.over = true;
    this.turnId = null;
    this.stepSeq++;
    const still = this.order.filter((p) => !this.isOut(p));
    // the winner first, the rest by their longest line, then turn order
    this.places = [...still].sort((a, b) => (b === this.winner ? 1 : 0) - (a === this.winner ? 1 : 0) || this.best.get(b)! - this.best.get(a)! || this.order.indexOf(a) - this.order.indexOf(b));
    return [{ kind: 'gameOver', loserId: null }];
  }

  leave(id: string): GameEvent[] {
    if (this.over || !this.order.includes(id) || this.isOut(id)) return [];
    this.forfeited.add(id);
    return this.drop(id, false);
  }

  removePlayer(id: string): GameEvent[] {
    if (this.over || !this.order.includes(id) || this.kicked.has(id)) return [];
    this.kicked.add(id);
    return this.drop(id, true);
  }

  close(): GameEvent[] {
    if (this.over) return [];
    this.closed = true;
    return this.end();
  }

  private drop(id: string, kicked: boolean): GameEvent[] {
    this.stepSeq++;
    const still = this.order.filter((p) => !this.isOut(p));
    if (still.length <= 1) {
      // a kick leaves no fair winner; a walk-out hands the game to whoever is left
      this.aborted = kicked || still.length === 0;
      if (!this.aborted) this.winner = still[0];
      return this.end();
    }
    if (this.turnId === id) this.turnId = this.othersAfter(id)[0] ?? null;
    return [];
  }

  winners(): string[] {
    if (this.aborted || !this.over || this.closed || !this.winner) return [];
    return [this.winner];
  }

  losers(): string[] {
    if (this.aborted) return [];
    const won = this.winners();
    if (won.length === 0) return [...this.forfeited];
    return this.order.filter((id) => !won.includes(id) && !this.kicked.has(id));
  }

  /** winner 1; the rest by longest line then turn order; a draw shares first */
  placeOf(id: string): number | null {
    if (!this.over || this.aborted || this.isOut(id) || !this.order.includes(id)) return null;
    if (this.draw || this.closed) return 1;
    const i = this.places.indexOf(id);
    return i < 0 ? null : i + 1;
  }

  view(): GomokuView {
    const places: Record<string, number> = {};
    if (this.over) for (const id of this.order) {
      const p = this.placeOf(id);
      if (p !== null) places[id] = p;
    }
    return {
      size: this.size,
      cells: Array.from(this.cells),
      seats: [...this.order],
      turnId: this.over ? null : this.turnId,
      moves: this.moves,
      last: this.last ? { ...this.last } : null,
      line: this.line ? [...this.line] : null,
      winner: this.winner,
      draw: this.draw,
      best: Object.fromEntries(this.order.map((id) => [id, this.best.get(id)!])),
      places,
    };
  }
}
