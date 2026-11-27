import { secureRandom, type RandomInt } from '../../cards.js';
import { GameError } from '../../game.js';
import type { BetResult, GameEvent, LudoEvent, PlayerStats, TableGame } from '../../models.js';
import { standingsOf } from '../../standings.js';
import {
  gameOpt,
  LUDO_BASE,
  LUDO_HOME,
  LUDO_LAST_RING,
  LUDO_POINTS,
  LUDO_QUICK_HOME,
  LUDO_SEAT_COLORS,
  LUDO_TOKENS,
  ludoIsSafe,
  ludoRingOf,
  type Card,
  type GameConfig,
  type LudoLastMove,
  type LudoMode,
  type LudoSeat,
  type LudoView,
} from '../../types.js';

/** Ludo's per-account counters (LUDO_TALLIES) */
export type LudoTally = { kills: number; killed: number; home: number; sixes: number };

const emptyStats = (): PlayerStats & { tallies: LudoTally } => ({
  bluffs: 0,
  caught: 0,
  goodCalls: 0,
  wrongCalls: 0,
  pickedUp: 0,
  plays: 0,
  chances: 0,
  tallies: { kills: 0, killed: 0, home: 0, sixes: 0 },
});

const ev = (e: LudoEvent): GameEvent => ({ kind: 'ludo', ev: e });

/** Ludo rules: roll, open on a 6, race round the ring and up the lane, knock others home; no cards, so hands stay empty */
export class LudoGame implements TableGame<Card> {
  readonly hands = new Map<string, Card[]>();
  readonly stats = new Map<string, PlayerStats>();
  readonly kicked = new Set<string>();
  readonly forfeited = new Set<string>();
  /** 2v2 with 4 players: 1st & 3rd (red+yellow) against 2nd & 4th (green+blue); null otherwise */
  readonly teams: [string[], string[]] | null;
  readonly bets: BetResult[] = [];
  readonly endedEarly = false;
  pile: Card[] = [];
  places: string[] = [];
  turnId: string | null = null;
  over = false;
  /** stopped by a kick before anyone won: no winner, no coins */
  aborted = false;
  /** ended because no person was left playing */
  closed = false;
  readonly mode: LudoMode;
  readonly seats: LudoSeat[];
  /** the turn's dice, null before its first roll */
  dice: number | null = null;
  rollSeq = 0;
  /** the player on turn rolled and must move (or the room passes for them) */
  rolled = false;
  /** sixes in a row this turn */
  sixes = 0;
  /** goti moves so far */
  seq = 0;
  /** goes up with every roll, move, pass and turn change: drivers key their timers on it */
  stepSeq = 0;
  last: LudoLastMove | null = null;
  /** Timed mode: when time runs out (ms), else null */
  endsAt: number | null = null;
  timedOut = false;
  readonly kills: { by: string; victim: string; at: number }[] = [];
  /** 2v2: the team that won (both home, or the other side walked out) */
  private winningTeam: string[] | null = null;
  /** Master mode: passes in a row only because gotis were locked out of the lane */
  private lockIdle = 0;

  constructor(
    readonly order: string[],
    readonly config: GameConfig,
    private readonly rand: RandomInt = secureRandom,
    now = Date.now(),
  ) {
    if (order.length < 2 || order.length > LUDO_TOKENS) throw new GameError('Ludo needs 2 to 4 players');
    this.mode = gameOpt<LudoMode>(config, 'mode');
    this.teams = config.teams && order.length === 4 ? [[order[0], order[2]], [order[1], order[3]]] : null;
    const colors = LUDO_SEAT_COLORS[order.length as 2 | 3 | 4];
    const start = this.mode === 'quick' ? 0 : LUDO_BASE;
    this.seats = order.map((playerId, i) => ({
      playerId,
      color: colors[i],
      tokens: Array.from({ length: LUDO_TOKENS }, () => start),
      kills: 0,
      home: 0,
      place: null,
      score: 0,
      unlocked: false,
    }));
    for (const id of order) this.stats.set(id, emptyStats());
    if (this.mode === 'timed') this.endsAt = now + gameOpt<number>(config, 'time') * 60_000;
    this.turnId = order[rand(order.length)];
  }

  /** no cards in Ludo */
  hand(_id: string): Card[] {
    return [];
  }

  handValueOf(_id: string): number {
    return 0;
  }

  seatOf(id: string): LudoSeat {
    const s = this.seats.find((x) => x.playerId === id);
    if (!s) throw new GameError("You're not playing this game");
    return s;
  }

