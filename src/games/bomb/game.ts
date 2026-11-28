import { secureRandom, type RandomInt } from '../../cards.js';
import { GameError } from '../../game.js';
import type { BetResult, BombEvent, GameEvent, PlayerStats, TableGame } from '../../models.js';
import { BOMB_BREAK_MS, BOMB_FAST_MS, BOMB_SHAKE_MS, gameOpt, type BombView, type BotLevel, type Card, type GameConfig } from '../../types.js';
import { makeTask, nextKind, seeded, type BombTaskFull } from './tasks.js';

/** Bomb Pass's per-account counters (stats.perGame.bomb) */
export type BombTally = { passes: number; booms: number; fastest: number };

export const BOMB_COUNTDOWN_MS = 3_000;
/** the hidden fuse (ms), by speed */
export const BOMB_FUSE = { normal: [12_000, 30_000], fast: [8_000, 20_000] } as const;
/** share of the fuse gone when the heat goes to 1, 2 and 3 */
export const BOMB_HEAT_AT = [0.7, 0.82, 0.92] as const;
/** a bot's answer time (ms: from, to) and its chance of a wrong tap, by level */
export const BOMB_BOT = {
  normal: { ms: [1_600, 3_200], wrong: 0.12 },
  hard: { ms: [1_100, 2_200], wrong: 0.07 },
  expert: { ms: [700, 1_400], wrong: 0.03 },
} as const;

const emptyStats = (): PlayerStats & { tallies: BombTally } => ({
  bluffs: 0, caught: 0, goodCalls: 0, wrongCalls: 0, pickedUp: 0, plays: 0, chances: 0,
  tallies: { passes: 0, booms: 0, fastest: 0 },
});

const ev = (e: BombEvent): GameEvent => ({ kind: 'bomb', ev: e });

/** Bomb Pass: solve the task to pass the bomb clockwise; whoever holds it when the hidden fuse ends loses a heart */
export class BombGame implements TableGame<Card> {
  readonly hands = new Map<string, Card[]>();
  readonly stats = new Map<string, PlayerStats>();
  readonly kicked = new Set<string>();
  readonly forfeited = new Set<string>();
  readonly teams = null;
  readonly bets: BetResult[] = [];
  readonly endedEarly = false;
  pile: Card[] = [];
  places: string[] = [];
  /** real-time: nobody has a turn */
  turnId: string | null = null;
  over = false;
  aborted = false;
  closed = false;
  readonly bots: Set<string>;
  readonly speed: 'normal' | 'fast';
  readonly maxHearts: number;
  readonly hearts = new Map<string, number>();
  /** out, first out first */
  readonly outOrder: string[] = [];
  /** out players who walked away afterwards */
  readonly gone = new Set<string>();
  phase: BombView['phase'] = 'countdown';
  readonly startsAt: number;
  round = 0;
  holder: string | null = null;
  heat: 0 | 1 | 2 | 3 = 0;
  /** the hidden fuse: the round's start and length (never sent) */
  roundAt = 0;
  fuseMs = 0;
  task: BombTaskFull | null = null;
  taskAt = 0;
  taskSeq = 0;
  shakeUntil = 0;
  /** a wrong answer: a new task comes then */
  newTaskAt: number | null = null;
  lastPass: BombView['lastPass'] = null;
  lastBoom: BombView['lastBoom'] = null;
  nextAt: number | null = null;
  /** a bot holder's planned answer */
  botPlan: { at: number; right: boolean } | null = null;
  stepSeq = 0;
  private readonly tr: () => number;

  constructor(
    readonly order: string[],
    readonly config: GameConfig,
    private readonly rand: RandomInt = secureRandom,
    botIds: string[] = [],
    readonly jitter: () => number = Math.random,
    readonly now: () => number = Date.now,
  ) {
    if (order.length < 2 || order.length > 4) throw new GameError('Bomb Pass needs 2 to 4 players');
    this.bots = new Set(botIds);
    this.speed = gameOpt<string>(config, 'speed') === 'fast' ? 'fast' : 'normal';
    this.maxHearts = gameOpt<number>(config, 'hearts') === 2 ? 2 : 3;
    for (const id of order) {
      this.hearts.set(id, this.maxHearts);
      this.stats.set(id, emptyStats());
    }
    this.tr = seeded(rand(2 ** 31));
    this.startsAt = this.now() + BOMB_COUNTDOWN_MS;
  }

  hand(_id: string): Card[] {
    return [];
  }

  handValueOf(id: string): number {
    return -(this.hearts.get(id) ?? 0);
  }

