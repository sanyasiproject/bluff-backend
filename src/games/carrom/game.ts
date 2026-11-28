import { secureRandom, type RandomInt } from '../../cards.js';
import { aimOf, CARROM_SIDES, launchOf, nearestFit, simulate, startCoins, strikerFits, type CarromCoin, type CarromSide } from '../../carrom/index.js';
import { GameError } from '../../game.js';
import type { BetResult, CarromGameEvent, GameEvent, PlayerStats, TableGame } from '../../models.js';
import { CARROM_RULES, CARROM_TURN_MS, gameOpt, type CarromLength, type CarromMode, type CarromShotView, type CarromView, type Card, type GameConfig } from '../../types.js';
import { boardPoints, resolveShot, type QueenState } from './rules.js';

/** Carrom's per-account counters (stats.perGame.carrom) */
export type CarromTally = { pocketed: number; queens: number; fouls: number };

/** the pause after the coins stop before the next shot (ms) */
export const CARROM_PAUSE_MS = 700;
/** a bot's extra pause before its shot (ms: from, plus up to) */
const BOT_PACE = [600, 900] as const;
/** a timed-out shot: soft and straight from the middle */
export const CARROM_SOFT = { x: 0.5, power: 0.3 } as const;

const emptyStats = (): PlayerStats & { tallies: CarromTally } => ({
  bluffs: 0, caught: 0, goodCalls: 0, wrongCalls: 0, pickedUp: 0, plays: 0, chances: 0,
  tallies: { pocketed: 0, queens: 0, fouls: 0 },
});

const ev = (e: CarromGameEvent): GameEvent => ({ kind: 'carrom', ev: e });

/** Carrom: Classic (own colour, cover the queen, 2v2 with 4) or Freestyle (every coin scores); one or more boards */
export class CarromGame implements TableGame<Card> {
  readonly hands = new Map<string, Card[]>();
  readonly stats = new Map<string, PlayerStats>();
  readonly kicked = new Set<string>();
  readonly forfeited = new Set<string>();
  readonly teams: [string[], string[]] | null;
  readonly bets: BetResult[] = [];
  readonly endedEarly = false;
  pile: Card[] = [];
  places: string[] = [];
  turnId: string | null = null;
  over = false;
  aborted = false;
  closed = false;
  readonly mode: CarromMode;
  readonly length: CarromLength;
  readonly bots: Set<string>;
  readonly sides = new Map<string, CarromSide>();
  /** Classic colours by player */
  readonly colors: Map<string, 'w' | 'b'> | null;
  coins: CarromCoin[] = startCoins();
  queen: QueenState = { state: 'board', by: null };
  pocketed = new Map<string, string[]>();
  scores = new Map<string, number>();
  results: { board: number; winners: string[]; points: number }[] = [];
  board = 1;
  breaker: string;
  settleAt = 0;
  deadline: number | null = null;
  /** the shot has settled on the server's clock (bots wait for it) */
  settled = true;
  last: CarromShotView | null = null;
  seq = 0;
  /** goes up with every step: drivers key their timers on it */
  stepSeq = 0;
  botPaceMs: number = BOT_PACE[0];
  /** set when a walk-out or kick decides the game */
  private forcedWinners: string[] | null = null;

  constructor(
    readonly order: string[],
    readonly config: GameConfig,
    _rand: RandomInt = secureRandom,
    botIds: string[] = [],
    readonly jitter: () => number = Math.random,
    readonly now: () => number = Date.now,
  ) {
    if (order.length < 2 || order.length > 4) throw new GameError('Carrom needs 2 to 4 players');
    this.mode = gameOpt<string>(config, 'mode') === 'freestyle' ? 'freestyle' : 'classic';
    this.length = gameOpt<string>(config, 'length') === 'full' ? 'full' : 'quick';
    if (this.mode === 'classic' && order.length === 3) throw new GameError('Classic carrom is for 2 or 4 players (2v2). Pick Freestyle for 3');
    this.bots = new Set(botIds);
    const sides = CARROM_SIDES[order.length as 2 | 3 | 4];
    order.forEach((id, i) => {
      this.sides.set(id, sides[i]);
      this.stats.set(id, emptyStats());
      this.scores.set(id, 0);
      this.pocketed.set(id, []);
    });
    // Classic with 4: partners sit opposite (seats 0 and 2); team 1 plays white and breaks
    this.teams = this.mode === 'classic' && order.length === 4 ? [[order[0], order[2]], [order[1], order[3]]] : null;
    this.colors = this.mode === 'classic' ? new Map(order.map((id, i) => [id, i % 2 === 0 ? 'w' : 'b'])) : null;
    this.breaker = order[0];
    this.turnId = order[0];
    this.deadline = this.now() + CARROM_TURN_MS;
  }

  get boards(): number {
    if (this.length === 'quick') return 1;
    return this.mode === 'freestyle' ? CARROM_RULES.freeBoards : Math.max(CARROM_RULES.maxBoards, this.board);
  }

  hand(_id: string): Card[] {
    return [];
  }

  handValueOf(id: string): number {
    return -(this.scores.get(id) ?? 0);
  }

