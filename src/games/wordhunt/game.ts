import { secureRandom, type RandomInt } from '../../cards.js';
import { GameError } from '../../game.js';
import type { BetResult, GameEvent, PlayerStats, TableGame, WordHuntEvent } from '../../models.js';
import { standingsOf } from '../../standings.js';
import {
  gameOpt, WORDHUNT_COUNTDOWN_MS, WORDHUNT_LONG, WORDHUNT_RATE, WORDHUNT_REVEAL_MS, WORDHUNT_ROUNDS, wordHuntMinLen, wordHuntPoints, wordHuntTouches,
  wordHuntWordOf, type BotLevel, type Card, type GameConfig, type WordHuntReveal, type WordHuntTry, type WordHuntVerdict, type WordHuntView,
} from '../../types.js';
import { botGap, botWords } from './brain.js';
import { dictionary, isWord, type Dict } from './dictionary.js';
import { makeGrid, type Solved } from './grid.js';

/** Word Grid Hunt's per-account counters (stats.perGame.wordhunt) */
export type WordHuntTally = { words: number; uniqueWords: number; longWords: number };

const emptyStats = (): PlayerStats & { tallies: WordHuntTally } => ({
  bluffs: 0, caught: 0, goodCalls: 0, wrongCalls: 0, pickedUp: 0, plays: 0, chances: 0,
  tallies: { words: 0, uniqueWords: 0, longWords: 0 },
});

const ev = (e: WordHuntEvent): GameEvent => ({ kind: 'wordhunt', ev: e });

interface Found {
  word: string;
  points: number;
  at: number;
}

/** Word Grid Hunt: everyone traces words in the same grid at once; 3 rounds; a word only you found scores double */
export class WordHuntGame implements TableGame<Card> {
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
  readonly size: 4 | 5;
  readonly minLen: number;
  readonly timeMs: number;
  readonly rounds = WORDHUNT_ROUNDS;
  readonly dict: Dict;
  phase: WordHuntView['phase'] = 'countdown';
  round = 1;
  startsAt: number;
  endsAt: number;
  nextAt: number | null = null;
  grid: string[] = [];
  /** every word in this round's grid (server only) */
  solved = new Map<string, Solved>();
  /** this round's words per player */
  found = new Map<string, Found[]>();
  readonly tries = new Map<string, WordHuntTry>();
  readonly scores = new Map<string, number>();
  reveal: WordHuntReveal | null = null;
  /** each bot's words still to find this round and when the next one comes */
  readonly botPlans = new Map<string, { words: string[]; at: number }>();
  private readonly sent = new Map<string, number[]>();
  stepSeq = 0;

  constructor(
    readonly order: string[],
    readonly config: GameConfig,
    private readonly rand: RandomInt = secureRandom,
    botIds: string[] = [],
    readonly jitter: () => number = Math.random,
    readonly now: () => number = Date.now,
    dict?: Dict,
  ) {
    if (order.length < 2 || order.length > 4) throw new GameError('Word Grid Hunt needs 2 to 4 players');
    this.bots = new Set(botIds);
    this.size = gameOpt<number>(config, 'grid') === 5 ? 5 : 4;
    this.minLen = wordHuntMinLen(this.size);
    const t = gameOpt<number>(config, 'time');
    this.timeMs = ([90, 120, 180].includes(t) ? t : 120) * 1000;
    this.dict = dict ?? dictionary();
    for (const id of order) {
      this.stats.set(id, emptyStats());
      this.scores.set(id, 0);
    }
    this.startsAt = this.now() + WORDHUNT_COUNTDOWN_MS;
    this.endsAt = this.startsAt + this.timeMs;
    this.newGrid();
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
    return !this.over && this.order.includes(id) && !this.isOut(id);
  }

  private tallyOf(id: string): WordHuntTally {
    return this.stats.get(id)!.tallies as WordHuntTally;
  }

  // the round's grid, seeded by the server, held back until play starts
  private newGrid(): void {
    const g = makeGrid(this.dict, this.size, this.rand(2 ** 31));
    this.grid = g.grid;
    this.solved = g.words;
    this.found = new Map(this.order.map((id) => [id, []]));
  }