  isOut(id: string): boolean {
    return this.kicked.has(id) || this.forfeited.has(id);
  }

  alive(id: string): boolean {
    return this.order.includes(id) && !this.isOut(id) && (this.hearts.get(id) ?? 0) > 0;
  }

  /** still at the table: out players stay (they watch the bots finish) until they walk away */
  inPlay(id: string): boolean {
    return !this.over && this.order.includes(id) && !this.isOut(id) && !this.gone.has(id);
  }

  private tallyOf(id: string): BombTally {
    return this.stats.get(id)!.tallies as BombTally;
  }

  /** the next alive player clockwise after id */
  private nextAlive(id: string): string | null {
    const n = this.order.length;
    const at = this.order.indexOf(id);
    for (let s = 1; s <= n; s++) {
      const o = this.order[(at + s) % n];
      if (this.alive(o)) return o;
    }
    return null;
  }

  /** the next timed step: the start, a hotter fuse, a new task after a shake, a bot's answer, the BOOM, the next round */
  nextStep(): { at: number; run: () => GameEvent[] } | null {
    if (this.over) return null;
    if (this.phase === 'countdown') return { at: this.startsAt, run: () => this.startRound(this.order[this.rand(this.order.length)], true) };
    if (this.phase === 'boom') return this.nextAt === null ? null : { at: this.nextAt, run: () => this.startRound(this.holderAfterBoom(), false) };
    const steps: { at: number; run: () => GameEvent[] }[] = [{ at: this.roundAt + this.fuseMs, run: () => this.boom() }];
    const heatAt = (BOMB_HEAT_AT as readonly number[])[this.heat];
    if (heatAt !== undefined) steps.push({ at: this.roundAt + this.fuseMs * heatAt, run: () => this.heatUp() });
    if (this.newTaskAt !== null) steps.push({ at: this.newTaskAt, run: () => this.freshTask() });
    else if (this.botPlan && this.holder) {
      const id = this.holder;
      const plan = this.botPlan;
      steps.push({ at: plan.at, run: () => this.botAnswer(id, plan.right) });
    }
    return steps.reduce((a, b) => (b.at < a.at ? b : a));
  }

  private holderAfterBoom(): string {
    const last = this.lastBoom?.playerId ?? this.order[0];
    return this.nextAlive(last) ?? this.order.find((p) => this.alive(p))!;
  }

  private startRound(holder: string, first: boolean): GameEvent[] {
    this.stepSeq++;
    this.phase = 'play';
    this.round++;
    this.heat = 0;
    this.nextAt = null;
    this.roundAt = this.now();
    const [lo, hi] = BOMB_FUSE[this.speed];
    this.fuseMs = lo + this.rand(hi - lo + 1);
    this.holder = holder;
    this.issueTask();
    return [...(first ? [ev({ type: 'go' })] : []), ev({ type: 'round', round: this.round, holder })];
  }

  private issueTask(): void {
    const d = Math.min(3, Math.floor((this.round - 1) / 2));
    this.task = makeTask(this.tr, ++this.taskSeq, nextKind(this.tr, this.task?.task.kind ?? null), d);
    this.taskAt = this.now();
    this.newTaskAt = null;
    this.botPlan = null;
    const h = this.holder;
    if (h && this.bots.has(h)) {
      const lv = BOMB_BOT[this.config.botLevel as BotLevel] ?? BOMB_BOT.hard;
      this.botPlan = { at: this.taskAt + lv.ms[0] + this.jitter() * (lv.ms[1] - lv.ms[0]), right: this.jitter() >= lv.wrong };
    }
  }

  private freshTask(): GameEvent[] {
    this.stepSeq++;
    this.issueTask();
    return [ev({ type: 'task', playerId: this.holder! })];
  }

  private heatUp(): GameEvent[] {
    this.stepSeq++;
    this.heat = Math.min(3, this.heat + 1) as 0 | 1 | 2 | 3;
    return [ev({ type: 'heat', heat: this.heat })];
  }

  private botAnswer(id: string, right: boolean): GameEvent[] {
    if (!this.task || this.holder !== id) return [];
    const ans = this.task.answer;
    const n = this.task.task.choices.length;
    return this.answer(id, this.task.task.id, right ? ans : (ans + 1 + Math.floor(this.jitter() * (n - 1))) % n);
  }