  /** gotis home needed to finish */
  get goal(): number {
    return this.mode === 'quick' ? LUDO_QUICK_HOME : LUDO_TOKENS;
  }

  isOut(id: string): boolean {
    return this.kicked.has(id) || this.forfeited.has(id);
  }

  finished(id: string): boolean {
    return this.seatOf(id).home >= this.goal;
  }

  /** still racing: not out and not finished */
  inPlay(id: string): boolean {
    return this.order.includes(id) && !this.isOut(id) && !this.finished(id);
  }

  teamOf(id: string): string[] | null {
    return this.teams?.find((t) => t.includes(id)) ?? null;
  }

  partnerOf(id: string): string | null {
    return this.teamOf(id)?.find((p) => p !== id) ?? null;
  }

  private sameSide(a: string, b: string): boolean {
    return a === b || this.partnerOf(a) === b;
  }

  /** whose gotis this player moves: their own, or (2v2) their partner's once all of theirs are home */
  moverOf(id: string): LudoSeat {
    const p = this.partnerOf(id);
    if (this.finished(id) && p && !this.isOut(p) && !this.finished(p)) return this.seatOf(p);
    return this.seatOf(id);
  }

  get movesFor(): string | null {
    return this.turnId && !this.over ? this.moverOf(this.turnId).playerId : null;
  }

  /** gotis of a seat that can move by this roll */
  legal(seat: LudoSeat, roll: number, ignoreLock = false): number[] {
    const locked = this.mode === 'master' && !seat.unlocked && !ignoreLock;
    return seat.tokens.flatMap((p, i) => {
      if (p >= LUDO_HOME) return [];
      if (p <= LUDO_BASE) return roll === 6 ? [i] : [];
      const to = p + roll;
      if (to > LUDO_HOME || (locked && to > LUDO_LAST_RING)) return [];
      return [i];
    });
  }

  /** gotis the player on turn may move now (empty before rolling, and after a third 6) */
  movable(): number[] {
    if (this.over || !this.turnId || !this.rolled || this.dice === null || this.sixes >= 3) return [];
    return this.legal(this.moverOf(this.turnId), this.dice);
  }

  /** the room plays the next step itself: no move, or only one real choice (gotis on the same square count once) */
  get autoDue(): boolean {
    if (this.over || !this.rolled) return false;
    const m = this.movable();
    if (m.length === 0) return true;
    const seat = this.moverOf(this.turnId!);
    return new Set(m.map((i) => seat.tokens[i])).size === 1;
  }

  /** the forced step: pass when nothing can move, else the one move there is */
  stepAuto(): GameEvent[] {
    if (!this.autoDue || !this.turnId) return [];
    const m = this.movable();
    return m.length === 0 ? this.pass() : this.move(this.turnId, m[0]);
  }

  private tallyOf(id: string): LudoTally {
    return this.stats.get(id)!.tallies as LudoTally;
  }

  private assertTurn(id: string): void {
    if (this.over) throw new GameError('The game is over');
    if (!this.order.includes(id)) throw new GameError("You're not playing this game");
    if (this.turnId !== id) throw new GameError('Not your turn');
  }

  /** roll the dice; a third 6 in a row loses the turn (the room passes it once the dice has been seen) */
  roll(id: string): GameEvent[] {
    this.assertTurn(id);
    if (this.rolled) throw new GameError('Move a goti first');
    const roll = this.rand(6) + 1;
    this.dice = roll;
    this.rollSeq++;
    this.stepSeq++;
    this.rolled = true;
    this.sixes = roll === 6 ? this.sixes + 1 : 0;
    if (roll === 6) this.tallyOf(id).sixes++;
    return [ev({ type: 'roll', playerId: id, roll, sixes: this.sixes })];
  }

