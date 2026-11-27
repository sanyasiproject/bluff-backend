import { secureRandom, type RandomInt } from '../../cards.js';
import { GameError } from '../../game.js';
import type { BetResult, GameEvent, PlayerStats, SpikesEvent, TableGame } from '../../models.js';
import { gameOpt, SPIKES_LIVES, SPIKES_RADIUS, SPIKES_SPEED, type BotLevel, type Card, type GameConfig, type SpikeDir, type SpikesView, type SpikeWarning } from '../../types.js';
import { botSpeedOf, botThink, botThinkMs, type SpikesBotLevel } from './brain.js';

/** Spike Attack's per-account counters (stats.perGame.spikes) */
export type SpikesTally = { dodges: number; hits: number };
export type Point = [number, number];

/** the 3-2-1 before the first warning (ms) */
export const SPIKES_COUNTDOWN_MS = 3_000;
/** how far a move may run ahead of SPIKES_SPEED (arena units), for network bunching; it never adds up past this */
export const SPIKES_SLACK = 0.35;
/** a band is hit when a body overlaps it by this share of its radius (a little forgiving) */
export const SPIKES_HIT_SHARE = 0.85;
/** bots move this often while running (ms) */
export const SPIKES_BOT_TICK_MS = 100;
/** no second hit this soon after one (ms) */
export const SPIKES_SAFE_MS = 1_000;
/** the game ends after this long; most lives left wins (ms) */
export const SPIKES_MAX_MS = 180_000;
/** recent strikes kept in the view for the animation */
const STRIKES_KEPT = 8;

/** warning time and the gap between warnings: from the start, shrinking to the end values over `ramp` ms of play */
export const SPIKES_PACE = {
  normal: { warn: [3_000, 1_000], gap: [1_700, 550], ramp: 75_000 },
  fast: { warn: [2_000, 1_000], gap: [1_250, 450], ramp: 50_000 },
} as const;

const emptyStats = (): PlayerStats & { tallies: SpikesTally } => ({
  bluffs: 0,
  caught: 0,
  goodCalls: 0,
  wrongCalls: 0,
  pickedUp: 0,
  plays: 0,
  chances: 0,
  tallies: { dodges: 0, hits: 0 },
});

const ev = (e: SpikesEvent): GameEvent => ({ kind: 'spikes', ev: e });

/** a warning with who stood on its line when it showed, and when each bot notices it */
export interface LiveWarning extends SpikeWarning {
  onLine: Set<string>;
  notice: Map<string, number>;
}

/** a body centred at v overlaps lane `line` (the lane spans line..line+1) */
export const inBand = (v: number, line: number): boolean => Math.abs(v - (line + 0.5)) < 0.5 + SPIKES_RADIUS * SPIKES_HIT_SHARE;

/** a spike from `dir` runs along a row (left/right: tests y) or a column (top/bottom: tests x) */
export const covers = (w: Pick<SpikeWarning, 'dir' | 'line'>, [x, y]: Point): boolean => (w.dir === 'left' || w.dir === 'right' ? inBand(y, w.line) : inBand(x, w.line));

/** a bot's run: where it heads, when it next thinks, when it last moved */
export interface BotRun {
  target: Point | null;
  thinkAt: number;
  movedAt: number;
}

