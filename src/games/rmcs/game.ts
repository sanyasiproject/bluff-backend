import { secureRandom, shuffle, type RandomInt } from '../../cards.js';
import { GameError } from '../../game.js';
import type { BetResult, GameEvent, PlayerStats, RmcsEvent, TableGame } from '../../models.js';
import { standingsOf } from '../../standings.js';
import { gameOpt, RMCS_OPEN_SEC, RMCS_POINTS, RMCS_ROLES, type Card, type GameConfig, type RmcsPhase, type RmcsRole, type RmcsRound, type RmcsView } from '../../types.js';

/** Raja Mantri's per-account counters (stats.perGame.rmcs) */
export type RmcsTally = { caught: number; escaped: number; raja: number };

/** the Mantri's time to point at the Chor, and how long a round's result shows (ms) */
export const RMCS_GUESS_MS = 20_000;
export const RMCS_RESULT_MS = 4_000;
/** a bot opens its chit this long after the deal (ms: from, plus up to) */
const BOT_OPEN = [1_200, 2_500] as const;
/** a bot Mantri thinks this long before pointing (ms: from, plus up to) */
const BOT_GUESS = [1_800, 2_500] as const;
/** a seat that walked out plays by itself after this pause (ms) */
const OUT_PAUSE = 400;

const emptyStats = (): PlayerStats & { tallies: RmcsTally } => ({
  bluffs: 0,
  caught: 0,
  goodCalls: 0,
  wrongCalls: 0,
  pickedUp: 0,
  plays: 0,
  chances: 0,
  tallies: { caught: 0, escaped: 0, raja: 0 },
});

const ev = (e: RmcsEvent): GameEvent => ({ kind: 'rmcs', ev: e });

/** Raja Mantri Chor Sipahi: four chits a round, the Mantri finds the Chor, points add up over the rounds; no cards */
export class RmcsGame implements TableGame<Card> {
  readonly hands = new Map<string, Card[]>();
  readonly stats = new Map<string, PlayerStats>();
  readonly kicked = new Set<string>();
  readonly forfeited = new Set<string>();
  readonly teams = null;
  readonly bets: BetResult[] = [];
  readonly endedEarly = false;
  pile: Card[] = [];
  places: string[] = [];
  /** the Mantri while guessing, else null (everyone opens at once) */
  turnId: string | null = null;
  over = false;
  aborted = false;
  closed = false;
  readonly rounds: number;
  readonly bots: Set<string>;
  round = 0;
  phase: RmcsPhase = 'open';
  roles = new Map<string, RmcsRole>();
  opened = new Set<string>();
  endsAt: number | null = null;
  readonly scores = new Map<string, number>();
  readonly history: RmcsRound[] = [];
  /** goes up with every step: drivers key their timers on it */
  stepSeq = 0;
  /** when each bot (or walked-out seat) opens its chit this round, and when a bot Mantri points */
  readonly botOpenAt = new Map<string, number>();
  botGuessAt: number | null = null;
  /** the first deal, read out when the game starts */
  readonly opening: GameEvent[];

