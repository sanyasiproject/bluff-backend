import { secureRandom, type RandomInt } from '../../cards.js';
import { GameError } from '../../game.js';
import type { BetResult, DartsEvent, GameEvent, PlayerStats, TableGame } from '../../models.js';
import { standingsOf } from '../../standings.js';
import { dartScore, DARTS_PER_TURN, gameOpt, PARTY_COLORS, type Card, type DartThrow, type DartsView, type GameConfig } from '../../types.js';

/** Darts' per-account counters (stats.perGame.darts) */
export type DartsTally = { t180: number; bulls: number; checkouts: number };

/** extra shake the server adds to a person's throw: none, the sweep aim is the skill (bots aim with their own noise) */
export const DART_SHAKE = 0;
/** how long the board shows a finished turn's darts before the next player steps up (ms) */
export const DARTS_TURN_PAUSE_MS = 1_600;
/** a bot's pause before each dart (ms: from, plus up to) */
const BOT_PACE = [1_100, 700] as const;

const emptyStats = (): PlayerStats & { tallies: DartsTally } => ({
  bluffs: 0,
  caught: 0,
  goodCalls: 0,
  wrongCalls: 0,
  pickedUp: 0,
  plays: 0,
  chances: 0,
  tallies: { t180: 0, bulls: 0, checkouts: 0 },
});

const ev = (e: DartsEvent): GameEvent => ({ kind: 'darts', ev: e });

