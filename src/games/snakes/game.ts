import { secureRandom, type RandomInt } from '../../cards.js';
import { GameError } from '../../game.js';
import type { BetResult, GameEvent, PlayerStats, SnakesEvent, TableGame } from '../../models.js';
import { standingsOf } from '../../standings.js';
import { gameOpt, LADDERS, SNAKES, SNAKES_BITE_BACK, SNAKES_COLORS, SNAKES_GOAL, type Card, type GameConfig, type SnakesLastMove, type SnakesSeat, type SnakesView } from '../../types.js';

/** Saanp Seedhi's per-account counters (stats.perGame.snakes) */
export type SnakesTally = { ladders: number; snakes: number; bites: number };

const emptyStats = (): PlayerStats & { tallies: SnakesTally } => ({
  bluffs: 0,
  caught: 0,
  goodCalls: 0,
  wrongCalls: 0,
  pickedUp: 0,
  plays: 0,
  chances: 0,
  tallies: { ladders: 0, snakes: 0, bites: 0 },
});

const ev = (e: SnakesEvent): GameEvent => ({ kind: 'snakes', ev: e });

/** how long the app needs to show a roll (dice, hops, slide, bite), so a bot's next roll waits for it (ms) */
export function showMsOf(last: SnakesLastMove | null, moved: boolean): number {
  if (!last || !moved) return 900;
  const hops = last.bounced ? 2 * SNAKES_GOAL - last.from - last.landed : Math.abs(last.landed - last.from);
  return 800 + hops * 170 + (last.via ? 900 : 0) + (last.bitten.length > 0 ? 700 : 0);
}

/** Saanp Seedhi rules: roll, the token moves by itself, ladders up, snakes down, first to 100; no cards */
export class SnakesGame implements TableGame<Card> {
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
  readonly rules: SnakesView['rules'];
  readonly seats: SnakesSeat[];
  readonly bots: Set<string>;
  /** the last roll's number (kept after the turn moves on, so the app can show it) */
  dice: number | null = null;
  rollSeq = 0;
  /** sixes in a row in the latest roller's turn */
  sixes = 0;
  /** token moves so far (last.seq) */
  seq = 0;
  /** goes up with every roll and turn change: drivers key their timers on it */
  stepSeq = 0;
  last: SnakesLastMove | null = null;
  /** the next roll starts a new turn (sixes count from 0) */
  private freshTurn = true;
  /** how long a bot waits before its next roll (ms at speed 1) */
  botPaceMs = 1200;

  constructor(
    readonly order: string[],
    readonly config: GameConfig,
    private readonly rand: RandomInt = secureRandom,
    botIds: string[] = [],
    private readonly jitter: () => number = Math.random,
  ) {
    if (order.length < 2 || order.length > SNAKES_COLORS.length) throw new GameError('Saanp Seedhi needs 2 to 4 players');
    this.rules = {
      exact: gameOpt<boolean>(config, 'exact'),
      six: gameOpt<boolean>(config, 'six'),
      bonus: gameOpt<boolean>(config, 'bonus'),
      bite: gameOpt<boolean>(config, 'bite'),
    };
    this.bots = new Set(botIds);
    this.seats = order.map((playerId, i) => ({ playerId, color: SNAKES_COLORS[i], pos: 0, place: null, ladders: 0, snakes: 0, bites: 0 }));
    for (const id of order) this.stats.set(id, emptyStats());
    this.turnId = order[rand(order.length)];
  }

  hand(_id: string): Card[] {
    return [];
  }

  handValueOf(_id: string): number {
    return 0;
  }

  seatOf(id: string): SnakesSeat {
    const s = this.seats.find((x) => x.playerId === id);
    if (!s) throw new GameError("You're not playing this game");
    return s;
  }

  isOut(id: string): boolean {
    return this.kicked.has(id) || this.forfeited.has(id);
  }

  finished(id: string): boolean {
    return this.seatOf(id).place !== null;
  }

  inPlay(id: string): boolean {
    return this.order.includes(id) && !this.isOut(id) && !this.finished(id);
  }

  private tallyOf(id: string): SnakesTally {
    return this.stats.get(id)!.tallies as SnakesTally;
  }