  /** move one goti by the roll: knocks opponents off an unsafe square, may finish the player and the game */
  move(id: string, token: number): GameEvent[] {
    this.assertTurn(id);
    if (!this.rolled || this.dice === null) throw new GameError('Roll the dice first');
    if (!Number.isInteger(token) || token < 0 || token >= LUDO_TOKENS) throw new GameError('Pick one of your gotis');
    if (!this.movable().includes(token)) throw new GameError(`That goti can't move ${this.dice}`);
    const roll = this.dice;
    const seat = this.moverOf(id);
    const me = this.seatOf(id);
    const timed = this.mode === 'timed';
    const from = seat.tokens[token];
    const to = from <= LUDO_BASE ? 0 : from + roll;
    seat.tokens[token] = to;
    if (timed) seat.score += LUDO_POINTS.step * (to - Math.max(0, from));
    // knock off every opponent goti on the square unless it's safe
    const captured: { playerId: string; token: number; from: number }[] = [];
    const ring = ludoRingOf(seat.color, to);
    if (ring !== null && !ludoIsSafe(ring)) {
      for (const other of this.seats) {
        if (this.sameSide(other.playerId, seat.playerId)) continue;
        other.tokens.forEach((p, k) => {
          if (ludoRingOf(other.color, p) !== ring) return;
          captured.push({ playerId: other.playerId, token: k, from: p });
          other.tokens[k] = LUDO_BASE;
          if (timed) other.score = Math.max(0, other.score - LUDO_POINTS.step * p);
          this.tallyOf(other.playerId).killed++;
          this.kills.push({ by: id, victim: other.playerId, at: Date.now() });
        });
      }
    }
    if (captured.length > 0) {
      me.kills += captured.length;
      me.unlocked = true;
      seat.unlocked = true;
      this.tallyOf(id).kills += captured.length;
      if (timed) seat.score += LUDO_POINTS.kill * captured.length;
    }
    const home = to === LUDO_HOME;
    if (home) {
      seat.home++;
      this.tallyOf(id).home++;
      if (timed) seat.score += LUDO_POINTS.home;
    }
    const bonus = roll === 6 || captured.length > 0 || home;
    this.seq++;
    this.stepSeq++;
    this.lockIdle = 0;
    this.last = {
      seq: this.seq,
      playerId: id,
      color: seat.color,
      token,
      from,
      to,
      roll,
      captured: captured.map((c) => ({ ...c, color: this.seatOf(c.playerId).color })),
      home,
      bonus,
    };
    const events: GameEvent[] = [ev({ type: 'move', playerId: id, owner: seat.playerId, token, from, to, roll, captured, home, bonus })];
    if (home && seat.home === this.goal && seat.place === null) events.push(...this.finish(seat));
    if (this.over) return events;
    // a bonus roll, unless this player has nothing left to move
    if (bonus && this.canAct(id)) this.rolled = false;
    else this.endTurn(id);
    return events;
  }

  /** no goti could move, or a third 6: a 6 still earns another roll, otherwise the turn moves on */
  private pass(): GameEvent[] {
    const id = this.turnId!;
    const roll = this.dice ?? 0;
    const threeSixes = this.sixes >= 3;
    const events: GameEvent[] = [ev({ type: 'pass', playerId: id, roll, threeSixes })];
    this.stepSeq++;
    // Master: gotis stuck only by the lock for long enough, so the table can't stall
    if (this.mode === 'master' && !threeSixes) {
      const seat = this.moverOf(id);
      this.lockIdle = this.legal(seat, roll, true).length > 0 ? this.lockIdle + 1 : this.lockIdle;
      if (this.lockIdle >= 3 * this.order.length && this.seats.some((s) => !s.unlocked)) {
        for (const s of this.seats) s.unlocked = true;
        this.lockIdle = 0;
        events.push(ev({ type: 'unlock' }));
      }
    }
    if (roll === 6 && !threeSixes) this.rolled = false;
    else this.endTurn(id);
    return events;
  }

  /** a player finished: their place, and maybe the game */
  private finish(seat: LudoSeat): GameEvent[] {
    const id = seat.playerId;
    this.places.push(id);
    seat.place = this.places.length;
    const events: GameEvent[] = [{ kind: 'finish', playerId: id, place: seat.place }];
    if (this.teams) {
      const team = this.teamOf(id)!;
      if (team.every((p) => this.finished(p))) {
        this.winningTeam = [...team];
        return [...events, ...this.end()];
      }
      return events;
    }
    // Quick and Timed end at the first finisher; Classic and Master play on until one is left
    const left = this.order.filter((p) => this.inPlay(p));
    if (this.mode === 'quick' || this.mode === 'timed' || left.length <= 1) return [...events, ...this.end()];
    return events;
  }

  /** can still take a turn: racing, or (2v2) moving for a partner still racing */
  private canAct(id: string): boolean {
    if (this.isOut(id)) return false;
    if (!this.finished(id)) return true;
    const p = this.partnerOf(id);
    return !!p && !this.isOut(p) && !this.finished(p);
  }

  private endTurn(id: string): void {
    this.rolled = false;
    this.sixes = 0;
    this.dice = null;
    this.stepSeq++;
    const n = this.order.length;
    const at = this.order.indexOf(id);
    for (let step = 1; step <= n; step++) {
      const next = this.order[(at + step) % n];
      if (this.canAct(next)) {
        this.turnId = next;
        return;
      }
    }
    this.turnId = null;
  }

