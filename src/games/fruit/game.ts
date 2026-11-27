import { secureRandom, type RandomInt } from '../../cards.js';
import { GameError } from '../../game.js';
import type { BetResult, FruitEvent, GameEvent, PlayerStats, TableGame } from '../../models.js';
import { standingsOf } from '../../standings.js';
import {
  FRUIT_COLLECT_MS,
  FRUIT_ITEM_MS,
  FRUIT_ITEM_POINTS,
  FRUIT_KINDS,
  FRUIT_MAGNET_ROUNDS,
  FRUIT_MIN_REACTION_MS,
  FRUIT_SLOW_MS,
  gameOpt,
  type BotLevel,
  type Card,
  type FruitItemKind,
  type FruitView,
  type GameConfig,
} from '../../types.js';

/** Fruit Slice Duel's per-account counters (stats.perGame.fruit): fruit won, magnets struck, and bestReflex = 1000 − best reaction ms (kept with $max) */
export type FruitTally = { won: number; magnets: number; bestReflex: number };

/** the 3-2-1 before the first item (ms) */
export const FRUIT_COUNTDOWN_MS = 3_000;
/** the result stays up this long before the next gap starts (ms) */
export const FRUIT_RESULT_MS = 1_200;
/** the wait before each item: random in this range, so nobody can time it (ms) */
export const FRUIT_GAP_MS = [1_000, 2_600] as const;
/** a claimed reaction may exceed the time since the item showed by this much (clock rounding) */
export const FRUIT_CLOCK_SLACK_MS = 30;
/** chance the next item is a magnet (never two in a row, so about 1 in 4 overall) */
const MAGNET_ODDS = 0.33;
/** bots' reaction range and chance they strike a magnet by mistake, by level */
export const FRUIT_BOT: Record<BotLevel, { reaction: [number, number]; magnet: number }> = {
  normal: { reaction: [430, 760], magnet: 0.18 },
  hard: { reaction: [320, 560], magnet: 0.09 },
  expert: { reaction: [250, 420], magnet: 0.04 },
};
const FRUITS = FRUIT_KINDS.filter((k): k is Exclude<FruitItemKind, 'magnet'> => k !== 'bomb');

const emptyStats = (): PlayerStats & { tallies: FruitTally } => ({
  bluffs: 0,
  caught: 0,
  goodCalls: 0,
  wrongCalls: 0,
  pickedUp: 0,
  plays: 0,
  chances: 0,
  tallies: { won: 0, magnets: 0, bestReflex: 0 },
});

const ev = (e: FruitEvent): GameEvent => ({ kind: 'fruit', ev: e });

/** one taken strike: the claimed reaction and when the server got it */
interface Strike {
  reaction: number;
  at: number;
}

