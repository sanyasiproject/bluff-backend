import { secureRandom, type RandomInt } from '../../cards.js';
import { GameError } from '../../game.js';
import type { BetResult, GameEvent, PlayerStats, SeaEvent, TableGame } from '../../models.js';
import { gameOpt, SEA_MAX_POWERS, SEA_PLACE_MS, SEA_POWERS, SEA_SIZE, SEA_TURN_MS, seaFleetError, seaRandomFleet, seaShipCells, type Card, type GameConfig, type SeaPower, type SeaShip, type SeaShotView, type SeaView } from '../../types.js';
import { seaViewOf } from './view.js';

/** Sea Battle's per-account counters (stats.perGame.seabattle) */
export type SeaTally = { hits: number; sunk: number; shots: number };

/** a bot's pause before each shot (ms: from, plus up to) */
const BOT_PACE = [900, 800] as const;
/** a bot is ready this long after the start (ms) */
export const SEA_BOT_READY_MS = 1_500;

const emptyStats = (): PlayerStats & { tallies: SeaTally } => ({
  bluffs: 0, caught: 0, goodCalls: 0, wrongCalls: 0, pickedUp: 0, plays: 0, chances: 0,
  tallies: { hits: 0, sunk: 0, shots: 0 },
});

const ev = (e: SeaEvent): GameEvent => ({ kind: 'seabattle', ev: e });
const N = SEA_SIZE;

/** Sea Battle for 2 to 4: hidden fleets, fire at anyone still afloat, a hit fires again; powers when on */
export class SeaGame implements TableGame<Card> {
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
  readonly powers: boolean;
  phase: SeaView['phase'] = 'place';
  readonly placeEndsAt: number;
  readonly fleets = new Map<string, SeaShip[] | null>();
  readonly ready = new Set<string>();
  /** per sea: 0 not shot, 1 miss, 2 hit, 3 sunk */
  readonly shots = new Map<string, number[]>();
  readonly shipHits = new Map<string, number[]>();
  readonly held = new Map<string, SeaPower[]>();
  readonly radars: { by: string; target: string; x: number; y: number; count: number }[] = [];
  readonly outOrder: string[] = [];
  /** out players who walked away afterwards */
  readonly gone = new Set<string>();
  deadline: number | null = null;
  last: SeaShotView | null = null;
  seq = 0;
  stepSeq = 0;
  botPaceMs: number = BOT_PACE[0];

  constructor(
    readonly order: string[],
    readonly config: GameConfig,
    private readonly rand: RandomInt = secureRandom,
    botIds: string[] = [],
    readonly jitter: () => number = Math.random,
    readonly now: () => number = Date.now,
  ) {
    if (order.length < 2 || order.length > 4) throw new GameError('Sea Battle needs 2 to 4 players');
    this.bots = new Set(botIds);
    this.powers = gameOpt<string>(config, 'powers') !== 'off';
    for (const id of order) {
      this.stats.set(id, emptyStats());
      this.fleets.set(id, this.bots.has(id) ? seaRandomFleet(jitter) : null);
      this.shots.set(id, new Array(N * N).fill(0));
      this.shipHits.set(id, [0, 0, 0, 0, 0]);
      this.held.set(id, []);
    }
    this.placeEndsAt = this.now() + SEA_PLACE_MS;
  }

  hand(_id: string): Card[] {
    return [];
  }

  handValueOf(id: string): number {
    return -this.afloatOf(id).length;
  }

  isOut(id: string): boolean {
    return this.kicked.has(id) || this.forfeited.has(id);
  }

  alive(id: string): boolean {
    return this.order.includes(id) && !this.isOut(id) && !this.outOrder.includes(id);
  }

  /** still at the table: out players stay (they watch the bots finish) until they walk away */
  inPlay(id: string): boolean {
    return !this.over && this.order.includes(id) && !this.isOut(id) && !this.gone.has(id);
  }

  private tallyOf(id: string): SeaTally {
    return this.stats.get(id)!.tallies as SeaTally;
  }

  /** ship cells not yet hit */
  afloatLeft(id: string): number {
    return this.afloatOf(id).reduce((s, l) => s + l, 0) - this.shots.get(id)!.filter((v) => v === 2).length;
  }