/** Spike Attack: everyone moves freely at once, spikes shoot across warned rows and columns; last one standing wins */
export class SpikesGame implements TableGame<Card> {
  readonly hands = new Map<string, Card[]>();
  readonly stats = new Map<string, PlayerStats>();
  readonly kicked = new Set<string>();
  readonly forfeited = new Set<string>();
  readonly teams = null;
  readonly bets: BetResult[] = [];
  readonly endedEarly = false;
  pile: Card[] = [];
  places: string[] = [];
  /** nobody has a turn: everyone moves at once */
  turnId: string | null = null;
  over = false;
  aborted = false;
  closed = false;
  phase: SpikesView['phase'] = 'countdown';
  readonly size: number;
  readonly speed: 'normal' | 'fast';
  readonly startsAt: number;
  readonly bots: Set<string>;
  readonly level: SpikesBotLevel;
  readonly pos = new Map<string, Point>();
  readonly lives = new Map<string, number>();
  readonly safeUntil = new Map<string, number>();
  /** finishing place of each player out of the game (1 = won) */
  readonly placeMap = new Map<string, number>();
  warnings: LiveWarning[] = [];
  strikes: SpikesView['strikes'] = [];
  /** goes up with every timed step (not with people's moves): drivers key their timers on it */
  stepSeq = 0;
  /** when the next warning shows */
  nextWarnAt: number;
  /** each bot's run */
  readonly botRun = new Map<string, BotRun>();
  /** each person's last accepted move time and unused slack */
  private readonly lastMove = new Map<string, { at: number; slack: number }>();
  private warnSeq = 0;
  private timeUp = false;

  constructor(
    readonly order: string[],
    readonly config: GameConfig,
    private readonly rand: RandomInt = secureRandom,
    botIds: string[] = [],
    readonly now: () => number = Date.now,
    private readonly jitter: () => number = Math.random,
  ) {
    if (order.length < 2 || order.length > 4) throw new GameError('Spike Attack needs 2 to 4 players');
    this.size = gameOpt<number>(config, 'size');
    this.speed = gameOpt<string>(config, 'speed') === 'fast' ? 'fast' : 'normal';
    this.startsAt = this.now() + SPIKES_COUNTDOWN_MS;
    this.nextWarnAt = this.startsAt + 600;
    this.bots = new Set(botIds);
    this.level = (config.botLevel ?? 'hard') as BotLevel;
    const lo = 0.5;
    const hi = this.size - 0.5;
    // the four corner boxes' centres; two players sit opposite
    const corners: Point[] = [[lo, lo], [hi, hi], [hi, lo], [lo, hi]];
    order.forEach((id, i) => {
      this.stats.set(id, emptyStats());
      this.pos.set(id, [...corners[i]]);
      this.lives.set(id, SPIKES_LIVES);
      this.safeUntil.set(id, 0);
      if (this.bots.has(id)) this.botRun.set(id, { target: null, thinkAt: this.startsAt + 300 + this.jitter() * 500, movedAt: this.startsAt });
      else this.lastMove.set(id, { at: this.startsAt, slack: SPIKES_SLACK });
    });
  }

  hand(_id: string): Card[] {
    return [];
  }

  handValueOf(_id: string): number {
    return 0;
  }

  isOut(id: string): boolean {
    return this.kicked.has(id) || this.forfeited.has(id);
  }

  /** still on the board: not out of lives, not gone */
  alive(id: string): boolean {
    return this.order.includes(id) && !this.isOut(id) && !this.placeMap.has(id);
  }

  inPlay(id: string): boolean {
    return this.alive(id) && !this.over;
  }

  private tallyOf(id: string): SpikesTally {
    return this.stats.get(id)!.tallies as SpikesTally;
  }

  private aliveIds(): string[] {
    return this.order.filter((id) => this.alive(id));
  }

  /** ms of play so far by the server clock */
  private played(at: number): number {
    return Math.max(0, at - this.startsAt);
  }

  /** keeps a body inside the arena */
  clamp(v: number): number {
    return Math.min(this.size - SPIKES_RADIUS, Math.max(SPIKES_RADIUS, v));
  }

  /** the pace at this point of the game, from its start values towards the end values */
  pace(at: number): { warn: number; gap: number; most: number } {
    const p = SPIKES_PACE[this.speed];
    const k = Math.min(1, this.played(at) / p.ramp);
    // more warnings overlap as the game goes on; always fewer than the lines, so a safe box is left
    const most = Math.min(this.size - 1, 1 + Math.floor(this.played(at) / 15_000));
    return { warn: Math.round(p.warn[0] - (p.warn[0] - p.warn[1]) * k), gap: Math.round(p.gap[0] - (p.gap[0] - p.gap[1]) * k), most };
  }

