import { secureRandom, type RandomInt } from '../../cards.js';
import { GameError } from '../../game.js';
import type { BetResult, FruitEvent, GameEvent, PlayerStats, TableGame } from '../../models.js';
import { standingsOf } from '../../standings.js';
import { FRUIT_POINTS, FRUIT_SLICE_SLACK_MS, fruitAt, fruitWave, gameOpt, type BotLevel, type Card, type FruitSpawn, type FruitView, type GameConfig } from '../../types.js';

/** Fruit Slice Duel's per-account counters (stats.perGame.fruit); bestCombo keeps the highest game */
export type FruitTally = { sliced: number; bombs: number; bestCombo: number };

/** the 3-2-1 before the fruit start flying (ms) */
export const FRUIT_COUNTDOWN_MS = 3_000;
/** most fruit ids one swipe may carry */
export const FRUIT_MAX_IDS = 12;
/** bot swipes this close together go out as one step (ms) */
const BOT_BATCH_MS = 120;
/** a bot's slices this close together are one swipe, so bots make combos too (ms) */
const BOT_SWIPE_MS = 160;
/** chance a bot slices a fruit, and cuts a bomb by mistake, by level */
const BOT_ODDS: Record<BotLevel, { fruit: number; bomb: number }> = {
  normal: { fruit: 0.55, bomb: 0.1 },
  hard: { fruit: 0.72, bomb: 0.05 },
  expert: { fruit: 0.85, bomb: 0.02 },
};

/** one planned bot swipe: ms after the start */
interface BotSwipe {
  playerId: string;
  at: number;
  ids: number[];
}

const emptyStats = (): PlayerStats & { tallies: FruitTally } => ({
  bluffs: 0,
  caught: 0,
  goodCalls: 0,
  wrongCalls: 0,
  pickedUp: 0,
  plays: 0,
  chances: 0,
  tallies: { sliced: 0, bombs: 0, bestCombo: 0 },
});

const ev = (e: FruitEvent): GameEvent => ({ kind: 'fruit', ev: e });

/** on the play area at that moment (a little margin for the fruit's size) */
export function onScreen(f: FruitSpawn, ms: number): boolean {
  const p = fruitAt(f, ms);
  return p !== null && p.y >= -0.05 && p.y <= 1.05 && p.x >= -0.05 && p.x <= 1.05;
}

/** ms after its throw when a fruit is at the top of its flight */
export const peakMsOf = (f: FruitSpawn): number => f.t + (f.vy / 1.6) * 1000;

/** Fruit Slice Duel: everyone slices the same seeded wave at once; highest score when time runs out wins */
export class FruitGame implements TableGame<Card> {
  readonly hands = new Map<string, Card[]>();
  readonly stats = new Map<string, PlayerStats>();
  readonly kicked = new Set<string>();
  readonly forfeited = new Set<string>();
  readonly teams = null;
  readonly bets: BetResult[] = [];
  readonly endedEarly = false;
  pile: Card[] = [];
  places: string[] = [];
  /** nobody has a turn: everyone slices at once */
  turnId: string | null = null;
  over = false;
  aborted = false;
  closed = false;
  phase: FruitView['phase'] = 'countdown';
  readonly seed: number;
  readonly seconds: number;
  readonly wave: FruitSpawn[];
  readonly startsAt: number;
  readonly endsAt: number;
  readonly bots: Set<string>;
  readonly scores = new Map<string, number>();
  readonly sliced = new Map<string, Set<number>>();
  readonly combo = new Map<string, number>();
  readonly bombs = new Map<string, number>();
  /** goes up with every timed step (not with people's swipes): drivers key their timers on it */
  stepSeq = 0;
  /** every bot swipe of the game, planned at the start, in time order */
  readonly botPlan: BotSwipe[];
  private planAt = 0;
  private readonly byId: Map<number, FruitSpawn>;

