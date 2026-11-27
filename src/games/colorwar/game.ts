import { secureRandom, type RandomInt } from '../../cards.js';
import { GameError } from '../../game.js';
import type { BetResult, ColorWarEvent, GameEvent, PlayerStats, TableGame } from '../../models.js';
import { gameOpt, PARTY_COLORS, type Card, type ColorWarCell, type ColorWarView, type GameConfig } from '../../types.js';
import { applyTap } from './board.js';

/** Colour Wars' per-account counters (stats.perGame.colorwar) */
export type ColorWarTally = { captures: number; bursts: number };

const emptyStats = (): PlayerStats & { tallies: ColorWarTally } => ({
  bluffs: 0,
  caught: 0,
  goodCalls: 0,
  wrongCalls: 0,
  pickedUp: 0,
  plays: 0,
  chances: 0,
  tallies: { captures: 0, bursts: 0 },
});

const ev = (e: ColorWarEvent): GameEvent => ({ kind: 'colorwar', ev: e });

/** how long the app needs to show a tap and its chain, so a bot's next tap waits for it (ms) */
export function showMsOf(waves: number): number {
  return 900 + Math.min(waves, 30) * 380;
}

/** Colour Wars: place 3 dots, then grow your own cells; 4 dots burst into the neighbours and take them; last colour wins */
export class ColorWarGame implements TableGame<Card> {
  readonly hands = new Map<string, Card[]>();
  readonly stats = new Map<string, PlayerStats>();
  readonly kicked = new Set<string>();
  readonly forfeited = new Set<string>();
  readonly teams = null;
  readonly bets: BetResult[] = [];
  readonly endedEarly = false;
  pile: Card[] = [];
  /** finishing order: the winner first, then the knocked-out players, last out last */
  places: string[] = [];
  turnId: string | null = null;
  over = false;
  aborted = false;
  closed = false;
  readonly size: number;
  readonly bots: Set<string>;
  cells: ColorWarCell[];
  /** still to place their first cell */
  readonly firstMove = new Set<string>();
  /** knocked out (no cells left, or walked out), first out first */
  readonly outs: string[] = [];
  last: ColorWarView['last'] = null;
  /** taps so far (last.seq) */
  seq = 0;
  /** goes up with every tap and walk-out: drivers key their timers on it */
  stepSeq = 0;
  /** a bot's pause before its next tap (ms at speed 1) */
  botPaceMs = 1_200;

  constructor(
    readonly order: string[],
    readonly config: GameConfig,
    rand: RandomInt = secureRandom,
    botIds: string[] = [],
    readonly jitter: () => number = Math.random,
  ) {
    if (order.length < 2 || order.length > PARTY_COLORS.length) throw new GameError('Colour Wars needs 2 to 4 players');
    this.size = gameOpt<number>(config, 'size') === 7 ? 7 : 5;
    this.bots = new Set(botIds);
    this.cells = Array.from({ length: this.size * this.size }, () => ({ owner: null, dots: 0 }));
    for (const id of order) {
      this.firstMove.add(id);
      this.stats.set(id, emptyStats());
    }
    this.turnId = order[rand(order.length)];
  }

  hand(_id: string): Card[] {
    return [];
  }

  /** cells held (more is better) */
  handValueOf(id: string): number {
    return -this.cellsOf(id);
  }

  cellsOf(id: string): number {
    return this.cells.filter((c) => c.owner === id).length;
  }

  isOut(id: string): boolean {
    return this.kicked.has(id) || this.forfeited.has(id) || this.outs.includes(id);
  }

  alive(): string[] {
    return this.order.filter((id) => !this.isOut(id));
  }

  inPlay(id: string): boolean {
    return this.order.includes(id) && !this.isOut(id) && !this.over;
  }

  /** cells this player may tap now */
  legal(id: string): number[] {
    const first = this.firstMove.has(id);
    return this.cells.flatMap((c, i) => ((first ? c.owner === null : c.owner === id) ? [i] : []));
  }