  /** ship lengths still afloat */
  afloatOf(id: string): number[] {
    const fleet = this.fleets.get(id);
    if (!fleet) return [];
    const hits = this.shipHits.get(id)!;
    return fleet.filter((s, i) => hits[i] < s.len).map((s) => s.len);
  }

  private shipAt(id: string, x: number, y: number): number {
    const fleet = this.fleets.get(id) ?? [];
    return fleet.findIndex((s) => seaShipCells(s).some(([cx, cy]) => cx === x && cy === y));
  }

  // ─── placement ───

  place(id: string, ships?: SeaShip[]): GameEvent[] {
    if (this.phase !== 'place') throw new GameError('Placement is over');
    if (!this.alive(id)) throw new GameError("You're not playing this game");
    const fleet = ships ?? seaRandomFleet(this.jitter);
    const err = seaFleetError(fleet);
    if (err) throw new GameError(err);
    this.fleets.set(id, fleet.map((s) => ({ x: s.x, y: s.y, len: s.len, v: !!s.v })));
    this.stepSeq++;
    return [];
  }

  markReady(id: string): GameEvent[] {
    if (this.phase !== 'place') throw new GameError('Placement is over');
    if (!this.alive(id)) throw new GameError("You're not playing this game");
    if (!this.fleets.get(id)) this.fleets.set(id, seaRandomFleet(this.jitter));
    if (this.ready.has(id)) return [];
    this.ready.add(id);
    this.stepSeq++;
    const events = [ev({ type: 'ready', playerId: id })];
    if (this.order.filter((p) => this.alive(p)).every((p) => this.ready.has(p))) return [...events, ...this.startBattle()];
    return events;
  }

  /** time's up or everyone is ready: anything unplaced goes at random, then the first shooter at random */
  startBattle(): GameEvent[] {
    if (this.phase !== 'place') return [];
    for (const id of this.order) if (!this.fleets.get(id)) this.fleets.set(id, seaRandomFleet(this.jitter));
    this.phase = 'battle';
    const live = this.order.filter((p) => this.alive(p));
    this.turnId = live[this.rand(live.length)];
    this.deadline = this.now() + SEA_TURN_MS;
    this.stepSeq++;
    this.paceBot();
    return [ev({ type: 'battle' })];
  }

  // ─── shots ───

  private checkShot(id: string, target: string): void {
    if (this.over) throw new GameError('The game is over');
    if (this.phase !== 'battle') throw new GameError('Place your fleet first');
    if (this.turnId !== id) throw new GameError('Not your turn');
    if (target === id) throw new GameError("Don't fire at your own fleet");
    if (!this.alive(target)) throw new GameError('That fleet is gone');
  }

  private usePower(id: string, p: SeaPower): void {
    const held = this.held.get(id)!;
    if (!this.powers || !held.includes(p)) throw new GameError(`You have no ${p}`);
    held.splice(held.indexOf(p), 1);
  }

  /** one cell hit or missed; returns the sunk ship's length (0 when none) */
  private strike(id: string, target: string, x: number, y: number): { hit: boolean; sunk: number; earned: SeaPower | null } {
    const grid = this.shots.get(target)!;
    const t = this.tallyOf(id);
    t.shots++;
    const i = this.shipAt(target, x, y);
    if (i < 0) {
      grid[y * N + x] = 1;
      return { hit: false, sunk: 0, earned: null };
    }
    t.hits++;
    grid[y * N + x] = 2;
    const hits = this.shipHits.get(target)!;
    hits[i]++;
    const ship = this.fleets.get(target)![i];
    if (hits[i] < ship.len) return { hit: true, sunk: 0, earned: null };
    t.sunk++;
    for (const [cx, cy] of seaShipCells(ship)) grid[cy * N + cx] = 3;
    let earned: SeaPower | null = null;
    const held = this.held.get(id)!;
    if (this.powers && held.length < SEA_MAX_POWERS) {
      earned = SEA_POWERS[Math.floor(this.jitter() * SEA_POWERS.length)];
      held.push(earned);
    }
    return { hit: true, sunk: ship.len, earned };
  }