  constructor(
    readonly order: string[],
    readonly config: GameConfig,
    rand: RandomInt = secureRandom,
    botIds: string[] = [],
    readonly now: () => number = Date.now,
    jitter: () => number = Math.random,
  ) {
    if (order.length < 2 || order.length > 4) throw new GameError('Fruit Slice Duel needs 2 to 4 players');
    this.seconds = gameOpt<number>(config, 'time');
    this.seed = rand(2_000_000_000) + 1;
    this.wave = fruitWave(this.seed, this.seconds);
    this.byId = new Map(this.wave.map((f) => [f.id, f]));
    this.startsAt = this.now() + FRUIT_COUNTDOWN_MS;
    this.endsAt = this.startsAt + this.seconds * 1000;
    this.bots = new Set(botIds);
    for (const id of order) {
      this.stats.set(id, emptyStats());
      this.scores.set(id, 0);
      this.sliced.set(id, new Set());
      this.combo.set(id, 0);
      this.bombs.set(id, 0);
    }
    this.botPlan = order.filter((id) => this.bots.has(id)).flatMap((id) => this.planBot(id, config.botLevel, jitter));
    this.botPlan.sort((a, b) => a.at - b.at);
  }

  /** a bot's swipes: each fruit near its peak by chance, now and then a bomb by mistake */
  private planBot(id: string, level: BotLevel, jitter: () => number): BotSwipe[] {
    const odds = BOT_ODDS[level] ?? BOT_ODDS.hard;
    const cuts: { at: number; id: number }[] = [];
    for (const f of this.wave) {
      if (jitter() >= (f.kind === 'bomb' ? odds.bomb : odds.fruit)) continue;
      const at = Math.round(peakMsOf(f) + (jitter() - 0.5) * 500);
      if (at < this.seconds * 1000 && onScreen(f, at)) cuts.push({ at, id: f.id });
    }
    cuts.sort((a, b) => a.at - b.at);
    const out: BotSwipe[] = [];
    for (const c of cuts) {
      const last = out[out.length - 1];
      // close enough to cut in one stroke, and still on screen then
      if (last && c.at - last.at <= BOT_SWIPE_MS && onScreen(this.byId.get(c.id)!, last.at)) last.ids.push(c.id);
      else out.push({ playerId: id, at: c.at, ids: [c.id] });
    }
    return out;
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

  inPlay(id: string): boolean {
    return this.order.includes(id) && !this.isOut(id) && !this.over;
  }

  private tallyOf(id: string): FruitTally {
    return this.stats.get(id)!.tallies as FruitTally;
  }

  /** the countdown is over: the fruit start flying */
  go(): GameEvent[] {
    if (this.over || this.phase !== 'countdown') return [];
    this.phase = 'play';
    this.stepSeq++;
    return [ev({ type: 'go', seconds: this.seconds })];
  }

  /** a person's swipe: `at` (ms after startsAt) must be within the slack of the server's own clock */
  slice(id: string, ids: number[], at: number): GameEvent[] {
    if (this.over) throw new GameError("Time's up");
    if (!this.order.includes(id) || this.isOut(id)) throw new GameError("You're not playing this game");
    const t = this.now() - this.startsAt;
    if (t < 0 || at < 0) throw new GameError('Wait for the countdown');
    if (t - at > FRUIT_SLICE_SLACK_MS) throw new GameError('Too late, that swipe did not count');
    if (at - t > FRUIT_SLICE_SLACK_MS) throw new GameError('That swipe is ahead of the clock');
    if (at > this.seconds * 1000) throw new GameError("Time's up");
    return this.cut(id, ids, at);
  }

  /** the fruit really cut: each once per player, only while on screen at `at` */
  private cut(id: string, ids: number[], at: number): GameEvent[] {
    const mine = this.sliced.get(id)!;
    const unique = [...new Set(ids)];
    const cut = unique.map((x) => this.byId.get(x)).filter((f): f is FruitSpawn => !!f && !mine.has(f.id) && onScreen(f, at));
    if (cut.length === 0) throw new GameError(unique.every((x) => mine.has(x)) ? 'Already sliced' : 'Nothing to slice there');
    const fruit = cut.filter((f) => f.kind !== 'bomb').length;
    const bombs = cut.length - fruit;
    // a swipe of 3+ fruit: +1 for each fruit over 2
    const points = cut.reduce((n, f) => n + FRUIT_POINTS[f.kind], 0) + Math.max(0, fruit - 2);
    for (const f of cut) mine.add(f.id);
    this.scores.set(id, (this.scores.get(id) ?? 0) + points);
    this.combo.set(id, Math.max(this.combo.get(id) ?? 0, fruit));
    this.bombs.set(id, (this.bombs.get(id) ?? 0) + bombs);
    const tally = this.tallyOf(id);
    tally.sliced += fruit;
    tally.bombs += bombs;
    tally.bestCombo = Math.max(tally.bestCombo, fruit);
    return [ev({ type: 'slice', playerId: id, ids: cut.map((f) => f.id), points, combo: fruit, bomb: bombs > 0 })];
  }

  /** the next batch of bot swipes (those within BOT_BATCH_MS of the first), played as planned */
  botSwipes(): GameEvent[] {
    if (this.over || this.planAt >= this.botPlan.length) return [];
    const first = this.botPlan[this.planAt].at;
    const events: GameEvent[] = [];
    while (this.planAt < this.botPlan.length && this.botPlan[this.planAt].at <= first + BOT_BATCH_MS) {
      const s = this.botPlan[this.planAt++];
      if (!this.inPlay(s.playerId)) continue;
      try {
        events.push(...this.cut(s.playerId, s.ids, s.at));
      } catch (err) {
        if (!(err instanceof GameError)) throw err;
      }
    }
    this.stepSeq++;
    return events;
  }

  /** the next timed step: the countdown ends, bots swipe, or time runs out */
  nextStep(): { at: number; run: () => GameEvent[] } | null {
    if (this.over) return null;
    if (this.phase === 'countdown') return { at: this.startsAt, run: () => this.go() };
    const bot = this.botPlan[this.planAt];
    if (bot && this.startsAt + bot.at < this.endsAt) return { at: this.startsAt + bot.at, run: () => this.botSwipes() };
    return { at: this.endsAt, run: () => this.finish() };
  }

  /** time is up: highest score wins */
  finish(): GameEvent[] {
    if (this.over) return [];
    return this.end();
  }

  private end(): GameEvent[] {
    this.over = true;
    this.phase = 'over';
    this.stepSeq++;
    return [{ kind: 'gameOver', loserId: null }];
  }

  /** a player walks out: they lose and still pay */
  leave(id: string): GameEvent[] {
    if (this.over || !this.order.includes(id) || this.isOut(id)) return [];
    this.forfeited.add(id);
    return this.drop(true);
  }

  /** the host removed a player: they pay and win nothing */
  removePlayer(id: string): GameEvent[] {
    if (this.over || !this.order.includes(id) || this.kicked.has(id)) return [];
    this.kicked.add(id);
    return this.drop(false);
  }

  /** no person is left playing: stopped, nobody wins */
  close(): GameEvent[] {
    if (this.over) return [];
    this.closed = true;
    return this.end();
  }

  private drop(walked: boolean): GameEvent[] {
    this.stepSeq++;
    const still = this.still();
    if (still.length > 1) return [];
    // a kick leaves no fair winner; a walk-out hands the game to whoever is left
    if (!walked || still.length === 0) this.aborted = true;
    return this.end();
  }

  private still(): string[] {
    return this.order.filter((id) => !this.isOut(id));
  }

  /** the top score among those still seated, ties share */
  winners(): string[] {
    if (this.aborted || !this.over || this.closed) return [];
    const still = this.still();
    if (still.length === 0) return [];
    const best = Math.max(...still.map((id) => this.scores.get(id) ?? 0));
    return still.filter((id) => (this.scores.get(id) ?? 0) === best);
  }

  /** everyone who didn't win (walk-outs included, removed players not) */
  losers(): string[] {
    if (this.aborted) return [];
    const won = this.winners();
    if (won.length === 0) return [...this.forfeited];
    return this.order.filter((id) => !won.includes(id) && !this.kicked.has(id));
  }

  /** once over: by score, ties share the place */
  placeOf(id: string): number | null {
    if (!this.over || this.aborted || this.closed) return null;
    return standingsOf([], this.still(), (p) => -(this.scores.get(p) ?? 0)).get(id) ?? null;
  }

  /** the same for everyone: the seed draws the wave on each phone */
  view(): FruitView {
    const rec = <T>(m: Map<string, T>) => Object.fromEntries(this.order.map((id) => [id, m.get(id)!]));
    return {
      phase: this.phase,
      seed: this.seed,
      seconds: this.seconds,
      startsAt: this.startsAt,
      endsAt: this.endsAt,
      scores: rec(this.scores),
      sliced: Object.fromEntries(this.order.map((id) => [id, [...this.sliced.get(id)!]])),
      combo: rec(this.combo),
      bombs: rec(this.bombs),
      now: this.now(),
    };
  }
}