  /** the countdown is over */
  go(): GameEvent[] {
    if (this.over || this.phase !== 'countdown') return [];
    this.phase = 'play';
    this.stepSeq++;
    return [ev({ type: 'go' })];
  }

  /** a person's position: never refused for speed, cut back along the line to what SPIKES_SPEED allows, kept inside the arena */
  moveTo(id: string, x: number, y: number): GameEvent[] {
    if (this.over) throw new GameError('The game is over');
    if (!this.order.includes(id) || this.isOut(id)) throw new GameError("You're not playing this game");
    if (!this.alive(id)) throw new GameError("You're out");
    const now = this.now();
    if (now < this.startsAt) throw new GameError('Wait for the countdown');
    const from = this.pos.get(id)!;
    const last = this.lastMove.get(id) ?? { at: now, slack: 0 };
    const allowed = (SPIKES_SPEED * Math.max(0, now - last.at)) / 1000 + last.slack;
    const to = this.reach(from, [x, y], allowed);
    // unused allowance carries over, but never more than SPIKES_SLACK
    const used = Math.hypot(to[0] - from[0], to[1] - from[1]);
    this.lastMove.set(id, { at: now, slack: Math.min(SPIKES_SLACK, Math.max(0, allowed - used)) });
    this.pos.set(id, to);
    return [ev({ type: 'step', playerId: id, to: [...to] })];
  }

  /** from `from` towards `to`, at most `most` units, inside the arena */
  reach(from: Point, to: Point, most: number): Point {
    const dx = to[0] - from[0];
    const dy = to[1] - from[1];
    const d = Math.hypot(dx, dy);
    const k = d > most && d > 0 ? most / d : 1;
    return [this.clamp(from[0] + dx * k), this.clamp(from[1] + dy * k)];
  }

  /** a new warning on a line nobody is warned about yet */
  warn(): GameEvent[] {
    if (this.over || this.phase !== 'play') return [];
    const now = this.now();
    const pace = this.pace(now);
    this.stepSeq++;
    this.nextWarnAt = now + pace.gap + this.jitter() * 400;
    if (this.warnings.length >= pace.most) return [];
    const dirs: SpikeDir[] = ['left', 'right', 'top', 'bottom'];
    const free = dirs.flatMap((dir) => Array.from({ length: this.size }, (_, line) => ({ dir, line }))).filter((w) => !this.warnings.some((x) => (x.dir === 'left' || x.dir === 'right') === (w.dir === 'left' || w.dir === 'right') && x.line === w.line));
    if (free.length === 0) return [];
    const pick = free[this.rand(free.length)];
    const w: LiveWarning = { id: ++this.warnSeq, ...pick, warnAt: now, strikeAt: now + pace.warn, onLine: new Set(), notice: new Map() };
    for (const id of this.aliveIds()) {
      if (covers(w, this.pos.get(id)!)) w.onLine.add(id);
      if (this.bots.has(id)) w.notice.set(id, now + noticeDelay(this.level, this.jitter));
    }
    this.warnings.push(w);
    return [ev({ type: 'warn', id: w.id, dir: w.dir, line: w.line })];
  }

  /** the earliest warning's spike shoots across: everyone whose body overlaps its band and isn't safe loses a life */
  strike(): GameEvent[] {
    if (this.over || this.warnings.length === 0) return [];
    const w = this.warnings.reduce((a, b) => (b.strikeAt < a.strikeAt ? b : a));
    this.warnings = this.warnings.filter((x) => x !== w);
    const now = this.now();
    this.stepSeq++;
    const hit: string[] = [];
    for (const id of this.aliveIds()) {
      if (!covers(w, this.pos.get(id)!)) {
        if (w.onLine.has(id)) this.tallyOf(id).dodges++;
        continue;
      }
      if ((this.safeUntil.get(id) ?? 0) > now) continue;
      hit.push(id);
      this.lives.set(id, (this.lives.get(id) ?? 0) - 1);
      this.safeUntil.set(id, now + SPIKES_SAFE_MS);
      this.tallyOf(id).hits++;
    }
    this.strikes = [...this.strikes, { id: w.id, dir: w.dir, line: w.line, at: now, hit }].slice(-STRIKES_KEPT);
    const events = [ev({ type: 'strike', id: w.id, dir: w.dir, line: w.line, hit })];
    const dead = hit.filter((id) => (this.lives.get(id) ?? 0) <= 0);
    if (dead.length > 0) events.push(...this.knockOut(dead));
    return events;
  }