  /** the next timed step: play starts, a bot's word, the round ends, the next round's countdown */
  nextStep(): { at: number; run: () => GameEvent[] } | null {
    if (this.over) return null;
    if (this.phase === 'countdown') return { at: this.startsAt, run: () => this.startPlay() };
    if (this.phase === 'reveal') return this.nextAt === null ? null : { at: this.nextAt, run: () => this.nextRound() };
    let step: { at: number; run: () => GameEvent[] } = { at: this.endsAt, run: () => this.endRound() };
    for (const [id, plan] of this.botPlans) {
      if (plan.words.length > 0 && plan.at < step.at && this.inPlay(id)) step = { at: plan.at, run: () => this.botWord(id) };
    }
    return step;
  }

  private startPlay(): GameEvent[] {
    this.stepSeq++;
    this.phase = 'play';
    const now = this.now();
    for (const id of this.order) {
      if (!this.bots.has(id)) continue;
      const level = this.config.botLevel as BotLevel;
      this.botPlans.set(id, { words: botWords(this.solved, level, this.jitter), at: now + botGap(level, this.jitter) });
    }
    return [ev({ type: 'round', round: this.round })];
  }

  private botWord(id: string): GameEvent[] {
    const plan = this.botPlans.get(id);
    if (!plan || this.phase !== 'play') return [];
    const level = this.config.botLevel as BotLevel;
    plan.at = this.now() + botGap(level, this.jitter);
    const mine = new Set(this.found.get(id)!.map((f) => f.word));
    let word = plan.words.shift();
    while (word !== undefined && mine.has(word)) word = plan.words.shift();
    if (word === undefined) return [];
    return this.word(id, this.round, this.solved.get(word)!.path, false);
  }

  /** a traced word: the server spells it from the path and checks the tiles, the dictionary and the round (bots skip the rate limit) */
  word(id: string, round: number, path: number[], limited = true): GameEvent[] {
    if (this.over) throw new GameError('The game is over');
    if (!this.order.includes(id) || this.isOut(id)) throw new GameError("You're not playing this game");
    const now = this.now();
    if (limited) {
      const sent = (this.sent.get(id) ?? []).filter((t) => now - t < 1000);
      if (sent.length >= WORDHUNT_RATE) throw new GameError('Slow down a little');
      sent.push(now);
      this.sent.set(id, sent);
    }
    const ok = path.length > 0 && path.length <= this.size * this.size && path.every((i) => Number.isInteger(i) && i >= 0 && i < this.size * this.size);
    const tiles = ok && round === this.round && this.grid.length > 0 ? path : [];
    const word = wordHuntWordOf(this.grid, tiles);
    let verdict: WordHuntVerdict = 'ok';
    if (this.phase !== 'play' || round !== this.round || now > this.endsAt) verdict = 'late';
    else if (!ok || new Set(path).size !== path.length || path.some((t, k) => k > 0 && !wordHuntTouches(this.size, path[k - 1], t))) verdict = 'path';
    else if (word.length < this.minLen) verdict = 'short';
    else if (this.found.get(id)!.some((f) => f.word === word)) verdict = 'again';
    else if (!isWord(this.dict, word)) verdict = 'unknown';
    const points = verdict === 'ok' ? wordHuntPoints(word.length) : 0;
    this.tries.set(id, { seq: (this.tries.get(id)?.seq ?? 0) + 1, word: verdict === 'late' ? '' : word, path: [...tiles], verdict, points });
    if (verdict !== 'ok') return [];
    this.stepSeq++;
    this.found.get(id)!.push({ word, points, at: now });
    const t = this.tallyOf(id);
    t.words++;
    if (word.length >= WORDHUNT_LONG) t.longWords++;
    return [ev({ type: 'word', playerId: id, len: word.length })];
  }