  constructor(
    readonly order: string[],
    readonly config: GameConfig,
    private readonly rand: RandomInt = secureRandom,
    botIds: string[] = [],
    readonly now: () => number = Date.now,
    private readonly jitter: () => number = Math.random,
  ) {
    if (order.length !== RMCS_ROLES.length) throw new GameError('Raja Mantri Chor Sipahi needs exactly 4 players. Add bots to fill the table');
    this.rounds = gameOpt<number>(config, 'rounds');
    this.bots = new Set(botIds);
    for (const id of order) {
      this.stats.set(id, emptyStats());
      this.scores.set(id, 0);
    }
    this.opening = this.deal();
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

  /** plays by itself: a bot, or a seat whose player walked out or was removed */
  autoSeat(id: string): boolean {
    return this.bots.has(id) || this.isOut(id);
  }

  holderOf(role: RmcsRole): string {
    return [...this.roles].find(([, r]) => r === role)![0];
  }

  private tallyOf(id: string): RmcsTally {
    return this.stats.get(id)!.tallies as RmcsTally;
  }

  /** a new round: the four chits shuffled out, everyone opens theirs */
  private deal(): GameEvent[] {
    this.round++;
    const roles = shuffle([...RMCS_ROLES], this.rand);
    this.roles = new Map(this.order.map((id, i) => [id, roles[i]]));
    this.opened.clear();
    this.phase = 'open';
    this.turnId = null;
    const now = this.now();
    this.endsAt = now + RMCS_OPEN_SEC * 1000;
    this.botOpenAt.clear();
    for (const id of this.order) {
      if (this.isOut(id)) this.botOpenAt.set(id, now + OUT_PAUSE);
      else if (this.bots.has(id)) this.botOpenAt.set(id, now + BOT_OPEN[0] + this.jitter() * BOT_OPEN[1]);
    }
    this.botGuessAt = null;
    this.stepSeq++;
    return [ev({ type: 'deal', round: this.round, rounds: this.rounds })];
  }

  private check(id: string): void {
    if (this.over) throw new GameError('The game is over');
    if (!this.order.includes(id)) throw new GameError("You're not playing this game");
  }

  /** open my chit; once all four are open the Mantri starts guessing */
  open(id: string, auto = false): GameEvent[] {
    this.check(id);
    if (this.phase !== 'open' || this.opened.has(id)) throw new GameError('Your chit is already open');
    this.opened.add(id);
    this.stepSeq++;
    const events = [ev({ type: 'open', playerId: id, raja: this.roles.get(id) === 'raja', auto })];
    if (this.opened.size === this.order.length) events.push(...this.startGuess());
    return events;
  }

  /** time to open ran out: every chit still shut opens by itself */
  openAll(): GameEvent[] {
    if (this.over || this.phase !== 'open') return [];
    return this.order.filter((id) => !this.opened.has(id)).flatMap((id) => (this.phase === 'open' ? this.open(id, true) : []));
  }

  private startGuess(): GameEvent[] {
    this.phase = 'guess';
    const mantri = this.holderOf('mantri');
    this.turnId = mantri;
    const now = this.now();
    this.endsAt = now + RMCS_GUESS_MS;
    this.botGuessAt = this.isOut(mantri) ? now + OUT_PAUSE : this.bots.has(mantri) ? now + BOT_GUESS[0] + this.jitter() * BOT_GUESS[1] : null;
    this.stepSeq++;
    return [ev({ type: 'guessing', mantriId: mantri })];
  }

  /** the two players the Mantri may point at */
  suspects(): string[] {
    return this.order.filter((id) => this.roles.get(id) === 'chor' || this.roles.get(id) === 'sipahi');
  }

  /** the Mantri points at who they think is the Chor */
  guess(id: string, target: string): GameEvent[] {
    this.check(id);
    if (this.phase === 'open') throw new GameError('Wait for everyone to open their chit');
    if (this.phase !== 'guess') throw new GameError('This round is over');
    if (this.turnId !== id) throw new GameError('Only the Mantri finds the Chor');
    if (!this.suspects().includes(target)) throw new GameError('Pick one of the two players left');
    return this.resolve(target);
  }

  /** the Mantri ran out of time: counts as a wrong guess */
  guessTimeUp(): GameEvent[] {
    if (this.over || this.phase !== 'guess') return [];
    return this.resolve(null);
  }

  /** every chit shown and the round's points added (a wrong guess swaps the Mantri's and the Chor's) */
  private resolve(target: string | null): GameEvent[] {
    const mantri = this.holderOf('mantri');
    const chor = this.holderOf('chor');
    const correct = target === chor;
    const points: Record<string, number> = {};
    for (const [id, role] of this.roles) points[id] = RMCS_POINTS[role];
    if (!correct) [points[mantri], points[chor]] = [points[chor], points[mantri]];
    for (const id of this.order) this.scores.set(id, (this.scores.get(id) ?? 0) + points[id]);
    this.tallyOf(this.holderOf('raja')).raja++;
    if (correct) this.tallyOf(mantri).caught++;
    else this.tallyOf(chor).escaped++;
    this.history.push({ round: this.round, roles: Object.fromEntries(this.roles), guess: target, correct, points });
    this.phase = 'result';
    this.turnId = null;
    this.endsAt = this.now() + RMCS_RESULT_MS;
    this.botGuessAt = null;
    this.stepSeq++;
    return [ev({ type: 'result', round: this.round, mantriId: mantri, chorId: chor, guess: target, correct })];
  }

  /** after the result: the next round, or the end after the last one */
  next(): GameEvent[] {
    if (this.over || this.phase !== 'result') return [];
    if (this.round >= this.rounds) return this.end();
    return this.deal();
  }

  private end(): GameEvent[] {
    this.over = true;
    this.turnId = null;
    this.endsAt = null;
    this.stepSeq++;
    return [{ kind: 'gameOver', loserId: null }];
  }

  /** a player walks out: they lose and still pay; their chit plays by itself from now on */
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

  /** no person is left playing: stopped, nobody wins */
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
      if (kicked || still.length === 0) this.aborted = true;
      return this.end();
    }
    // their chit opens (or their guess is made) by itself shortly
    const now = this.now();
    if (this.phase === 'open' && !this.opened.has(id)) this.botOpenAt.set(id, now + OUT_PAUSE);
    if (this.phase === 'guess' && this.turnId === id) this.botGuessAt = now + OUT_PAUSE;
    return [];
  }

  private still(): string[] {
    return this.order.filter((id) => !this.isOut(id));
  }

  /** the top score among those still seated, ties share; nobody if the game was stopped */
  winners(): string[] {
    if (this.aborted || !this.over) return [];
    const still = this.still();
    if (this.closed || still.length === 0) return [];
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

  /** once over: by total score, ties share the place */
  placeOf(id: string): number | null {
    if (!this.over || this.aborted || this.closed) return null;
    return standingsOf([], this.still(), (p) => -(this.scores.get(p) ?? 0)).get(id) ?? null;
  }

  /** chits everyone may see: the Raja once opened, the Mantri from guessing on, all at the result */
  private shown(): Record<string, RmcsRole> {
    const out: Record<string, RmcsRole> = {};
    for (const [id, role] of this.roles) {
      const show = this.phase === 'result' || (role === 'raja' && this.opened.has(id)) || (role === 'mantri' && this.phase === 'guess');
      if (show) out[id] = role;
    }
    return out;
  }

  /** the table as one member sees it: a seated player gets only their own chit until it's shown */
  view(meId: string, seated: boolean): RmcsView {
    const mine = seated && this.order.includes(meId) ? (this.roles.get(meId) ?? null) : null;
    return {
      round: this.round,
      rounds: this.rounds,
      phase: this.phase,
      myRole: mine,
      shown: this.shown(),
      opened: this.order.filter((id) => this.opened.has(id)),
      endsAt: this.over ? null : this.endsAt,
      scores: Object.fromEntries(this.order.map((id) => [id, this.scores.get(id) ?? 0])),
      history: this.history.map((h) => ({ ...h, roles: { ...h.roles }, points: { ...h.points } })),
    };
  }
}