/** Fruit Slice Duel: one item at a time; fastest reaction takes a fruit, striking a magnet slows your sword */
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
  /** nobody has a turn: everyone strikes at once */
  turnId: string | null = null;
  over = false;
  aborted = false;
  closed = false;
  phase: FruitView['phase'] = 'countdown';
  readonly rounds: number;
  readonly startsAt: number;
  readonly bots: Set<string>;
  readonly level: BotLevel;
  readonly scores = new Map<string, number>();
  /** items each player's sword stays slow for */
  readonly slow = new Map<string, number>();
  /** the item number now up or last shown (0 before the first) */
  round = 0;
  item: FruitView['item'] = null;
  result: FruitView['result'] = null;
  /** strikes taken for the item up */
  readonly strikes = new Map<string, Strike>();
  /** when the server got the first strike for the item up */
  firstStrikeAt: number | null = null;
  /** when the next item shows (between items) */
  nextItemAt = Infinity;
  /** bots' planned strikes for the item up, server time */
  botPlan: { id: string; at: number; reaction: number }[] = [];
  /** goes up with every timed step and with strikes that move the deadline: drivers key their timers on it */
  stepSeq = 0;

  constructor(
    readonly order: string[],
    readonly config: GameConfig,
    _rand: RandomInt = secureRandom,
    botIds: string[] = [],
    readonly now: () => number = Date.now,
    private readonly jitter: () => number = Math.random,
  ) {
    if (order.length < 2 || order.length > 4) throw new GameError('Fruit Slice Duel needs 2 to 4 players');
    this.rounds = gameOpt<number>(config, 'rounds');
    this.startsAt = this.now() + FRUIT_COUNTDOWN_MS;
    this.bots = new Set(botIds);
    this.level = (config.botLevel ?? 'hard') as BotLevel;
    for (const id of order) {
      this.stats.set(id, emptyStats());
      this.scores.set(id, 0);
      this.slow.set(id, 0);
    }
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

  private still(): string[] {
    return this.order.filter((id) => !this.isOut(id));
  }

  /** a random wait before the next item */
  private gap(): number {
    return FRUIT_GAP_MS[0] + this.jitter() * (FRUIT_GAP_MS[1] - FRUIT_GAP_MS[0]);
  }

  /** the countdown is over: the first wait starts */
  go(): GameEvent[] {
    if (this.over || this.phase !== 'countdown') return [];
    this.phase = 'play';
    this.nextItemAt = this.now() + this.gap();
    this.stepSeq++;
    return [ev({ type: 'go', rounds: this.rounds })];
  }

  /** the next item pops up; bots plan their strikes */
  showItem(): GameEvent[] {
    if (this.over || this.phase !== 'play' || this.item) return [];
    const now = this.now();
    this.round++;
    const lastMagnet = this.result?.kind === 'magnet';
    const kind: FruitItemKind = !lastMagnet && this.jitter() < MAGNET_ODDS ? 'magnet' : FRUITS[Math.floor(this.jitter() * FRUITS.length)];
    this.item = { round: this.round, kind, shownAt: now };
    this.strikes.clear();
    this.firstStrikeAt = null;
    this.nextItemAt = Infinity;
    this.botPlan = [];
    const odds = FRUIT_BOT[this.level] ?? FRUIT_BOT.hard;
    for (const id of this.still()) {
      if (!this.bots.has(id)) continue;
      if (kind === 'magnet' && this.jitter() >= odds.magnet) continue;
      const reaction = Math.round(odds.reaction[0] + this.jitter() * (odds.reaction[1] - odds.reaction[0]));
      this.botPlan.push({ id, at: now + reaction, reaction });
    }
    this.botPlan.sort((a, b) => a.at - b.at);
    this.stepSeq++;
    return [ev({ type: 'item', round: this.round, kind })];
  }

  /** when the item up closes: FRUIT_COLLECT_MS after the first strike, or FRUIT_ITEM_MS after it showed */
  deadline(): number {
    if (!this.item) return Infinity;
    const cap = this.item.shownAt + FRUIT_ITEM_MS;
    return this.firstStrikeAt === null ? cap : Math.min(cap, this.firstStrikeAt + FRUIT_COLLECT_MS);
  }

  /** a person's strike at item `round`, `reaction` ms after the item showed on their screen */
  strike(id: string, round: number, reaction: number): GameEvent[] {
    if (this.over) throw new GameError('The game is over');
    if (!this.order.includes(id) || this.isOut(id)) throw new GameError("You're not playing this game");
    const now = this.now();
    if (this.phase === 'countdown') throw new GameError('Wait for the countdown');
    if (!this.item || round !== this.item.round) throw new GameError(round <= this.round ? 'Too late, that item is over' : 'Wait for the item to show');
    if (now > this.deadline()) throw new GameError('Too late, that item is over');
    if (this.strikes.has(id)) throw new GameError('You already struck this one');
    if (reaction < FRUIT_MIN_REACTION_MS) throw new GameError('Too fast to be real, that strike did not count');
    // the phone drew the item only after the server sent it, so a real reaction fits in the time since
    if (reaction > now - this.item.shownAt + FRUIT_CLOCK_SLACK_MS) throw new GameError("That strike doesn't match the clock, it did not count");
    return this.take(id, reaction, now);
  }

  /** a strike counts; the first one starts the collect window, and once everyone has struck the item closes */
  private take(id: string, reaction: number, at: number): GameEvent[] {
    this.strikes.set(id, { reaction, at });
    if (this.firstStrikeAt === null) this.firstStrikeAt = at;
    this.stepSeq++;
    const events = [ev({ type: 'strike', playerId: id, round: this.round })];
    if (this.still().every((p) => this.strikes.has(p))) events.push(...this.resolve());
    return events;
  }

  /** bots' strikes due by now */
  botStrikes(): GameEvent[] {
    if (this.over || !this.item) return [];
    const now = this.now();
    const events: GameEvent[] = [];
    this.stepSeq++;
    while (this.item && this.botPlan.length > 0 && this.botPlan[0].at <= now) {
      const s = this.botPlan.shift()!;
      if (this.still().includes(s.id) && !this.strikes.has(s.id)) events.push(...this.take(s.id, s.reaction, now));
    }
    return events;
  }

  /** the item closes: a fruit goes to the fastest (slowed swords +FRUIT_SLOW_MS); a magnet slows whoever struck it */
  resolve(): GameEvent[] {
    const item = this.item;
    if (this.over || !item) return [];
    const now = this.now();
    const still = this.still();
    const judged = new Map<string, Strike>();
    for (const [id, s] of this.strikes) if (still.includes(id)) judged.set(id, { reaction: s.reaction + ((this.slow.get(id) ?? 0) > 0 ? FRUIT_SLOW_MS : 0), at: s.at });
    const reactions = Object.fromEntries(still.map((id) => [id, judged.get(id)?.reaction ?? null]));
    let winner: string | null = null;
    let points = 0;
    let slowed: string[] = [];
    if (item.kind === 'magnet') slowed = [...judged.keys()];
    else {
      // fastest judged reaction; a dead heat goes to the strike the server got first
      for (const [id, s] of judged) {
        const best = winner ? judged.get(winner)! : null;
        if (!best || s.reaction < best.reaction || (s.reaction === best.reaction && s.at < best.at)) winner = id;
      }
      for (const [id] of judged) {
        const t = this.tallyOf(id);
        t.bestReflex = Math.max(t.bestReflex, Math.max(0, 1000 - this.strikes.get(id)!.reaction));
      }
      if (winner) {
        points = FRUIT_ITEM_POINTS[item.kind];
        this.scores.set(winner, (this.scores.get(winner) ?? 0) + points);
        this.tallyOf(winner).won++;
      }
    }
    // this item used up one slowed item; magnet strikers are slowed for the next ones
    for (const id of this.order) this.slow.set(id, Math.max(0, (this.slow.get(id) ?? 0) - 1));
    for (const id of slowed) {
      this.slow.set(id, FRUIT_MAGNET_ROUNDS);
      this.tallyOf(id).magnets++;
    }
    this.result = { round: item.round, kind: item.kind, winner, reactions, slowed };
    this.item = null;
    this.strikes.clear();
    this.botPlan = [];
    this.firstStrikeAt = null;
    this.stepSeq++;
    const events = [ev({ type: 'result', round: item.round, kind: item.kind, winner, points, slowed })];
    if (this.round >= this.rounds) events.push(...this.end());
    else this.nextItemAt = now + FRUIT_RESULT_MS + this.gap();
    return events;
  }

  /** the next timed step: the countdown ends, an item shows, bots strike, or the item closes */
  nextStep(): { at: number; run: () => GameEvent[] } | null {
    if (this.over) return null;
    if (this.phase === 'countdown') return { at: this.startsAt, run: () => this.go() };
    if (!this.item) return { at: this.nextItemAt, run: () => this.showItem() };
    const close = this.deadline();
    const bot = this.botPlan[0];
    if (bot && bot.at < close) return { at: bot.at, run: () => this.botStrikes() };
    return { at: close, run: () => this.resolve() };
  }

  private end(): GameEvent[] {
    this.over = true;
    this.phase = 'over';
    this.item = null;
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
    if (still.length > 1) {
      // everyone left may already have struck
      return this.item && still.every((p) => this.strikes.has(p)) ? this.resolve() : [];
    }
    // a kick leaves no fair winner; a walk-out hands the game to whoever is left
    if (!walked || still.length === 0) this.aborted = true;
    return this.end();
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

  /** the same for everyone: who struck stays hidden until the result */
  view(): FruitView {
    const rec = <T>(m: Map<string, T>) => Object.fromEntries(this.order.map((id) => [id, m.get(id)!]));
    return {
      phase: this.phase,
      round: this.round,
      rounds: this.rounds,
      item: this.item ? { ...this.item } : null,
      result: this.result ? { ...this.result, reactions: { ...this.result.reactions }, slowed: [...this.result.slowed] } : null,
      scores: rec(this.scores),
      slow: rec(this.slow),
      startsAt: this.startsAt,
      now: this.now(),
    };
  }
}
