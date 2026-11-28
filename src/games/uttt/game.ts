import { secureRandom, type RandomInt } from '../../cards.js';
import { GameError } from '../../game.js';
import type { BetResult, GameEvent, PlayerStats, TableGame, UtttEvent } from '../../models.js';
import type { Card, GameConfig, UtttBoardState, UtttMark, UtttView } from '../../types.js';
import { UtttCore, type Side } from './core.js';

/** Ultimate Tic-Tac-Toe's per-account counters (stats.perGame.uttt) */
export type UtttTally = { boardsWon: number };

const emptyStats = (): PlayerStats & { tallies: UtttTally } => ({
  bluffs: 0, caught: 0, goodCalls: 0, wrongCalls: 0, pickedUp: 0, plays: 0, chances: 0,
  tallies: { boardsWon: 0 },
});

const ev = (e: UtttEvent): GameEvent => ({ kind: 'uttt', ev: e });
const MARK: Record<number, UtttMark | null> = { 0: null, 1: 'X', 2: 'O' };
const STATE: Record<number, UtttBoardState> = { 0: null, 1: 'X', 2: 'O', 3: 'draw' };

/** Ultimate Tic-Tac-Toe: X and O; the cell you play sends your rival to that small board; three small boards in a line win */
export class UtttGame implements TableGame<Card> {
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
  readonly bots: Set<string>;
  readonly core = new UtttCore();
  /** X moves first */
  readonly x: string;
  readonly o: string;
  last: UtttView['last'] = null;
  winner: string | null = null;
  draw = false;
  stepSeq = 0;

  constructor(
    readonly order: string[],
    readonly config: GameConfig,
    rand: RandomInt = secureRandom,
    botIds: string[] = [],
  ) {
    if (order.length !== 2) throw new GameError('Ultimate Tic-Tac-Toe needs 2 players');
    this.bots = new Set(botIds);
    for (const id of order) this.stats.set(id, emptyStats());
    const first = rand(2);
    this.x = order[first];
    this.o = order[1 - first];
    this.turnId = this.x;
  }

  hand(_id: string): Card[] {
    return [];
  }

  handValueOf(id: string): number {
    return -this.boardsOf(id);
  }

  sideOf(id: string): Side | null {
    return id === this.x ? 1 : id === this.o ? 2 : null;
  }

  idOf(side: Side): string {
    return side === 1 ? this.x : this.o;
  }

  boardsOf(id: string): number {
    const s = this.sideOf(id);
    return s ? [...this.core.boards].filter((b) => b === s).length : 0;
  }

  isOut(id: string): boolean {
    return this.kicked.has(id) || this.forfeited.has(id);
  }

  inPlay(id: string): boolean {
    return this.order.includes(id) && !this.isOut(id) && !this.over;
  }

  /** put my mark in cell of small board */
  place(id: string, board: number, cell: number): GameEvent[] {
    if (this.over) throw new GameError('The game is over');
    if (!this.order.includes(id)) throw new GameError("You're not playing this game");
    if (this.turnId !== id) throw new GameError('Not your turn');
    if (!Number.isInteger(board) || !Number.isInteger(cell) || board < 0 || board > 8 || cell < 0 || cell > 8) throw new GameError('Pick a cell on the board');
    const move = board * 9 + cell;
    if (this.core.boards[board] !== 0) throw new GameError('That small board is already decided');
    if (this.core.forced >= 0 && this.core.forced !== board) throw new GameError('You must play in the glowing board');
    if (this.core.cells[move] !== 0) throw new GameError('That cell is taken');
    const side = this.sideOf(id)!;
    const won = this.core.play(move);
    if (won) (this.stats.get(id)!.tallies as UtttTally).boardsWon++;
    this.stepSeq++;
    this.last = { seq: this.core.moves, playerId: id, board, cell, mark: side === 1 ? 'X' : 'O', won };
    const events: GameEvent[] = [ev({ type: 'mark', playerId: id, board, cell, won, free: this.core.forced < 0 })];
    const r = this.core.result;
    if (r === 1 || r === 2) {
      this.winner = this.idOf(r);
      return [...events, ...this.end()];
    }
    if (r === 3) {
      this.draw = true;
      return [...events, ...this.end()];
    }
    this.turnId = this.idOf(this.core.toMove);
    return events;
  }

  private end(): GameEvent[] {
    this.over = true;
    this.turnId = null;
    this.stepSeq++;
    const still = this.order.filter((p) => !this.isOut(p));
    this.places = this.winner ? [this.winner, ...still.filter((p) => p !== this.winner)] : still;
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

  // with 2 players any walk-out ends it: a kick leaves no fair winner, a walk-out hands it to the other
  private drop(id: string, kicked: boolean): GameEvent[] {
    this.stepSeq++;
    const still = this.order.filter((p) => !this.isOut(p));
    this.aborted = kicked || still.length === 0;
    if (!this.aborted) this.winner = still[0];
    return this.end();
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

  /** winner 1, loser 2; a draw shares first */
  placeOf(id: string): number | null {
    if (!this.over || this.aborted || this.isOut(id) || !this.order.includes(id)) return null;
    return !this.winner || this.winner === id ? 1 : 2;
  }

  view(): UtttView {
    return {
      cells: Array.from(this.core.cells, (c) => MARK[c]),
      boards: Array.from(this.core.boards, (b) => STATE[b]),
      active: this.over ? [] : this.core.activeBoards(),
      x: this.x,
      o: this.o,
      turnId: this.over ? null : this.turnId,
      moves: this.core.moves,
      last: this.last ? { ...this.last } : null,
      line: this.core.bigLine(),
      winner: this.winner,
      draw: this.draw,
    };
  }
}
