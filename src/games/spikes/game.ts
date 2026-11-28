import { secureRandom, type RandomInt } from '../../cards.js';
import { GameError } from '../../game.js';
import type { BetResult, GameEvent, PlayerStats, SpikesEvent, TableGame } from '../../models.js';
import { gameOpt, SPIKES_LIVES, SPIKES_RADIUS, SPIKES_SPEED, type BotLevel, type Card, type GameConfig, type SpikeDir, type SpikesView, type SpikeWarning } from '../../types.js';
import { hitBy, makeBoxes, reachesOf, safePairs, slide, SPIKE_DIRS, type Cell, type Point, type Reaches } from './arena.js';
import { botSpeedOf, botThink, botThinkMs, type SpikesBotLevel } from './brain.js';

export { inBand, SPIKES_HIT_SHARE, type Point } from './arena.js';

/** Spike Attack's per-account counters (stats.perGame.spikes) */
export type SpikesTally = { dodges: number; hits: number };

/** the 3-2-1 before the first warning (ms) */
export const SPIKES_COUNTDOWN_MS = 3_000;
/** how far a move may run ahead of SPIKES_SPEED (arena units), for network bunching; it never adds up past this */
export const SPIKES_SLACK = 0.35;
/** bots move this often while running (ms) */
export const SPIKES_BOT_TICK_MS = 100;
/** no second hit this soon after one (ms) */
export const SPIKES_SAFE_MS = 1_000;
/** the game ends after this long; most lives left wins (ms) */
export const SPIKES_MAX_MS = 180_000;
/** recent strikes kept in the view for the animation */
const STRIKES_KEPT = 8;

/** the first wall is warned this long into play (ms) */
export const SPIKES_FIRST_WARN_MS = 800;

/**
 * warning time, and the gap from one strike to the next warning (a range), going from their start values to their end values
 * over `ramp` ms of play; from `twoFrom` ms on, `two` is the chance two sides fire together
 */