  /** players out on the same strike share a place; the last one standing wins */
  private knockOut(dead: string[]): GameEvent[] {
    const left = this.aliveIds().filter((id) => !dead.includes(id));
    // all of the last players out together share first
    const place = left.length + 1;
    const events: GameEvent[] = [];
    for (const id of dead) {
      this.placeMap.set(id, place);
      events.push(ev({ type: 'out', playerId: id, place }));
    }
    if (left.length === 1) {
      this.placeMap.set(left[0], 1);
      events.push({ kind: 'finish', playerId: left[0], place: 1 });
    }
    if (left.length <= 1) events.push(...this.end());
    return events;
  }

  /** bots run towards their targets, and those due to look around pick a new one */
  botTurns(): GameEvent[] {
    if (this.over) return [];
    const now = this.now();
    this.stepSeq++;
    const events: GameEvent[] = [];
    for (const [id, run] of this.botRun) {
      if (!this.alive(id)) {
        this.botRun.delete(id);
        continue;
      }
      if (run.target) {
        const from = this.pos.get(id)!;
        const to = this.reach(from, run.target, (botSpeedOf(this.level) * Math.max(0, now - run.movedAt)) / 1000);
        if (to[0] !== from[0] || to[1] !== from[1]) {
          this.pos.set(id, to);
          events.push(ev({ type: 'step', playerId: id, to: [...to] }));
        }
        if (Math.hypot(run.target[0] - to[0], run.target[1] - to[1]) < 0.01) run.target = null;
      }
      run.movedAt = now;
      if (run.thinkAt <= now) {
        run.target = botThink(this, id, now, this.jitter) ?? run.target;
        run.thinkAt = now + botThinkMs(this.level, this.jitter);
      }
    }
    return events;
  }

  /** when the bots next need a step: a tick while any runs, else the next look around */
  private nextBotAt(): number {
    let at = Infinity;
    for (const run of this.botRun.values()) at = Math.min(at, run.thinkAt, run.target ? run.movedAt + SPIKES_BOT_TICK_MS : Infinity);
    return at;
  }

  /** the game ran its full time: most lives left wins, ties share */
  endOnTime(): GameEvent[] {
    if (this.over) return [];
    this.timeUp = true;
    this.stepSeq++;
    this.rankLeft();
    return [ev({ type: 'timeUp' }), ...this.end()];
  }

  /** the next timed step: the countdown, a strike, a warning, the bots, or the end of time */
  nextStep(): { at: number; run: () => GameEvent[] } | null {
    if (this.over) return null;
    if (this.phase === 'countdown') return { at: this.startsAt, run: () => this.go() };
    const steps: { at: number; run: () => GameEvent[] }[] = [{ at: this.startsAt + SPIKES_MAX_MS, run: () => this.endOnTime() }];
    // a strike goes before anything planned for the same moment
    if (this.warnings.length > 0) steps.push({ at: Math.min(...this.warnings.map((w) => w.strikeAt)), run: () => this.strike() });
    steps.push({ at: this.nextWarnAt, run: () => this.warn() });
    const bots = this.nextBotAt();
    if (bots < Infinity) steps.push({ at: bots, run: () => this.botTurns() });
    return steps.reduce((a, b) => (b.at < a.at ? b : a));
  }

  private end(): GameEvent[] {
    this.over = true;
    this.phase = 'over';
    this.warnings = [];
    this.stepSeq++;
    return [{ kind: 'gameOver', loserId: null }];
  }