  /** the holder taps a choice; stale or shaking taps do nothing */
  answer(id: string, taskId: number, choice: number): GameEvent[] {
    if (this.over) throw new GameError('The game is over');
    if (!this.order.includes(id)) throw new GameError("You're not playing this game");
    if (this.phase !== 'play' || !this.task || taskId !== this.task.task.id || this.newTaskAt !== null) return [];
    if (this.holder !== id) throw new GameError("You don't have the bomb");
    if (!Number.isInteger(choice) || choice < 0 || choice >= this.task.task.choices.length) throw new GameError('Pick one of the answers');
    this.stepSeq++;
    const now = this.now();
    if (choice !== this.task.answer) {
      this.shakeUntil = now + BOMB_SHAKE_MS;
      this.newTaskAt = this.shakeUntil;
      this.botPlan = null;
      return [ev({ type: 'wrong', playerId: id })];
    }
    const to = this.nextAlive(id) ?? id;
    const ms = now - this.taskAt;
    const t = this.tallyOf(id);
    t.passes++;
    if (ms <= BOMB_FAST_MS) t.fastest++;
    this.lastPass = { from: id, to, at: now, ms };
    this.holder = to;
    this.issueTask();
    return [ev({ type: 'pass', from: id, to, ms })];
  }

  private boom(): GameEvent[] {
    this.stepSeq++;
    const id = this.holder!;
    const left = Math.max(0, (this.hearts.get(id) ?? 1) - 1);
    this.hearts.set(id, left);
    this.tallyOf(id).booms++;
    const out = left === 0;
    if (out) this.outOrder.push(id);
    const now = this.now();
    this.lastBoom = { playerId: id, at: now, out };
    this.phase = 'boom';
    this.holder = null;
    this.task = null;
    this.botPlan = null;
    this.newTaskAt = null;
    this.heat = 0;
    this.nextAt = now + BOMB_BREAK_MS;
    const events = [ev({ type: 'boom', playerId: id, out, place: out ? this.placeOf(id) : null })];
    if (this.order.filter((p) => this.alive(p)).length <= 1) return [...events, ...this.end()];
    return events;
  }

  private end(): GameEvent[] {
    this.over = true;
    this.phase = 'over';
    this.holder = null;
    this.task = null;
    this.botPlan = null;
    this.nextAt = null;
    this.stepSeq++;
    this.places = [...this.order.filter((p) => this.alive(p)), ...[...this.outOrder].reverse()].filter((p) => !this.isOut(p));
    return [{ kind: 'gameOver', loserId: null }];
  }

  /** a player walks out: they lose and still pay */
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

  /** the host removed a player: they pay and win nothing */
  removePlayer(id: string): GameEvent[] {
    if (this.over || !this.order.includes(id) || this.kicked.has(id)) return [];
    const wasAlive = this.alive(id);
    this.kicked.add(id);
    return wasAlive ? this.drop(id, true) : [];
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
    if (this.holder === id) {
      this.holder = this.nextAlive(id);
      this.issueTask();
    }
    return [];
  }

  /** the last one alive */
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

  /** alive players share the top places; the first out is last */
  placeOf(id: string): number | null {
    if (!this.order.includes(id) || this.isOut(id)) return null;
    const alive = this.order.filter((p) => this.alive(p));
    // no place while still playing; a closed game ranks those left by what they had
    if (alive.includes(id)) return this.over ? 1 + alive.filter((p) => this.hearts.get(p)! > this.hearts.get(id)!).length : null;
    const i = this.outOrder.filter((p) => !this.isOut(p)).indexOf(id);
    const outs = this.outOrder.filter((p) => !this.isOut(p));
    return alive.length + (outs.length - i);
  }

  view(): BombView {
    const places: Record<string, number> = {};
    for (const id of this.order) {
      if (this.isOut(id)) continue;
      if (this.over || !this.alive(id)) places[id] = this.placeOf(id)!;
    }
    return {
      phase: this.phase,
      startsAt: this.startsAt,
      round: this.round,
      speed: this.speed,
      maxHearts: this.maxHearts,
      hearts: Object.fromEntries(this.order.map((id) => [id, this.hearts.get(id)!])),
      holder: this.holder,
      heat: this.heat,
      task: this.task ? { ...this.task.task, choices: [...this.task.task.choices], ...(this.task.task.dots ? { dots: this.task.task.dots.map((d) => [...d] as [number, number]) } : {}) } : null,
      shakeUntil: this.shakeUntil,
      lastPass: this.lastPass ? { ...this.lastPass } : null,
      lastBoom: this.lastBoom ? { ...this.lastBoom } : null,
      nextAt: this.nextAt,
      places,
      now: this.now(),
    };
  }
}