  /** roll and move: the token walks by itself, then any snake or ladder, then the bite */
  roll(id: string): GameEvent[] {
    if (this.over) throw new GameError('The game is over');
    if (!this.order.includes(id)) throw new GameError("You're not playing this game");
    if (this.turnId !== id) throw new GameError('Not your turn');
    const roll = this.rand(6) + 1;
    if (this.freshTurn) this.sixes = 0;
    this.freshTurn = false;
    this.dice = roll;
    this.rollSeq++;
    this.stepSeq++;
    this.sixes = roll === 6 ? this.sixes + 1 : 0;
    // a third 6 in a row loses the turn, with no move
    if (this.rules.bonus && this.sixes >= 3) {
      this.endTurn(id);
      this.botPaceMs = showMsOf(null, false) + this.jitter() * 700;
      return [ev({ type: 'roll', playerId: id, roll, sixes: this.sixes, moved: false, lost: true })];
    }
    const seat = this.seatOf(id);
    const from = seat.pos;
    // waiting for a 6 to step onto square 1
    if (from === 0 && this.rules.six && roll !== 6) {
      this.endTurn(id);
      this.botPaceMs = showMsOf(null, false) + this.jitter() * 700;
      return [ev({ type: 'roll', playerId: id, roll, sixes: this.sixes, moved: false, lost: false })];
    }
    const events: GameEvent[] = [ev({ type: 'roll', playerId: id, roll, sixes: this.sixes, moved: true, lost: false })];
    const target = from === 0 && this.rules.six ? 1 : from + roll;
    let landed = Math.min(target, SNAKES_GOAL);
    let bounced = false;
    if (target > SNAKES_GOAL && this.rules.exact) {
      landed = 2 * SNAKES_GOAL - target;
      bounced = true;
    }
    let to = landed;
    let via: SnakesLastMove['via'] = null;
    if (SNAKES[landed] !== undefined) {
      to = SNAKES[landed];
      via = { kind: 'snake', from: landed, to };
      seat.snakes++;
      this.tallyOf(id).snakes++;
    } else if (LADDERS[landed] !== undefined) {
      to = LADDERS[landed];
      via = { kind: 'ladder', from: landed, to };
      seat.ladders++;
      this.tallyOf(id).ladders++;
    }
    seat.pos = to;
    // bite: everyone else on the final square goes back (no chain from there)
    const bitten: SnakesLastMove['bitten'] = [];
    if (this.rules.bite && to !== SNAKES_GOAL && to !== 0) {
      for (const other of this.seats) {
        if (other.playerId === id || other.pos !== to || !this.inPlay(other.playerId)) continue;
        const back = Math.max(1, to - SNAKES_BITE_BACK);
        bitten.push({ playerId: other.playerId, from: to, to: back });
        other.pos = back;
      }
      if (bitten.length > 0) {
        seat.bites += bitten.length;
        this.tallyOf(id).bites += bitten.length;
      }
    }
    const done = to === SNAKES_GOAL;
    const bonus = this.rules.bonus && roll === 6 && !done;
    this.seq++;
    this.last = { seq: this.seq, playerId: id, roll, from, landed, to, bounced, via, bitten, bonus };
    events.push(ev({ type: 'move', move: { ...this.last, via: via ? { ...via } : null, bitten: bitten.map((b) => ({ ...b })) } }));
    this.botPaceMs = showMsOf(this.last, true) + this.jitter() * 700;
    if (done) {
      events.push(...this.finish(seat));
      if (this.over) return events;
      this.endTurn(id);
      return events;
    }
    // a 6 with the bonus rule rolls again
    if (!bonus) this.endTurn(id);
    return events;
  }

  /** reached 100: their place, and the game once one player is left */
  private finish(seat: SnakesSeat): GameEvent[] {
    this.places.push(seat.playerId);
    seat.place = this.places.length;
    const events: GameEvent[] = [{ kind: 'finish', playerId: seat.playerId, place: seat.place }];
    const left = this.order.filter((p) => this.inPlay(p));
    if (left.length <= 1) return [...events, ...this.end()];
    return events;
  }

  private endTurn(id: string): void {
    this.freshTurn = true;
    this.stepSeq++;
    const n = this.order.length;
    const at = this.order.indexOf(id);
    for (let step = 1; step <= n; step++) {
      const next = this.order[(at + step) % n];
      if (this.inPlay(next)) {
        this.turnId = next;
        return;
      }
    }
    this.turnId = null;
  }

  private end(): GameEvent[] {
    this.over = true;
    this.turnId = null;
    this.stepSeq++;
    return [{ kind: 'gameOver', loserId: null }];
  }

  /** a player walks out: they lose and still pay; their token leaves the board */
  leave(id: string): GameEvent[] {
    if (this.over || !this.order.includes(id) || this.isOut(id) || this.finished(id)) return [];
    this.forfeited.add(id);
    return this.drop(id, false);
  }

  /** the host removed a player: they pay and win nothing */
  removePlayer(id: string): GameEvent[] {
    if (this.over || !this.order.includes(id) || this.kicked.has(id)) return [];
    this.kicked.add(id);
    return this.drop(id, true);
  }

  /** no person is left playing */
  close(): GameEvent[] {
    if (this.over) return [];
    this.closed = true;
    return this.end();
  }

  private drop(id: string, kicked: boolean): GameEvent[] {
    const seat = this.seatOf(id);
    if (seat.place === null) seat.pos = 0;
    this.stepSeq++;
    const left = this.order.filter((p) => this.inPlay(p));
    if (left.length <= 1) {
      if (this.places.length === 0) {
        // a kick leaves no fair winner; a walk-out hands the game to whoever is left
        if (kicked || !left[0]) {
          this.aborted = kicked;
          return this.end();
        }
        this.places.push(left[0]);
        this.seatOf(left[0]).place = 1;
        return [{ kind: 'finish', playerId: left[0], place: 1 }, ...this.end()];
      }
      return this.end();
    }
    if (this.turnId === id) this.endTurn(id);
    return [];
  }

  /** 1st place */
  winners(): string[] {
    if (this.aborted || !this.over) return [];
    return this.places.slice(0, 1);
  }

  /** everyone who didn't win (walk-outs included, removed players not) */
  losers(): string[] {
    if (this.aborted) return [];
    const won = this.winners();
    if (won.length === 0) return [...this.forfeited];
    return this.order.filter((id) => !won.includes(id) && !this.kicked.has(id));
  }

  /** once over: finishers in order, then the rest by square */
  placeOf(id: string): number | null {
    return this.standings().get(id) ?? null;
  }

  private standings(): Map<string, number> {
    if (!this.over || this.aborted) return standingsOf(this.places, [], () => 0);
    return standingsOf(this.places, this.order.filter((id) => !this.isOut(id)), (id) => -this.seatOf(id).pos);
  }

  /** the table as everyone sees it (no secrets) */
  view(): SnakesView {
    return {
      seats: this.seats.map((s) => ({ ...s })),
      turnId: this.over ? null : this.turnId,
      dice: this.dice,
      rollSeq: this.rollSeq,
      sixes: this.sixes,
      last: this.last ? { ...this.last, via: this.last.via ? { ...this.last.via } : null, bitten: this.last.bitten.map((b) => ({ ...b })) } : null,
      rules: { ...this.rules },
    };
  }
}