  private end(): GameEvent[] {
    this.over = true;
    this.turnId = null;
    this.rolled = false;
    this.stepSeq++;
    return [{ kind: 'gameOver', loserId: null }];
  }

  /** time ran out: everyone is ranked by points */
  timeUp(): GameEvent[] {
    if (this.over) return [];
    this.timedOut = true;
    return this.end();
  }

  /** a player walks out: they lose and still pay; their gotis leave the board */
  leave(id: string): GameEvent[] {
    if (this.over || !this.order.includes(id) || this.isOut(id)) return [];
    if (!this.teams && this.finished(id)) return [];
    this.forfeited.add(id);
    return this.drop(id, false);
  }

  /** the host removed a player: they pay and win nothing */
  removePlayer(id: string): GameEvent[] {
    if (this.over || !this.order.includes(id) || this.kicked.has(id)) return [];
    this.kicked.add(id);
    return this.drop(id, true);
  }

  /** no person is left playing (2v2: stopped unless a team already won) */
  close(): GameEvent[] {
    if (this.over) return [];
    this.closed = true;
    if (this.teams && !this.winningTeam) this.aborted = true;
    return this.end();
  }

  private drop(id: string, kicked: boolean): GameEvent[] {
    const seat = this.seatOf(id);
    if (!this.finished(id)) seat.tokens = seat.tokens.map(() => LUDO_BASE);
    this.stepSeq++;
    if (this.teams) {
      // 2v2: a kick stops the game, a walk-out hands it to the other team
      if (kicked) this.aborted = true;
      else this.winningTeam = this.teams.find((t) => !t.includes(id)) ?? null;
      return this.end();
    }
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

  /** squares a seat's gotis have covered, for ranking those still racing */
  progressOf(id: string): number {
    return this.seatOf(id).tokens.reduce((n, p) => n + Math.max(0, p + 1), 0);
  }

  /** 1st place (Timed: the most points, ties share), or the winning team */
  winners(): string[] {
    if (this.aborted || !this.over) return [];
    if (this.teams) {
      if (this.winningTeam) return [...this.winningTeam];
      return this.mode === 'timed' && this.timedOut ? this.teamScoreWinners() : [];
    }
    if (this.mode === 'timed') return this.scoreWinners();
    return this.places.slice(0, 1);
  }

  private still(): string[] {
    return this.order.filter((id) => !this.isOut(id));
  }

  private scoreWinners(): string[] {
    const still = this.still();
    if (still.length === 0) return [];
    const best = Math.max(...still.map((id) => this.seatOf(id).score));
    return still.filter((id) => this.seatOf(id).score === best);
  }

  private teamScoreWinners(): string[] {
    const total = (team: string[]) => team.filter((id) => !this.isOut(id)).reduce((n, id) => n + this.seatOf(id).score, 0);
    const [a, b] = this.teams!.map(total);
    return a === b ? [...this.teams![0], ...this.teams![1]] : [...this.teams![a > b ? 0 : 1]];
  }

  /** everyone who didn't win (walk-outs included, removed players not) */
  losers(): string[] {
    if (this.aborted) return [];
    const won = this.winners();
    if (won.length === 0) return [...this.forfeited];
    return this.order.filter((id) => !won.includes(id) && !this.kicked.has(id));
  }

  /** once over: finishers in order, then the rest by squares covered (Timed: by points); 2v2: 1 for the winners */
  placeOf(id: string): number | null {
    if (this.teams) return this.winners().includes(id) ? 1 : null;
    return this.standings().get(id) ?? null;
  }

  private standings(): Map<string, number> {
    if (!this.over || this.aborted) return standingsOf(this.places, [], () => 0);
    if (this.mode === 'timed') return standingsOf([], this.still(), (id) => -this.seatOf(id).score);
    return standingsOf(this.places, this.still(), (id) => -this.progressOf(id));
  }

  /** the table as everyone sees it (Ludo has no secrets) */
  view(): LudoView {
    return {
      mode: this.mode,
      seats: this.seats.map((s) => ({ ...s, tokens: [...s.tokens] })),
      turnId: this.over ? null : this.turnId,
      dice: this.dice,
      rollSeq: this.rollSeq,
      rolled: this.rolled,
      movable: this.movable(),
      sixes: this.sixes,
      movesFor: this.movesFor,
      last: this.last ? { ...this.last, captured: this.last.captured.map((c) => ({ ...c })) } : null,
      endsAt: this.endsAt,
      teams: this.teams ? [[...this.teams[0]], [...this.teams[1]]] : null,
      kills: this.kills.map((k) => ({ ...k })),
    };
  }
}