  private cellOk(target: string, x: number, y: number): void {
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= N || y >= N) throw new GameError('Pick a cell on the sea');
    if (this.shots.get(target)![y * N + x] !== 0) throw new GameError('Already fired there');
  }

  fire(id: string, target: string, x: number, y: number, auto = false): GameEvent[] {
    this.checkShot(id, target);
    this.cellOk(target, x, y);
    const r = this.strike(id, target, x, y);
    return this.after(id, target, 'fire', [{ x, y, ...r }], auto);
  }

  salvo(id: string, target: string, cells: [number, number][]): GameEvent[] {
    this.checkShot(id, target);
    const open = this.shots.get(target)!.filter((v) => v === 0).length;
    if (cells.length !== Math.min(3, open)) throw new GameError('A salvo fires at 3 different cells');
    for (const [x, y] of cells) this.cellOk(target, x, y);
    if (new Set(cells.map(([x, y]) => y * N + x)).size !== cells.length) throw new GameError('A salvo fires at 3 different cells');
    this.usePower(id, 'salvo');
    const res = cells.map(([x, y]) => ({ x, y, ...this.strike(id, target, x, y) }));
    return this.after(id, target, 'salvo', res, false);
  }

  torpedo(id: string, target: string, row: number): GameEvent[] {
    this.checkShot(id, target);
    if (!Number.isInteger(row) || row < 0 || row >= N) throw new GameError('Pick a row');
    this.usePower(id, 'torpedo');
    const grid = this.shots.get(target)!;
    // it runs right until the first ship cell not hit yet
    for (let x = 0; x < N; x++) {
      if (grid[row * N + x] >= 2 || this.shipAt(target, x, row) < 0) continue;
      return this.after(id, target, 'torpedo', [{ x, y: row, ...this.strike(id, target, x, row) }], false, row);
    }
    this.tallyOf(id).shots++;
    return this.after(id, target, 'torpedo', [], false, row);
  }

  /** scans the 3 × 3 round (x, y): how many unhit ship cells; the turn goes on */
  radar(id: string, target: string, x: number, y: number): GameEvent[] {
    this.checkShot(id, target);
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= N || y >= N) throw new GameError('Pick a cell on the sea');
    this.usePower(id, 'radar');
    const x0 = Math.max(0, Math.min(N - 3, x - 1));
    const y0 = Math.max(0, Math.min(N - 3, y - 1));
    const grid = this.shots.get(target)!;
    let count = 0;
    for (let cy = y0; cy < y0 + 3; cy++) for (let cx = x0; cx < x0 + 3; cx++) if (grid[cy * N + cx] < 2 && this.shipAt(target, cx, cy) >= 0) count++;
    this.radars.push({ by: id, target, x: x0, y: y0, count });
    this.seq++;
    this.stepSeq++;
    this.deadline = this.now() + SEA_TURN_MS;
    this.paceBot();
    this.last = { seq: this.seq, by: id, target, kind: 'radar', cells: [], area: [x0, y0], count, earned: null, again: true, out: false, auto: false };
    return [ev({ type: 'shot', by: id, target, kind: 'radar', hits: 0, sunk: [], earned: null, again: true, auto: false })];
  }

  private after(id: string, target: string, kind: SeaShotView['kind'], res: { x: number; y: number; hit: boolean; sunk: number; earned: SeaPower | null }[], auto: boolean, row?: number): GameEvent[] {
    this.seq++;
    this.stepSeq++;
    const again = res.some((r) => r.hit);
    const earned = res.map((r) => r.earned).find((e) => e) ?? null;
    const out = this.afloatOf(target).length === 0;
    this.last = { seq: this.seq, by: id, target, kind, cells: res.map((r) => ({ x: r.x, y: r.y, hit: r.hit, sunk: r.sunk > 0 })), ...(row !== undefined ? { row } : {}), earned, again, out, auto };
    const events: GameEvent[] = [ev({ type: 'shot', by: id, target, kind, hits: res.filter((r) => r.hit).length, sunk: res.filter((r) => r.sunk).map((r) => r.sunk), earned, again, auto })];
    if (out) {
      this.outOrder.push(target);
      events.push(ev({ type: 'out', playerId: target, by: id, place: this.placeOf(target) ?? 0 }));
      if (this.order.filter((p) => this.alive(p)).length <= 1) return [...events, ...this.end()];
    }
    if (!again) this.turnId = this.nextAlive(id);
    this.deadline = this.now() + SEA_TURN_MS;
    this.paceBot();
    return events;
  }

  /** time ran out: a random cell of a random fleet still afloat */
  timeout(): GameEvent[] {
    const id = this.turnId;
    if (this.over || !id || this.phase !== 'battle') return [];
    const targets = this.order.filter((p) => p !== id && this.alive(p));
    const target = targets[Math.floor(this.jitter() * targets.length)];
    const open = this.shots.get(target)!.flatMap((v, i) => (v === 0 ? [i] : []));
    const c = open[Math.floor(this.jitter() * open.length)];
    return this.fire(id, target, c % N, Math.floor(c / N), true);
  }

  private nextAlive(id: string): string | null {
    const n = this.order.length;
    const at = this.order.indexOf(id);
    for (let s = 1; s <= n; s++) {
      const o = this.order[(at + s) % n];
      if (this.alive(o)) return o;
    }
    return null;
  }

  private paceBot(): void {
    this.botPaceMs = BOT_PACE[0] + this.jitter() * BOT_PACE[1];
  }

  private end(): GameEvent[] {
    this.over = true;
    this.phase = 'over';
    this.turnId = null;
    this.deadline = null;
    this.stepSeq++;
    this.places = [...this.order.filter((p) => this.alive(p)), ...[...this.outOrder].reverse()].filter((p) => !this.isOut(p));
    return [{ kind: 'gameOver', loserId: null }];
  }

  leave(id: string): GameEvent[] {
    if (!this.over && this.order.includes(id) && !this.isOut(id) && !this.alive(id)) {
      // already out: their place stands, they just stop watching
      this.gone.add(id);
      this.stepSeq++;
      return [];
    }
    if (this.over || !this.alive(id)) return [];
    this.forfeited.add(id);
    return this.drop(id, false);
  }

  removePlayer(id: string): GameEvent[] {
    if (this.over || !this.order.includes(id) || this.kicked.has(id)) return [];
    const was = this.alive(id);
    this.kicked.add(id);
    return was ? this.drop(id, true) : [];
  }

  close(): GameEvent[] {
    if (this.over) return [];
    this.closed = true;
    return this.end();
  }

  private drop(id: string, kicked: boolean): GameEvent[] {
    this.stepSeq++;
    const still = this.order.filter((p) => this.alive(p));
    if (still.length <= 1) {
      if (kicked && this.outOrder.length === 0) this.aborted = true;
      return this.end();
    }
    if (this.phase === 'place' && still.every((p) => this.ready.has(p))) return this.startBattle();
    if (this.turnId === id) {
      this.turnId = this.nextAlive(id);
      this.deadline = this.now() + SEA_TURN_MS;
    }
    return [];
  }

  /** the last fleet afloat */
  winners(): string[] {
    if (this.aborted || !this.over) return [];
    const alive = this.order.filter((p) => this.alive(p));
    return alive.length === 1 ? alive : [];
  }

  losers(): string[] {
    if (this.aborted) return [];
    const won = this.winners();
    if (won.length === 0) return [...this.forfeited];
    return this.order.filter((id) => !won.includes(id) && !this.kicked.has(id));
  }

  placeOf(id: string): number | null {
    if (!this.order.includes(id) || this.isOut(id)) return null;
    const alive = this.order.filter((p) => this.alive(p));
    // no place while still playing; a closed game ranks those left by what they had
    if (alive.includes(id)) return this.over ? 1 + alive.filter((p) => this.afloatLeft(p) > this.afloatLeft(id)).length : null;
    const outs = this.outOrder.filter((p) => !this.isOut(p));
    return alive.length + (outs.length - outs.indexOf(id));
  }

  /** the table as one member sees it: only their own ships (watchers: none), others' only once sunk */
  view(meId: string, seated: boolean): SeaView {
    return seaViewOf(this, meId, seated);
  }
}