  private endRound(): GameEvent[] {
    this.stepSeq++;
    this.botPlans.clear();
    const who = new Map<string, number>();
    for (const list of this.found.values()) for (const f of list) who.set(f.word, (who.get(f.word) ?? 0) + 1);
    const words: WordHuntReveal['words'] = {};
    const points: WordHuntReveal['points'] = {};
    let best: (WordHuntReveal['best'] & { at: number }) | null = null;
    for (const id of this.order) {
      const list = (this.found.get(id) ?? []).map((f) => {
        const unique = who.get(f.word) === 1;
        return { word: f.word, points: unique ? f.points * 2 : f.points, unique, at: f.at };
      });
      words[id] = list.map(({ word, points, unique }) => ({ word, points, unique }));
      points[id] = list.reduce((s, w) => s + w.points, 0);
      if (!this.isOut(id)) this.scores.set(id, this.scores.get(id)! + points[id]);
      this.tallyOf(id).uniqueWords += list.filter((w) => w.unique).length;
      for (const w of list) {
        if (!best || w.word.length > best.word.length || (w.word.length === best.word.length && (w.points > best.points || (w.points === best.points && w.at < best.at)))) {
          best = { playerId: id, word: w.word, points: w.points, at: w.at };
        }
      }
    }
    // the longest words nobody found, plain ones first (rare words only when nothing else is left)
    const missed = [...this.solved.entries()]
      .filter(([w]) => !who.has(w))
      .sort((a, b) => Number(a[1].tier > 4) - Number(b[1].tier > 4) || b[0].length - a[0].length || a[1].tier - b[1].tier || (a[0] < b[0] ? -1 : 1))
      .slice(0, 5)
      .map(([w]) => w);
    this.reveal = { round: this.round, grid: [...this.grid], words, points, best: best ? { playerId: best.playerId, word: best.word, points: best.points } : null, missed, total: this.solved.size };
    const events = [ev({ type: 'reveal', round: this.round, best: best ? { playerId: best.playerId, word: best.word } : null })];
    if (this.round >= this.rounds) return [...events, ...this.end()];
    this.phase = 'reveal';
    this.nextAt = this.now() + WORDHUNT_REVEAL_MS;
    return events;
  }

  private nextRound(): GameEvent[] {
    this.stepSeq++;
    this.round++;
    this.phase = 'countdown';
    this.nextAt = null;
    this.startsAt = this.now() + WORDHUNT_COUNTDOWN_MS;
    this.endsAt = this.startsAt + this.timeMs;
    this.tries.clear();
    this.newGrid();
    return [];
  }

  private end(): GameEvent[] {
    this.over = true;
    this.phase = 'over';
    this.nextAt = null;
    this.botPlans.clear();
    this.stepSeq++;
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
    this.botPlans.delete(id);
    const still = this.order.filter((p) => !this.isOut(p));
    if (still.length <= 1) {
      // a kick leaves no fair winner; a walk-out hands the game to whoever is left
      this.aborted = kicked || still.length === 0;
      return this.end();
    }
    return [];
  }

  /** the highest total among those still in; ties share */
  winners(): string[] {
    if (this.aborted || !this.over || this.closed) return [];
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

  /** once over: by total, equal totals share a place */
  placeOf(id: string): number | null {
    if (!this.over || this.aborted) return null;
    return standingsOf([], this.order.filter((p) => !this.isOut(p)), (p) => -this.scores.get(p)!).get(id) ?? null;
  }

  /** what one member sees: their own words only (watchers: counts only) until the reveal */
  view(meId: string, seated: boolean): WordHuntView {
    const me = seated && this.order.includes(meId) ? meId : null;
    const places: Record<string, number> = {};
    if (this.over) for (const id of this.order) {
      const p = this.placeOf(id);
      if (p !== null) places[id] = p;
    }
    const lastTry = me ? this.tries.get(me) : undefined;
    return {
      size: this.size,
      minLen: this.minLen,
      time: this.timeMs / 1000,
      grid: this.phase === 'countdown' ? [] : [...this.grid],
      round: this.round,
      rounds: this.rounds,
      phase: this.phase,
      startsAt: this.startsAt,
      endsAt: this.endsAt,
      nextAt: this.nextAt,
      mine: me && this.phase === 'play' ? this.found.get(me)!.map((f) => ({ word: f.word, points: f.points })) : [],
      lastTry: lastTry ? { ...lastTry, path: [...lastTry.path] } : null,
      counts: Object.fromEntries(this.order.map((id) => [id, this.found.get(id)?.length ?? 0])),
      reveal: this.reveal && this.phase !== 'play' && this.phase !== 'countdown' ? structuredClone(this.reveal) : null,
      scores: Object.fromEntries(this.order.map((id) => [id, this.scores.get(id)!])),
      places,
      now: this.now(),
    };
  }
}