export const SPIKES_PACE = {
  normal: { warn: [3_000, 1_500], gap: [[1_500, 3_000], [700, 1_500]], ramp: 90_000, twoFrom: 45_000, two: 0.35 },
  fast: { warn: [2_000, 1_300], gap: [[1_200, 2_400], [600, 1_200]], ramp: 60_000, twoFrom: 30_000, two: 0.4 },
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

/** a warned wall with who stood in its reach when it showed, and when each bot notices it */
export interface LiveWarning extends SpikeWarning {
  inDanger: Set<string>;
  notice: Map<string, number>;
}

/** a bot's run: the cell centres it heads through, the walls it planned for, when it next thinks, when it last moved */
export interface BotRun {
  path: Point[];
  plan: string;
  thinkAt: number;
  movedAt: number;
}

/** Spike Attack: everyone moves freely round fixed boxes, whole-side spike walls stop at the boxes; last one standing wins */
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
  /** solid box squares [col, row], fixed for the game */
  readonly boxes: Cell[];
  /** each side's reach per row/column (spikeReach) */
  readonly reaches: Reaches;
  /** sides that may fire together: a free square is safe from both */
  readonly pairs: [SpikeDir, SpikeDir][];
  readonly pos = new Map<string, Point>();
  readonly lives = new Map<string, number>();
  readonly safeUntil = new Map<string, number>();
  /** finishing place of each player out of the game (1 = won) */
  readonly placeMap = new Map<string, number>();
  warnings: LiveWarning[] = [];
  strikes: SpikesView['strikes'] = [];
  /** goes up with every timed step (not with people's moves): drivers key their timers on it */
  stepSeq = 0;
  /** when the next warning shows (Infinity while a wall is warned) */
  nextWarnAt: number;
  /** the sides warned last, not picked again straight away */
  private lastDirs: SpikeDir[] = [];
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
    this.nextWarnAt = this.startsAt + SPIKES_FIRST_WARN_MS;
    this.bots = new Set(botIds);
    this.level = (config.botLevel ?? 'hard') as BotLevel;
    this.boxes = makeBoxes(this.size, rand);
    this.reaches = reachesOf(this.size, this.boxes);
    this.pairs = safePairs(this.size, this.boxes);
    const lo = 0.5;
    const hi = this.size - 0.5;
    // the four corner boxes' centres; two players sit opposite
    const corners: Point[] = [[lo, lo], [hi, hi], [hi, lo], [lo, hi]];
    order.forEach((id, i) => {
      this.stats.set(id, emptyStats());
      this.pos.set(id, [...corners[i]]);
      this.lives.set(id, SPIKES_LIVES);
      this.safeUntil.set(id, 0);
      if (this.bots.has(id)) this.botRun.set(id, { path: [], plan: '', thinkAt: this.startsAt + 300 + this.jitter() * 500, movedAt: this.startsAt });
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

  /** a wall from `dir` would hit a body at p */
  hits(dir: SpikeDir, p: Point): boolean {
    return hitBy(this.size, this.reaches[dir], dir, p);
  }

  /** walks a body from `from` towards `to`, sliding along boxes and kept inside the arena */
  slide(from: Point, to: Point): Point {
    return slide(this.size, this.boxes, from, to);
  }

  /** the pace at this point of the game: warning ms, the gap range to the next warning, the chance of two sides at once */
  pace(at: number): { warn: number; gap: [number, number]; two: number } {
    const p = SPIKES_PACE[this.speed];
    const played = this.played(at);
    const k = Math.min(1, played / p.ramp);
    const lerp = (a: number, b: number) => Math.round(a - (a - b) * k);
    return {
      warn: lerp(p.warn[0], p.warn[1]),
      gap: [lerp(p.gap[0][0], p.gap[1][0]), lerp(p.gap[0][1], p.gap[1][1])],
      two: played >= p.twoFrom && this.pairs.length > 0 ? p.two : 0,
    };
  }

  /** the countdown is over */
  go(): GameEvent[] {
    if (this.over || this.phase !== 'countdown') return [];
    this.phase = 'play';
    this.stepSeq++;
    return [ev({ type: 'go' })];
  }

  /** a person's position: never refused for speed, cut back along the line to what SPIKES_SPEED allows, then walked round boxes */
  moveTo(id: string, x: number, y: number): GameEvent[] {
    if (this.over) throw new GameError('The game is over');
    if (!this.order.includes(id) || this.isOut(id)) throw new GameError("You're not playing this game");
    if (!this.alive(id)) throw new GameError("You're out");
    const now = this.now();
    if (now < this.startsAt) throw new GameError('Wait for the countdown');
    const from = this.pos.get(id)!;
    const last = this.lastMove.get(id) ?? { at: now, slack: 0 };
    const allowed = (SPIKES_SPEED * Math.max(0, now - last.at)) / 1000 + last.slack;
    const cut = this.cut(from, [x, y], allowed);
    // unused allowance carries over, but never more than SPIKES_SLACK; a move blocked by a box still uses its length
    const used = Math.hypot(cut[0] - from[0], cut[1] - from[1]);
    this.lastMove.set(id, { at: now, slack: Math.min(SPIKES_SLACK, Math.max(0, allowed - used)) });
    const to = this.slide(from, cut);
    this.pos.set(id, to);
    return [ev({ type: 'step', playerId: id, to: [...to] })];
  }

  /** from `from` towards `to`, at most `most` units (boxes not looked at) */
  cut(from: Point, to: Point, most: number): Point {
    const dx = to[0] - from[0];
    const dy = to[1] - from[1];
    const d = Math.hypot(dx, dy);
    const k = d > most && d > 0 ? most / d : 1;
    return [from[0] + dx * k, from[1] + dy * k];
  }

  /** a new wall: one side (later sometimes two that leave a square safe from both), not the side(s) just warned */
  warn(): GameEvent[] {
    if (this.over || this.phase !== 'play' || this.warnings.length > 0) return [];
    const now = this.now();
    const pace = this.pace(now);
    this.stepSeq++;
    this.nextWarnAt = Infinity;
    let dirs: SpikeDir[];
    const pairs = this.pairs.filter((p) => !(p[0] === this.lastDirs[0] && p[1] === this.lastDirs[1]));
    if (pace.two > 0 && pairs.length > 0 && this.jitter() < pace.two) dirs = [...pairs[this.rand(pairs.length)]];
    else {
      const sides = SPIKE_DIRS.filter((d) => !(this.lastDirs.length === 1 && this.lastDirs[0] === d));
      dirs = [sides[this.rand(sides.length)]];
    }
    this.lastDirs = dirs;
    const events: GameEvent[] = [];
    for (const dir of dirs) {
      const w: LiveWarning = { id: ++this.warnSeq, dir, warnAt: now, strikeAt: now + pace.warn, inDanger: new Set(), notice: new Map() };
      for (const id of this.aliveIds()) {
        if (this.hits(dir, this.pos.get(id)!)) w.inDanger.add(id);
        if (this.bots.has(id)) w.notice.set(id, now + noticeDelay(this.level, this.jitter));
      }
      this.warnings.push(w);
      events.push(ev({ type: 'warn', id: w.id, dir }));
    }
    return events;
  }

  /** the earliest wall(s) strike: everyone a wall reaches who isn't safe loses a life (one at most, thanks to the safe time) */
  strike(): GameEvent[] {
    if (this.over || this.warnings.length === 0) return [];
    const at = Math.min(...this.warnings.map((w) => w.strikeAt));
    const due = this.warnings.filter((w) => w.strikeAt === at).sort((a, b) => a.id - b.id);
    this.warnings = this.warnings.filter((w) => !due.includes(w));
    const now = this.now();
    this.stepSeq++;
    const events: GameEvent[] = [];
    const allHit: string[] = [];
    for (const w of due) {
      const hit: string[] = [];
      for (const id of this.aliveIds()) {
        if (!this.hits(w.dir, this.pos.get(id)!)) {
          if (w.inDanger.has(id)) this.tallyOf(id).dodges++;
          continue;
        }
        if ((this.safeUntil.get(id) ?? 0) > now) continue;
        hit.push(id);
        allHit.push(id);
        this.lives.set(id, (this.lives.get(id) ?? 0) - 1);
        this.safeUntil.set(id, now + SPIKES_SAFE_MS);
        this.tallyOf(id).hits++;
      }
      this.strikes = [...this.strikes, { id: w.id, dir: w.dir, at: now, hit }].slice(-STRIKES_KEPT);
      events.push(ev({ type: 'strike', id: w.id, dir: w.dir, hit }));
    }
    if (this.warnings.length === 0) {
      const [lo, hi] = this.pace(now).gap;
      this.nextWarnAt = now + Math.round(lo + this.jitter() * (hi - lo));
    }
    const dead = allHit.filter((id) => (this.lives.get(id) ?? 0) <= 0);
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

  /** bots run along their paths, and those due to look around plan again */
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
      if (run.path.length > 0) {
        const from = this.pos.get(id)!;
        let p: Point = from;
        let budget = (botSpeedOf(this.level) * Math.max(0, now - run.movedAt)) / 1000;
        // along the path's cell centres, as far as this tick's running allows
        while (budget > 1e-9 && run.path.length > 0) {
          const next = run.path[0];
          const d = Math.hypot(next[0] - p[0], next[1] - p[1]);
          if (d <= budget) {
            p = this.slide(p, next);
            budget -= d;
            run.path.shift();
          } else {
            p = this.slide(p, this.cut(p, next, budget));
            budget = 0;
          }
        }
        if (p[0] !== from[0] || p[1] !== from[1]) {
          this.pos.set(id, p);
          events.push(ev({ type: 'step', playerId: id, to: [...p] }));
        }
      }
      run.movedAt = now;
      if (run.thinkAt <= now) {
        const plan = botThink(this, id, now, this.jitter);
        if (plan) {
          run.path = plan.path;
          run.plan = plan.plan;
        }
        run.thinkAt = now + botThinkMs(this.level, this.jitter);
      }
    }
    return events;
  }

  /** when the bots next need a step: a tick while any runs, else the next look around */
  private nextBotAt(): number {
    let at = Infinity;
    for (const run of this.botRun.values()) at = Math.min(at, run.thinkAt, run.path.length > 0 ? run.movedAt + SPIKES_BOT_TICK_MS : Infinity);
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
    // a strike goes before anything planned for the same moment; the next warning waits for it
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
      boxes: this.boxes.map(([c, r]) => [c, r] as [number, number]),
      warnings: this.warnings.map(({ id, dir, warnAt, strikeAt }) => ({ id, dir, warnAt, strikeAt })),
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
