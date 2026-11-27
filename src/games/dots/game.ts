import { secureRandom, type RandomInt } from '../../cards.js';
import { GameError } from '../../game.js';
import type { BetResult, DotsEvent, GameEvent, PlayerStats, TableGame } from '../../models.js';
import { standingsOf } from '../../standings.js';
import { dotsBoxesOf, dotsBoxLines, dotsLineCount, gameOpt, PARTY_COLORS, type Card, type DotsView, type GameConfig } from '../../types.js';

/** Dots and Boxes' per-account counters (stats.perGame.dots) */
export type DotsTally = { boxes: number };

const emptyStats = (): PlayerStats & { tallies: DotsTally } => ({
  bluffs: 0,
  caught: 0,
  goodCalls: 0,
  wrongCalls: 0,
  pickedUp: 0,
  plays: 0,
  chances: 0,
  tallies: { boxes: 0 },
});

const ev = (e: DotsEvent): GameEvent => ({ kind: 'dots', ev: e });

/** Dots and Boxes: draw a line; closing a box scores it and you go again; most boxes wins; no cards */
export class DotsGame implements TableGame<Card> {
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
  readonly size: number;
  readonly bots: Set<string>;
  /** line → who drew it */
  readonly lines = new Map<number, string>();
  /** box → who closed it */
  readonly boxes = new Map<number, string>();
  readonly scores = new Map<string, number>();
  last: DotsView['last'] = null;
  /** lines so far (last.seq) */
  seq = 0;
  /** goes up with every line and walk-out: drivers key their timers on it */
  stepSeq = 0;

  constructor(
    readonly order: string[],
    readonly config: GameConfig,
    rand: RandomInt = secureRandom,
    botIds: string[] = [],
  ) {
    if (order.length < 2 || order.length > PARTY_COLORS.length) throw new GameError('Dots and Boxes needs 2 to 4 players');
    const size = gameOpt<number>(config, 'size');
    this.size = size === 4 || size === 6 ? size : 5;
    this.bots = new Set(botIds);
    for (const id of order) {
      this.scores.set(id, 0);
      this.stats.set(id, emptyStats());
    }
    this.turnId = order[rand(order.length)];
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

  /** sides of a box drawn so far */
  sidesOf(box: number): number {
    const [row, col] = [Math.floor(box / this.size), box % this.size];
    return dotsBoxLines(this.size, row, col).filter((l) => this.lines.has(l)).length;
  }

  /** lines nobody has drawn yet */
  freeLines(): number[] {
    const out: number[] = [];
    for (let l = 0; l < dotsLineCount(this.size); l++) if (!this.lines.has(l)) out.push(l);
    return out;
  }

  /** draw a line: boxes it closes are yours and you go again */
  draw(id: string, line: number): GameEvent[] {
    if (this.over) throw new GameError('The game is over');
    if (!this.order.includes(id)) throw new GameError("You're not playing this game");
    if (this.turnId !== id) throw new GameError('Not your turn');
    if (!Number.isInteger(line) || line < 0 || line >= dotsLineCount(this.size)) throw new GameError('Pick a line between two dots');
    if (this.lines.has(line)) throw new GameError('That line is already drawn');
    this.lines.set(line, id);
    const closed = dotsBoxesOf(this.size, line).filter((b) => this.sidesOf(b) === 4);
    for (const b of closed) this.boxes.set(b, id);
    this.scores.set(id, this.scores.get(id)! + closed.length);
    (this.stats.get(id)!.tallies as DotsTally).boxes += closed.length;
    this.seq++;
    this.stepSeq++;
    this.last = { seq: this.seq, playerId: id, line, closed: [...closed] };
    const events: GameEvent[] = [ev({ type: 'line', playerId: id, line, closed: [...closed] })];
    if (this.boxes.size === this.size * this.size) return [...events, ...this.end()];
    if (closed.length === 0) this.passFrom(id);
    return events;
  }

  private passFrom(id: string): void {
    const n = this.order.length;
    const at = this.order.indexOf(id);
    for (let step = 1; step <= n; step++) {
      const next = this.order[(at + step) % n];
      if (!this.isOut(next)) {
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
    // finishing order by boxes (ties share a place)
    const still = this.order.filter((p) => !this.isOut(p));
    this.places = [...still].sort((a, b) => this.scores.get(b)! - this.scores.get(a)!);
    return [{ kind: 'gameOver', loserId: null }];
  }

  leave(id: string): GameEvent[] {
    if (this.over || !this.order.includes(id) || this.isOut(id)) return [];
    this.forfeited.add(id);
    return this.drop(id, false);
  }

  removePlayer(id: string): GameEvent[] {
    if (this.over || !this.order.includes(id) || this.kicked.has(id)) return [];
    this.kicked.add(id);
    return this.drop(id, true);
  }

  close(): GameEvent[] {
    if (this.over) return [];
    this.closed = true;
    return this.end();
  }

  private drop(id: string, kicked: boolean): GameEvent[] {
    this.stepSeq++;
    const still = this.order.filter((p) => !this.isOut(p));
    if (still.length <= 1) {
      // a kick leaves no fair winner; a walk-out hands the game to whoever is left
      this.aborted = kicked || still.length === 0;
      return this.end();
    }
    if (this.turnId === id) this.passFrom(id);
    return [];
  }

  /** most boxes among those still in; ties share */
  winners(): string[] {
    if (this.aborted || !this.over) return [];
    // stopped early (only bots left): nobody wins
    if (this.closed) return [];
    const still = this.order.filter((p) => !this.isOut(p));
    const best = Math.max(...still.map((p) => this.scores.get(p)!));
    return still.filter((p) => this.scores.get(p) === best);
  }

  losers(): string[] {
    if (this.aborted) return [];
    const won = this.winners();
    if (won.length === 0) return [...this.forfeited];
    return this.order.filter((id) => !won.includes(id) && !this.kicked.has(id));
  }

  /** once over: by boxes, equal counts share a place */
  placeOf(id: string): number | null {
    if (!this.over || this.aborted) return null;
    return standingsOf([], this.order.filter((p) => !this.isOut(p)), (p) => -this.scores.get(p)!).get(id) ?? null;
  }

  /** the table as everyone sees it (no secrets); scores in seat order */
  view(): DotsView {
    return {
      size: this.size,
      lines: Object.fromEntries(this.lines),
      boxes: Object.fromEntries(this.boxes),
      scores: Object.fromEntries(this.order.map((id) => [id, this.scores.get(id)!])),
      turnId: this.over ? null : this.turnId,
      last: this.last ? { ...this.last, closed: [...this.last.closed] } : null,
    };
  }
}