  /** a tap: first an empty cell (3 dots), later one of your own (+1); bursts chain and take neighbours */
  tap(id: string, cell: number): GameEvent[] {
    if (this.over) throw new GameError('The game is over');
    if (!this.order.includes(id)) throw new GameError("You're not playing this game");
    if (this.turnId !== id) throw new GameError('Not your turn');
    if (!Number.isInteger(cell) || cell < 0 || cell >= this.cells.length) throw new GameError('Tap a cell on the board');
    const first = this.firstMove.has(id);
    if (first && this.cells[cell].owner !== null) throw new GameError('Pick an empty cell to start');
    if (!first && this.cells[cell].owner !== id) throw new GameError('Tap one of your own cells');
    this.firstMove.delete(id);
    const rivalsWaiting = [...this.firstMove].some((p) => p !== id && !this.isOut(p));
    const { waves, captured } = applyTap(this.size, this.cells, id, cell, first, rivalsWaiting);
    const took = [...captured.values()].reduce((a, b) => a + b, 0);
    const t = this.stats.get(id)!.tallies as ColorWarTally;
    t.captures += took;
    t.bursts += waves.reduce((a, w) => a + w.length, 0);
    this.seq++;
    this.stepSeq++;
    this.last = { seq: this.seq, playerId: id, cell, waves: waves.map((w) => [...w]) };
    this.botPaceMs = showMsOf(waves.length) + this.jitter() * 700;
    const events: GameEvent[] = [ev({ type: 'tap', playerId: id, cell, first, waves: waves.map((w) => [...w]), captured: took })];
    // anyone who has placed and now holds nothing is out, in seat order from the tapper
    for (const p of this.fromSeat(id)) {
      if (this.isOut(p) || this.firstMove.has(p) || this.cellsOf(p) > 0) continue;
      events.push(...this.knockOut(p));
    }
    if (this.alive().length <= 1) return [...events, ...this.end()];
    this.passFrom(id);
    return events;
  }

  private knockOut(id: string): GameEvent[] {
    this.outs.push(id);
    return [ev({ type: 'out', playerId: id, place: this.order.length - this.outs.length + 1 })];
  }

  /** seats starting from this one */
  private fromSeat(id: string): string[] {
    const at = this.order.indexOf(id);
    return this.order.map((_, k) => this.order[(at + k) % this.order.length]);
  }

  private passFrom(id: string): void {
    this.turnId = this.fromSeat(id).slice(1).find((p) => !this.isOut(p)) ?? null;
  }

  private end(): GameEvent[] {
    this.over = true;
    this.turnId = null;
    this.stepSeq++;
    const still = this.alive().sort((a, b) => this.cellsOf(b) - this.cellsOf(a));
    this.places = [...still, ...[...this.outs].reverse()];
    const events: GameEvent[] = [];
    if (still.length === 1 && !this.closed) events.push({ kind: 'finish', playerId: still[0], place: 1 });
    return [...events, { kind: 'gameOver', loserId: null }];
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

  /** the player's cells empty out; a kick leaves no fair winner when only one is left */
  private drop(id: string, kicked: boolean): GameEvent[] {
    this.firstMove.delete(id);
    this.cells = this.cells.map((c) => (c.owner === id ? { owner: null, dots: 0 } : c));
    this.stepSeq++;
    if (this.alive().length <= 1) {
      this.aborted = kicked || this.alive().length === 0;
      return this.end();
    }
    if (this.turnId === id) this.passFrom(id);
    return [];
  }

  /** the last colour standing (stopped early: nobody) */
  winners(): string[] {
    if (this.aborted || !this.over || this.closed) return [];
    return this.places.slice(0, 1);
  }

  losers(): string[] {
    if (this.aborted) return [];
    const won = this.winners();
    if (won.length === 0) return [...this.forfeited];
    return this.order.filter((id) => !won.includes(id) && !this.kicked.has(id));
  }

  /** once over: the winner, then the knocked-out in reverse order (walk-outs and kicks have no place) */
  placeOf(id: string): number | null {
    if (!this.over || this.aborted) return null;
    const at = this.places.indexOf(id);
    return at < 0 ? null : at + 1;
  }

  /** the table as everyone sees it (no secrets) */
  view(): ColorWarView {
    const places: Record<string, number> = {};
    this.outs.forEach((id, i) => (places[id] = this.order.length - i));
    if (this.over && !this.closed && this.places[0]) places[this.places[0]] = 1;
    return {
      size: this.size,
      cells: this.cells.map((c) => ({ ...c })),
      turnId: this.over ? null : this.turnId,
      firstMove: this.order.filter((id) => this.firstMove.has(id)),
      alive: this.alive(),
      last: this.last ? { ...this.last, waves: this.last.waves.map((w) => [...w]) } : null,
      places,
    };
  }
}