/** a normal random number (Box-Muller) */
export function gauss(rand: () => number): number {
  const u = Math.max(rand(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

/** Darts 301 / 501: three darts a turn, count down to exactly 0; below 0 is a bust; no cards */
export class DartsGame implements TableGame<Card> {
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
  readonly start: 301 | 501;
  readonly bots: Set<string>;
  readonly left = new Map<string, number>();
  thrown: DartThrow[] = [];
  turnStart: number;
  last: DartThrow | null = null;
  /** the turn's darts are done (3 thrown, bust or out): the board shows them, then the next player steps up */
  turnDone = false;
  /** darts so far (last.seq) */
  seq = 0;
  /** goes up with every dart and turn change: drivers key their timers on it */
  stepSeq = 0;
  /** a bot's pause before its next dart (ms at speed 1) */
  botPaceMs: number = BOT_PACE[0];

  constructor(
    readonly order: string[],
    readonly config: GameConfig,
    rand: RandomInt = secureRandom,
    botIds: string[] = [],
    readonly jitter: () => number = Math.random,
  ) {
    if (order.length < 2 || order.length > PARTY_COLORS.length) throw new GameError('Darts needs 2 to 4 players');
    this.start = gameOpt<number>(config, 'start') === 501 ? 501 : 301;
    this.bots = new Set(botIds);
    for (const id of order) {
      this.left.set(id, this.start);
      this.stats.set(id, emptyStats());
    }
    this.turnId = order[rand(order.length)];
    this.turnStart = this.start;
    this.paceBot();
  }

  hand(_id: string): Card[] {
    return [];
  }

  handValueOf(id: string): number {
    return this.left.get(id) ?? 0;
  }

  isOut(id: string): boolean {
    return this.kicked.has(id) || this.forfeited.has(id);
  }

  inPlay(id: string): boolean {
    return this.order.includes(id) && !this.isOut(id) && !this.places.includes(id);
  }

  private tallyOf(id: string): DartsTally {
    return this.stats.get(id)!.tallies as DartsTally;
  }

  /** a dart aimed at (x, y): the hand's shake moves it a little, then it scores */
  throw(id: string, x: number, y: number, shake = DART_SHAKE): GameEvent[] {
    if (this.over) throw new GameError('The game is over');
    if (!this.order.includes(id)) throw new GameError("You're not playing this game");
    if (this.turnId !== id) throw new GameError('Not your turn');
    if (this.turnDone) throw new GameError('Wait for the next turn');
    const hx = x + gauss(this.jitter) * shake;
    const hy = y + gauss(this.jitter) * shake;
    const hit = dartScore(hx, hy);
    const before = this.left.get(id)!;
    const after = before - hit.score;
    const bust = after < 0;
    this.seq++;
    this.stepSeq++;
    const dart: DartThrow = { seq: this.seq, playerId: id, x: round3(hx), y: round3(hy), ...hit, dart: this.thrown.length + 1, bust };
    this.thrown.push(dart);
    this.last = dart;
    if (hit.ring === 'bull') this.tallyOf(id).bulls++;
    const turnTotal = this.thrown.reduce((s, d) => s + d.score, 0);
    const events: GameEvent[] = [ev({ type: 'throw', dart: { ...dart }, turnTotal })];
    this.paceBot();
    if (bust) {
      this.left.set(id, this.turnStart);
      return [...events, ...this.endTurn(id, turnTotal, true, false)];
    }
    this.left.set(id, after);
    if (after === 0) {
      this.tallyOf(id).checkouts++;
      return [...events, ...this.endTurn(id, turnTotal, false, true)];
    }
    if (this.thrown.length >= DARTS_PER_TURN) return [...events, ...this.endTurn(id, turnTotal, false, false)];
    return events;
  }

  private endTurn(id: string, total: number, bust: boolean, out: boolean): GameEvent[] {
    this.turnDone = true;
    const t180 = !bust && this.thrown.length === DARTS_PER_TURN && total === 180;
    if (t180) this.tallyOf(id).t180++;
    const events: GameEvent[] = [ev({ type: 'turnEnd', playerId: id, total: bust ? 0 : total, bust, out, t180 })];
    if (!out) return events;
    this.places.push(id);
    events.push({ kind: 'finish', playerId: id, place: this.places.length });
    const still = this.order.filter((p) => this.inPlay(p));
    // the last one standing takes the last place
    if (still.length <= 1) {
      if (still[0]) {
        this.places.push(still[0]);
        events.push({ kind: 'finish', playerId: still[0], place: this.places.length });
      }
      return [...events, ...this.end()];
    }
    return events;
  }

  /** after the pause: the next player in play steps up */
  nextTurn(): GameEvent[] {
    if (this.over || !this.turnDone || !this.turnId) return [];
    this.passFrom(this.turnId);
    return [];
  }

  private passFrom(id: string): void {
    this.turnDone = false;
    this.thrown = [];
    this.stepSeq++;
    const n = this.order.length;
    const at = this.order.indexOf(id);
    this.turnId = null;
    for (let step = 1; step <= n; step++) {
      const next = this.order[(at + step) % n];
      if (this.inPlay(next)) {
        this.turnId = next;
        break;
      }
    }
    this.turnStart = this.turnId ? this.left.get(this.turnId)! : 0;
    this.paceBot();
  }

  private paceBot(): void {
    this.botPaceMs = BOT_PACE[0] + this.jitter() * BOT_PACE[1];
  }

  private end(): GameEvent[] {
    this.over = true;
    this.turnId = null;
    this.turnDone = false;
    this.stepSeq++;
    return [{ kind: 'gameOver', loserId: null }];
  }

  /** a player walks out: they lose and still pay */
  leave(id: string): GameEvent[] {
    if (this.over || !this.inPlay(id)) return [];
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
    // a turn in progress doesn't count
    if (this.turnId === id && !this.turnDone) this.left.set(id, this.turnStart);
    this.stepSeq++;
    const still = this.order.filter((p) => this.inPlay(p));
    if (still.length <= 1) {
      if (this.places.length === 0) {
        // a kick leaves no fair winner; a walk-out hands the game to whoever is left
        if (kicked || !still[0]) {
          this.aborted = kicked;
          return this.end();
        }
        this.places.push(still[0]);
        return [{ kind: 'finish', playerId: still[0], place: 1 }, ...this.end()];
      }
      return this.end();
    }
    if (this.turnId === id) this.passFrom(id);
    return [];
  }

  /** first to check out */
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

  /** once over: checkouts in order, then the rest by fewest points left */
  placeOf(id: string): number | null {
    if (!this.over || this.aborted) return standingsOf(this.places, [], () => 0).get(id) ?? null;
    return standingsOf(this.places, this.order.filter((p) => !this.isOut(p)), (p) => this.left.get(p)!).get(id) ?? null;
  }

  /** the table as everyone sees it (no secrets); left and places in seat order */
  view(): DartsView {
    const places: Record<string, number> = {};
    this.places.forEach((id, i) => (places[id] = i + 1));
    return {
      start: this.start,
      left: Object.fromEntries(this.order.map((id) => [id, this.left.get(id)!])),
      turnId: this.over ? null : this.turnId,
      thrown: this.thrown.map((d) => ({ ...d })),
      turnStart: this.turnStart,
      last: this.last ? { ...this.last } : null,
      places,
    };
  }
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;