  isOut(id: string): boolean {
    return this.kicked.has(id) || this.forfeited.has(id);
  }

  inPlay(id: string): boolean {
    return this.order.includes(id) && !this.isOut(id) && !this.over;
  }

  sideOf(id: string): CarromSide {
    return this.sides.get(id)!;
  }

  private tallyOf(id: string): CarromTally {
    return this.stats.get(id)!.tallies as CarromTally;
  }

  /** partners (Classic 2v2) or just me */
  sideMates(id: string): string[] {
    return this.teams?.find((t) => t.includes(id)) ?? [id];
  }

  /** a shot from my baseline; auto: a timed-out turn (the striker may then sit where it must) */
  shoot(id: string, x: number, dx: number, dy: number, power: number, auto = false): GameEvent[] {
    if (this.over) throw new GameError('The game is over');
    if (!this.order.includes(id)) throw new GameError("You're not playing this game");
    if (this.turnId !== id) throw new GameError('Not your turn');
    if (!auto && !this.settled && this.now() < this.settleAt - 300) throw new GameError('Wait for the coins to stop');
    const side = this.sideOf(id);
    const sx = Math.max(0, Math.min(1, x));
    if (!auto && !strikerFits(this.coins, side, sx) && nearestFit(this.coins, side, sx) !== null) throw new GameError("The striker can't sit on a coin");
    const [au, af] = aimOf(dx, dy);
    const p = Math.max(0, Math.min(1, power));
    const before = this.coins.map((c) => ({ ...c }));
    const res = simulate(before, launchOf(side, sx, au, af, p));
    const color = this.colors?.get(id) ?? null;
    const out = resolveShot(this.mode, id, color, before, this.queen, res);
    this.seq++;
    this.stepSeq++;
    this.coins = out.coins;
    this.queen = out.queen;
    // returned coins leave whoever's pile they were in
    for (const list of this.pocketed.values()) for (const r of out.returned) if (list.includes(r)) list.splice(list.indexOf(r), 1);
    this.pocketed.get(id)!.push(...out.kept);
    if (out.given.length > 0) {
      const to = this.nextOf(id, (o) => !this.sideMates(id).includes(o)) ?? id;
      this.pocketed.get(to)!.push(...out.given);
    }
    const t = this.tallyOf(id);
    t.pocketed += out.kept.filter((c) => c !== 'Q').length;
    if (out.queenNote === 'covered') t.queens++;
    if (out.foul) t.fouls++;
    if (this.mode === 'freestyle') this.scores.set(id, this.scores.get(id)! + out.points);
    this.last = {
      seq: this.seq, playerId: id, side, x: sx, dx: au, dy: af, power: p, before, pocketed: res.pocketed, strikerPocketed: res.striker.pocketed,
      foul: out.foul, queen: out.queenNote, returned: out.returned, points: out.points, again: out.again, ms: res.ms, auto,
    };
    const events: GameEvent[] = [ev({ type: 'shot', playerId: id, pocketed: res.pocketed, foul: out.foul, queen: out.queenNote, again: out.again, auto })];
    this.settleAt = this.now() + res.ms + CARROM_PAUSE_MS;
    this.settled = false;
    this.paceBot();
    if (out.cleared) return [...events, ...this.endBoard(id, out.cleared)];
    if (!out.again) this.turnId = this.nextOf(id) ?? id;
    this.deadline = this.settleAt + CARROM_TURN_MS;
    return events;
  }

  /** a timed-out turn: a soft straight shot from the nearest free spot to the middle */
  timeout(): GameEvent[] {
    const id = this.turnId;
    if (this.over || !id) return [];
    const x = nearestFit(this.coins, this.sideOf(id), CARROM_SOFT.x) ?? CARROM_SOFT.x;
    return this.shoot(id, x, 0, 1, CARROM_SOFT.power, true);
  }

  /** the coins have stopped on the server's clock */
  settle(): GameEvent[] {
    this.settled = true;
    this.stepSeq++;
    return [];
  }

  /** the next player in play after `id` (optionally only those `ok` allows) */
  private nextOf(id: string, ok: (o: string) => boolean = () => true): string | null {
    const n = this.order.length;
    const at = this.order.indexOf(id);
    for (let step = 1; step <= n; step++) {
      const o = this.order[(at + step) % n];
      if (this.inPlay(o) && ok(o)) return o;
    }
    return null;
  }

  private endBoard(shooter: string, cleared: 'w' | 'b' | 'all'): GameEvent[] {
    let winners: string[];
    let points = 0;
    if (cleared === 'all') {
      const best = Math.max(...this.order.map((p) => this.scores.get(p)!));
      winners = this.order.filter((p) => this.scores.get(p) === best);
    } else {
      winners = this.order.filter((p) => this.colors!.get(p) === cleared);
      const qBy = this.queen.by;
      points = boardPoints(this.coins, cleared, !!qBy && winners.includes(qBy));
      for (const w of winners) this.scores.set(w, this.scores.get(w)! + points);
    }
    this.results.push({ board: this.board, winners, points });
    const events = [ev({ type: 'board', board: this.board, winners, points })];
    if (this.gameDone()) return [...events, ...this.end()];
    // a new board: the next player breaks
    this.board++;
    this.coins = startCoins();
    this.queen = { state: 'board', by: null };
    for (const list of this.pocketed.values()) list.length = 0;
    this.breaker = this.nextOf(this.breaker) ?? shooter;
    this.turnId = this.breaker;
    this.deadline = this.settleAt + CARROM_TURN_MS;
    return events;
  }