  /** a player walks out: they lose and still pay */
  leave(id: string): GameEvent[] {
    if (this.over || !this.order.includes(id) || this.isOut(id)) return [];
    this.forfeited.add(id);
    return this.drop(id, true);
  }

  /** the host removed a player: they pay and win nothing */
  removePlayer(id: string): GameEvent[] {
    if (this.over || !this.order.includes(id) || this.kicked.has(id)) return [];
    this.kicked.add(id);
    return this.drop(id, false);
  }

  /** no person is left playing (all out of lives or gone): bots still standing are ranked by lives left */
  close(): GameEvent[] {
    if (this.over) return [];
    this.closed = true;
    this.rankLeft();
    return this.end();
  }

  /** everyone still standing gets a place by lives left, ties share */
  private rankLeft(): void {
    const left = this.aliveIds();
    for (const id of left) this.placeMap.set(id, 1 + left.filter((o) => (this.lives.get(o) ?? 0) > (this.lives.get(id) ?? 0)).length);
  }

  private drop(id: string, walked: boolean): GameEvent[] {
    this.stepSeq++;
    this.placeMap.delete(id);
    this.botRun.delete(id);
    const left = this.aliveIds();
    if (left.length > 1) return [];
    // a walk-out hands the game to whoever is left; a kick leaves no fair winner
    if (walked && left.length === 1) {
      this.placeMap.set(left[0], 1);
      return [{ kind: 'finish', playerId: left[0], place: 1 }, ...this.end()];
    }
    if (left.length === 0 && [...this.placeMap.values()].includes(1)) return this.end();
    this.aborted = true;
    return this.end();
  }

  /** first place (shared when the last players went out together, or on time); nobody if stopped */
  winners(): string[] {
    if (this.aborted || !this.over) return [];
    return this.order.filter((id) => !this.isOut(id) && this.placeMap.get(id) === 1);
  }

  /** everyone who didn't win (walk-outs included, removed players not) */
  losers(): string[] {
    if (this.aborted) return [];
    const won = this.winners();
    if (won.length === 0) return [...this.forfeited];
    return this.order.filter((id) => !won.includes(id) && !this.kicked.has(id));
  }

  placeOf(id: string): number | null {
    if (!this.over || this.aborted || this.isOut(id)) return null;
    return this.placeMap.get(id) ?? null;
  }

  get endedOnTime(): boolean {
    return this.timeUp;
  }

  /** the same for everyone; `now` lines up the apps' clocks with the server's */
  view(): SpikesView {
    const rec = <T>(m: Map<string, T>) => Object.fromEntries(this.order.map((id) => [id, m.get(id)!]));
    // 3 decimals is plenty on screen and keeps the frequent views small
    const r3 = (v: number) => Math.round(v * 1000) / 1000;
    return {
      size: this.size,
      phase: this.phase,
      startsAt: this.startsAt,
      pos: Object.fromEntries(this.order.map((id) => [id, this.pos.get(id)!.map(r3) as [number, number]])),
      lives: rec(this.lives),
      safeUntil: rec(this.safeUntil),
      warnings: this.warnings.map(({ id, dir, line, warnAt, strikeAt }) => ({ id, dir, line, warnAt, strikeAt })),
      strikes: this.strikes.map((s) => ({ ...s, hit: [...s.hit] })),
      places: Object.fromEntries([...this.placeMap].filter(([id]) => !this.isOut(id))),
      now: this.now(),
    };
  }
}

/** how long after a warning shows a bot notices it (ms); Normal is sometimes late */
function noticeDelay(level: SpikesBotLevel, jitter: () => number): number {
  if (level === 'expert') return 200 + jitter() * 300 + (jitter() < 0.08 ? 800 : 0);
  if (level === 'hard') return 320 + jitter() * 480 + (jitter() < 0.16 ? 900 : 0);
  return 550 + jitter() * 750 + (jitter() < 0.25 ? 1_100 : 0);
}