  private gameDone(): boolean {
    if (this.length === 'quick') return true;
    if (this.mode === 'freestyle') return this.board >= CARROM_RULES.freeBoards;
    const scores = this.order.map((p) => this.scores.get(p)!);
    if (Math.max(...scores) >= CARROM_RULES.target) return true;
    // the leader after 8 boards; level scores play on
    return this.board >= CARROM_RULES.maxBoards && Math.max(...scores) !== Math.min(...scores);
  }

  private paceBot(): void {
    this.botPaceMs = BOT_PACE[0] + this.jitter() * BOT_PACE[1];
  }

  private end(): GameEvent[] {
    this.over = true;
    this.turnId = null;
    this.deadline = null;
    this.stepSeq++;
    const ranked = [...this.order].sort((a, b) => (this.placeOf(a) ?? 9) - (this.placeOf(b) ?? 9));
    this.places = ranked.filter((p) => !this.isOut(p));
    return [{ kind: 'gameOver', loserId: null }];
  }

  /** a player walks out: they lose and still pay */
  leave(id: string): GameEvent[] {
    if (this.over || !this.order.includes(id) || this.isOut(id)) return [];
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
    this.stepSeq++;
    if (this.queen.state === 'pending' && this.queen.by === id) this.queen = { state: 'board', by: null };
    const still = this.order.filter((p) => !this.isOut(p));
    // Classic: a side with nobody left loses; Freestyle plays on while 2 are in
    const sidesLeft = this.teams ? this.teams.filter((t) => t.every((p) => !this.isOut(p))) : still.map((p) => [p]);
    if (sidesLeft.length <= 1 || (this.teams && sidesLeft.length < 2)) {
      if (kicked || sidesLeft.length === 0) this.aborted = kicked;
      else this.forcedWinners = sidesLeft[0];
      return this.end();
    }
    if (this.turnId === id) {
      this.turnId = this.nextOf(id);
      this.deadline = Math.max(this.now(), this.settleAt) + CARROM_TURN_MS;
    }
    return [];
  }

  /** the side with the most points (Classic: boards won, then the last board, break ties) */
  winners(): string[] {
    if (this.aborted || !this.over) return [];
    if (this.forcedWinners) return [...this.forcedWinners];
    const live = this.order.filter((p) => !this.isOut(p));
    if (live.length === 0 || this.results.length === 0) return [];
    const best = Math.max(...live.map((p) => this.scores.get(p)!));
    let top = live.filter((p) => this.scores.get(p) === best);
    if (this.mode === 'classic' && top.length > 0 && this.colors && new Set(top.map((p) => this.colors!.get(p))).size > 1) {
      const lastWin = this.results[this.results.length - 1].winners;
      top = top.filter((p) => lastWin.includes(p));
    }
    return top;
  }

  /** everyone who didn't win (walk-outs included, removed players not) */
  losers(): string[] {
    if (this.aborted) return [];
    const won = this.winners();
    if (won.length === 0) return [...this.forfeited];
    return this.order.filter((id) => !won.includes(id) && !this.kicked.has(id));
  }

  /** by points; winners first */
  placeOf(id: string): number | null {
    if (!this.over || !this.order.includes(id) || this.isOut(id)) return null;
    const won = this.over ? this.winners() : [];
    if (won.includes(id)) return 1;
    const live = this.order.filter((p) => !this.isOut(p) && !won.includes(p));
    const mine = this.scores.get(id)!;
    return won.length + 1 + live.filter((p) => this.scores.get(p)! > mine).length;
  }

  view(): CarromView {
    const places: Record<string, number> = {};
    if (this.over) for (const id of this.order) if (!this.isOut(id)) places[id] = this.placeOf(id)!;
    const rec = <T>(f: (id: string) => T) => Object.fromEntries(this.order.map((id) => [id, f(id)]));
    return {
      mode: this.mode,
      length: this.length,
      board: this.board,
      boards: this.boards,
      sides: rec((id) => this.sideOf(id)),
      colors: this.colors ? rec((id) => this.colors!.get(id)!) : null,
      teams: this.teams ? [[...this.teams[0]], [...this.teams[1]]] : null,
      coins: this.coins.map((c) => ({ ...c })),
      pocketed: rec((id) => [...this.pocketed.get(id)!]),
      queen: { ...this.queen },
      scores: rec((id) => this.scores.get(id)!),
      results: this.results.map((r) => ({ ...r, winners: [...r.winners] })),
      turnId: this.over ? null : this.turnId,
      settleAt: this.settleAt,
      deadline: this.over ? null : this.deadline,
      last: this.last ? { ...this.last, before: this.last.before.map((c) => ({ ...c })) } : null,
      places,
      now: this.now(),
    };
  }
}
