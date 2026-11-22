import { secureRandom, shuffle, type RandomInt } from '../cards.js';
import { lastPlaced, standingsOf } from '../standings.js';
import { GameError } from '../game.js';
import type { BetResult, GameEvent, PlayerStats, TableGame } from '../models.js';
import {
  RANG_COLORS,
  RANG_HAND_SIZE,
  RANG_HAND_SIZES,
  RANG_MAX_PICKS,
  RANG_MISSED_PENALTIES,
  RANG_MISSED_PENALTY,
  RANG_VALUES,
  rangHandPoints,
  type GameConfig,
  type RangCard,
  type RangColor,
  type RangMove,
  type RangValue,
} from '../types.js';

/** everything needed to copy a game; bots simulate from copies */
export interface RangState {
  order: string[];
  config: GameConfig;
  hands: Map<string, RangCard[]>;
  deck: RangCard[];
  pile: RangCard[];
  turnId: string | null;
  penalty: number;
  picks: number;
  picked: string[];
  called: Set<string>;
  missed: Set<string>;
  atRisk: string | null;
  over: boolean;
  places: string[];
  color: RangColor | null;
  dir: 1 | -1;
  topBy: string | null;
  /** the +4 on top that may still be challenged: who played it and whether they held the colour in play */
  /** the unstacked +4 on top that may still be challenged, and who played the card under it (a caught +4 goes back; its colour stays) */
  challengeable: { by: string; guilty: boolean; color?: RangColor | null; topBy?: string | null } | null;
}

const NUMBERS: RangValue[] = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
const COPIED: RangValue[] = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'skip', 'reverse', 'draw2'];
const VALUE_WORD: Partial<Record<RangValue, string>> = { skip: 'Skip', reverse: 'Reverse', draw2: '+2', wild: 'Wild', wild4: '+4' };

/** one deck of 108: per colour one 0 and two each of 1–9, skip, reverse, draw2; 4 wild and 4 wild4 */
export function buildRangDeck(): RangCard[] {
  const cards: RangCard[] = [];
  for (const color of RANG_COLORS) {
    cards.push({ id: `rg-${color}-0-1`, color, value: '0' });
    for (const value of COPIED) for (let d = 1; d <= 2; d++) cards.push({ id: `rg-${color}-${value}-${d}`, color, value });
  }
  for (const value of ['wild', 'wild4'] as const) for (let d = 1; d <= 4; d++) cards.push({ id: `rg-w-${value}-${d}`, color: null, value });
  return cards;
}

export const isWild = (c: RangCard): boolean => c.value === 'wild' || c.value === 'wild4';

const colorIndex = (c: RangCard) => (c.color ? RANG_COLORS.indexOf(c.color) : RANG_COLORS.length);

// by colour, then value; wilds last
const byColor = (cards: RangCard[]) =>
  cards.sort((a, b) => colorIndex(a) - colorIndex(b) || RANG_VALUES.indexOf(a.value) - RANG_VALUES.indexOf(b.value));

const emptyStats = (): PlayerStats => ({
  bluffs: 0,
  caught: 0,
  goodCalls: 0,
  wrongCalls: 0,
  pickedUp: 0,
  plays: 0,
  chances: 0,
  missedCalls: 0,
  picks: 0,
  stacks: 0,
  lastCalls: 0,
});

/** Rang rules: match the colour or the value; action cards skip, reverse and make the next player pick; first one out wins */
export class RangGame implements TableGame<RangCard> {
  readonly hands = new Map<string, RangCard[]>();
  readonly stats = new Map<string, PlayerStats>();
  readonly kicked = new Set<string>();
  readonly forfeited = new Set<string>();
  /** 2v2 with 4 players: partners sit 1st & 3rd, 2nd & 4th; null otherwise */
  readonly teams: [string[], string[]] | null;
  /** 2v2: the team that won without anyone finishing (a walk-out on the other side) */
  private winningTeam: string[] | null = null;
  readonly bets: BetResult[] = [];
  readonly endedEarly = false;
  /** face down; cards are picked from the end */
  deck: RangCard[] = [];
  /** face up; the top card is the last one */
  pile: RangCard[] = [];
  places: string[] = [];
  turnId: string | null = null;
  over = false;
  /** stopped by kicks before anyone finished: no winner, no coins */
  aborted = false;
  /** ended because no person was left playing */
  closed = false;
  /** cards the player on turn must pick because of +2 / +4 */
  penalty = 0;
  /** cards the player on turn picked this turn, and which */
  picks = 0;
  picked: string[] = [];
  /** said "last card" */
  called = new Set<string>();
  /** forgot to say it: pick the missed penalty (config.rangMissed) and miss the next turn */
  missed = new Set<string>();
  /** down to one card without saying it; safe if they say it before someone else moves */
  atRisk: string | null = null;
  last: RangMove | null = null;
  moveSeq = 0;
  /** goes up each time a turn starts, so the app can cue a turn that comes straight back */
  turnSeq = 0;
  /** who put the top card down; null for the starting card */
  topBy: string | null = null;
  /** the colour to match: the top card's, or the one named with a wild */
  color: RangColor | null = null;
  /** 1 in seat order, -1 after a Reverse */
  dir: 1 | -1 = 1;
  /** the +4 on top that may still be challenged (not stacked on a chain) */
  challengeable: { by: string; guilty: boolean; color?: RangColor | null; topBy?: string | null } | null = null;
  /** ended because nobody could play and nothing was left to pick */
  stalled = false;
  /** the game time ran out: everyone is ranked by the points they still hold */
  timedOut = false;
  /** game time on: when it runs out (ms since 1970, set by the room); null with no limit */
  endsAt: number | null = null;
  /** turns in a row that passed by themselves without picking anything (a stuck table) */
  private idle = 0;
  /** cards the player on turn has picked this turn */
  private turnDrew = 0;
  /** automatic steps of the first turn (a pick when nothing matched) */
  readonly opening: GameEvent[] = [];

  constructor(
    readonly order: string[],
    readonly config: GameConfig,
    private readonly rand: RandomInt = secureRandom,
    deal = true,
    /** live games stop after every automatic step, so the room can play them at a pace people can follow */
    readonly stepwise = false,
  ) {
    if (order.length < 2 || order.length > 5) throw new GameError('Need 2 to 5 players');
    this.teams = config.teams && order.length === 4 ? [[order[0], order[2]], [order[1], order[3]]] : null;
    for (const id of order) {
      this.hands.set(id, []);
      this.stats.set(id, emptyStats());
    }
    if (!deal) return;
    this.deck = shuffle(buildRangDeck(), rand);
    for (let i = 0; i < this.handSize(); i++) for (const id of order) this.hand(id).push(this.deck.pop()!);
    for (const id of order) byColor(this.hand(id));
    // only a number card starts the pile; the rest go back into the deck
    let first = this.deck.pop()!;
    while (!NUMBERS.includes(first.value)) {
      this.deck.splice(rand(this.deck.length + 1), 0, first);
      first = this.deck.pop()!;
    }
    this.pile = [first];
    this.color = first.color;
    this.opening = this.startTurn(order[rand(order.length)]);
  }

  /** a copy for simulations */
  static fromState(s: RangState, rand: RandomInt = secureRandom, stepwise = false): RangGame {
    const g = new RangGame(s.order, s.config, rand, false, stepwise);
    for (const [id, cards] of s.hands) g.hands.set(id, [...cards]);
    g.deck = [...s.deck];
    g.pile = [...s.pile];
    g.turnId = s.turnId;
    g.penalty = s.penalty;
    g.picks = s.picks;
    g.picked = [...s.picked];
    g.called = new Set(s.called);
    g.missed = new Set(s.missed);
    g.atRisk = s.atRisk;
    g.over = s.over;
    g.places = [...s.places];
    g.color = s.color;
    g.dir = s.dir;
    g.topBy = s.topBy;
    g.challengeable = s.challengeable ? { ...s.challengeable } : null;
    return g;
  }

  state(): RangState {
    return {
      order: [...this.order],
      config: this.config,
      hands: new Map([...this.hands].map(([id, cards]) => [id, [...cards]])),
      deck: [...this.deck],
      pile: [...this.pile],
      turnId: this.turnId,
      penalty: this.penalty,
      picks: this.picks,
      picked: [...this.picked],
      called: new Set(this.called),
      missed: new Set(this.missed),
      atRisk: this.atRisk,
      over: this.over,
      places: [...this.places],
      color: this.color,
      dir: this.dir,
      topBy: this.topBy,
      challengeable: this.challengeable ? { ...this.challengeable } : null,
    };
  }

  hand(id: string): RangCard[] {
    const cards = this.hands.get(id);
    if (!cards) throw new GameError('You are not in this game');
    return cards;
  }

  top(): RangCard | null {
    return this.pile[this.pile.length - 1] ?? null;
  }
  /** the card may go on the pile now: same colour or value, a wild; with a penalty waiting only a +2/+4 answer (stacking on) */
  fits(card: RangCard): boolean {
    const top = this.top();
    if (this.penalty > 0) {
      if (!this.config.rangStack) return false;
      return top?.value === 'wild4' ? card.value === 'wild4' : card.value === 'draw2' || card.value === 'wild4';
    }
    if (isWild(card)) return true;
    if (!top) return true;
    return card.color === this.color || (!isWild(top) && card.value === top.value);
  }

  playable(id: string): RangCard[] {
    if (this.over || this.turnId !== id || this.autoDue) return [];
    return this.fitting(id);
  }

  private fitting(id: string): RangCard[] {
    return this.hand(id).filter((c) => this.fits(c));
  }

  /** live games: an automatic step is waiting for the player on turn (the room runs it after a short pause) */
  get autoDue(): boolean {
    if (!this.stepwise || this.over || !this.turnId) return false;
    const id = this.turnId;
    if (this.missed.has(id)) return true;
    if (this.penalty > 0) return !this.config.rangStack && !this.challengeOpen(id);
    const fits = this.fitting(id).length > 0;
    if (this.picks === 0) return !fits;
    return !fits && (this.picks >= this.maxPicks() || !this.canDraw());
  }

  /** live games: the next automatic step (a missed-call or penalty pick, a pick when nothing fits, a turn that passes by itself) */
  stepAuto(): GameEvent[] {
    if (!this.autoDue) return [];
    const id = this.turnId!;
    const events: GameEvent[] = [];
    if (this.missed.has(id)) return [...this.takeMissed(id), ...this.advance(id)];
    if (this.penalty > 0) return [...this.takePenalty(id, true), ...this.advance(id)];
    if (this.picks === 0) {
      const got = this.canDraw() ? this.draw(id, 1, events) : 0;
      this.picks = 1;
      events.push({ kind: 'rgpick', playerId: id, count: got, forced: true });
      this.move('pick', id, null, got);
      // force play: the picked card goes straight down
      const forced = this.forcedCard(id, got);
      if (forced) {
        const put = this.forcePlay(id, forced);
        return [...events, ...put.events, ...(put.next && !this.over ? this.startTurn(put.next) : [])];
      }
      return events;
    }
    events.push({ kind: 'rgpass', playerId: id, auto: true });
    this.move('pass', id, null, 0);
    // nobody can play and nothing is left to pick
    this.idle = this.turnDrew === 0 ? this.idle + 1 : 0;
    if (this.idle >= this.activeIds().length) return [...events, ...this.stall()];
    return [...events, ...this.advance(id)];
  }

  /** cards dealt to each player (config.rangHand) */
  handSize(): number {
    const n = this.config.rangHand;
    return (RANG_HAND_SIZES as readonly number[]).includes(n) ? n : RANG_HAND_SIZE;
  }

  /** cards picked for a missed "last card" (config.rangMissed) */
  missedPenalty(): number {
    const n = this.config.rangMissed;
    return (RANG_MISSED_PENALTIES as readonly number[]).includes(n) ? n : RANG_MISSED_PENALTY;
  }

  maxPicks(): number {
    return Math.min(RANG_MAX_PICKS, Math.max(1, Math.floor(this.config.rangPicks) || 1));
  }

  /** a card is left to pick, from the deck or by shuffling the pile back in */
  private canDraw(): boolean {
    return this.deck.length > 0 || this.pile.length > 1;
  }

  canPick(id: string): boolean {
    if (this.over || this.turnId !== id || this.autoDue) return false;
    return this.penalty > 0 || (this.picks < this.maxPicks() && this.canDraw());
  }

  /** Pass ends the turn after at least one pick (also when the picked card fits); never while a +2/+4 waits */
  canPass(id: string): boolean {
    // after any pick you may stop, even when the picked card fits
    return !this.over && this.turnId === id && !this.autoDue && this.penalty === 0 && this.picks > 0;
  }

  /** with one card left, or on your turn with two (said before playing the second-last) */
  canCall(id: string): boolean {
    if (this.over || this.called.has(id) || this.missed.has(id)) return false;
    const n = this.hands.get(id)?.length ?? 0;
    return n === 1 || (n === 2 && this.turnId === id);
  }

  /** hit by a single +4 (not one stacked on a chain), with challenges on */
  canChallenge(id: string): boolean {
    return this.challengeOpen(id) && !this.autoDue;
  }

  private challengeOpen(id: string): boolean {
    if (!this.config.rangChallenge || this.over || this.turnId !== id || this.missed.has(id)) return false;
    return this.penalty === 4 && this.top()?.value === 'wild4' && this.challengeable !== null && this.challengeable.by !== id;
  }

  /** color: named with a wild; targetId: who a 7 swaps with (7-0 on); extra: more cards of the same number put down with it (doubles) */
  play(id: string, cardId: string, opts: { color?: RangColor; targetId?: string; extra?: string[] } = {}): GameEvent[] {
    this.assertTurn(id);
    const hand = this.hand(id);
    const card = hand.find((c) => c.id === cardId);
    if (!card) throw new GameError('You do not have that card');
    const cards = [card, ...this.doubles(hand, card, opts.extra ?? [])];
    if (!this.fits(card)) throw new GameError(this.penaltyText() ?? this.matchText());
    if (isWild(card) && (!opts.color || !RANG_COLORS.includes(opts.color))) throw new GameError('Pick a colour');
    // a 7 that empties the hand just wins
    const swapping = this.config.rangSwap && card.value === '7' && hand.length > cards.length;
    const swapWith = swapping ? (opts.targetId ?? null) : null;
    if (swapping && (!swapWith || swapWith === id || !this.hands.has(swapWith) || this.hand(swapWith).length === 0)) throw new GameError('Pick a player to swap with');
    const events = this.closeWindow(id);
    const put = this.put(id, cards, opts.color ?? null, swapWith, false);
    return [...events, ...put.events, ...(put.next && !this.over ? this.startTurn(put.next) : [])];
  }

  /** the other cards of a doubles play: doubles on, on a top card of that same number, each card in the hand once, all number cards of that number */
  private doubles(hand: RangCard[], card: RangCard, extra: string[]): RangCard[] {
    if (extra.length === 0) return [];
    if (!this.config.rangDoubles) throw new GameError('Doubles are off in this room');
    if (new Set([card.id, ...extra]).size !== extra.length + 1) throw new GameError('Pick each card once');
    const more = extra.map((x) => hand.find((c) => c.id === x));
    if (more.some((c) => !c)) throw new GameError('You do not have that card');
    const all = [card, ...(more as RangCard[])];
    if (!all.every((c) => NUMBERS.includes(c.value) && c.value === card.value)) throw new GameError('Only number cards of the same number go together');
    // more than one card only on the same number: on a green 8, a green 4 goes alone, never with the other 4s
    const top = this.top();
    if (!top || isWild(top) || top.value !== card.value) throw new GameError('Put down more than one card only on the same number');
    return more as RangCard[];
  }

  /** puts checked cards down (the last ends on top); next: whose turn starts, null once the game is over */
  private put(id: string, cards: RangCard[], named: RangColor | null, swapWith: string | null, forced: boolean): { events: GameEvent[]; next: string | null } {
    const card = cards[0];
    const topCard = cards[cards.length - 1];
    const hand = this.hand(id);
    const s = this.stat(id);
    const stacked = this.penalty > 0;
    const wild = isWild(card);
    // a +4 played while holding the colour in play can be challenged
    const guilty = card.value === 'wild4' && hand.some((c) => c !== card && c.color !== null && c.color === this.color);
    // what the table was before this play, so a caught +4 can be undone
    const before = { color: this.color, topBy: this.topBy };
    this.hands.set(id, hand.filter((c) => !cards.includes(c)));
    this.pile.push(...cards);
    this.topBy = id;
    this.idle = 0;
    this.color = wild ? named! : topCard.color;
    this.challengeable = null;
    s.plays++;
    if (wild) s.wilds = (s.wilds ?? 0) + 1;
    if (card.value === 'draw2' || card.value === 'wild4') {
      if (stacked) s.stacks = (s.stacks ?? 0) + 1;
      this.penalty += card.value === 'draw2' ? 2 : 4;
      if (card.value === 'wild4' && !stacked) this.challengeable = { by: id, guilty, color: before.color, topBy: before.topBy };
    }
    const play: Extract<GameEvent, { kind: 'rgplay' }> = { kind: 'rgplay', playerId: id, card: topCard, color: this.color, penalty: this.penalty };
    const all = { ...(cards.length > 1 && { cards: [...cards] }), ...(forced && { forced: true }) };
    if (cards.length > 1) play.cards = [...cards];
    if (forced) play.forced = true;
    const shown = wild ? this.color : null;
    if (this.hand(id).length === 0) {
      this.move('play', id, topCard, 0, { color: shown, ...all });
      this.places.push(id);
      this.finishGame();
      return { events: [play, { kind: 'finish', playerId: id, place: 1 }, { kind: 'gameOver', loserId: null }], next: null };
    }
    let next = this.nextActive(id);
    if (card.value === 'skip' && next) {
      play.skipped = next;
      next = this.nextActive(next);
    } else if (card.value === 'reverse') {
      this.dir = this.dir === 1 ? -1 : 1;
      play.reversed = true;
      // two players left: a Reverse acts as a Skip
      if (this.activeIds().length === 2) {
        play.skipped = this.nextActive(id);
        next = id;
      } else next = this.nextActive(id);
    }
    if (swapWith) {
      const mine = this.hand(id);
      this.hands.set(id, this.hand(swapWith));
      this.hands.set(swapWith, mine);
      this.unmark([id, swapWith]);
      play.targetId = swapWith;
    } else if (this.config.rangSwap && card.value === '0') {
      this.rotate();
      play.rotated = true;
    } else {
      const left = this.hand(id).length;
      if (left === 1 && !this.called.has(id)) this.atRisk = id;
      if (left > 1) this.called.delete(id);
    }
    this.move('play', id, topCard, 0, { color: shown, targetId: play.skipped ?? swapWith, ...all });
    return { events: [play], next };
  }

  /** force play: the card just picked, if it fits (never after a +2/+4 pick) */
  private forcedCard(id: string, got: number): RangCard | null {
    if (!this.config.rangForce || got === 0 || this.penalty > 0 || this.missed.has(id)) return null;
    const lastId = this.picked[this.picked.length - 1];
    const card = this.hand(id).find((c) => c.id === lastId);
    return card && this.fits(card) ? card : null;
  }

  /** plays the picked card for them: a wild names the colour held most, a 7 swaps with the opponent with the fewest cards */
  private forcePlay(id: string, card: RangCard): { events: GameEvent[]; next: string | null } {
    const hand = this.hand(id);
    const color = isWild(card) ? this.colorHeldMost(hand, card) : null;
    const swapWith = this.config.rangSwap && card.value === '7' && hand.length > 1 ? this.fewestFrom(id) : null;
    // automatic, like the pick before it: nobody is caught by it
    return this.put(id, [card], color, swapWith, true);
  }

  /** the colour most held besides the card played (ties: first in RANG_COLORS); none: the colour in play */
  private colorHeldMost(hand: RangCard[], skip: RangCard): RangColor {
    let best: RangColor | null = null;
    let most = 0;
    for (const col of RANG_COLORS) {
      const n = hand.filter((c) => c !== skip && c.color === col).length;
      if (n > most) [best, most] = [col, n];
    }
    return best ?? this.color ?? RANG_COLORS[0];
  }

  /** the opponent with the fewest cards (ties: the next in turn order); 2v2 never picks the partner */
  private fewestFrom(id: string): string | null {
    const partner = this.partnerOf(id);
    let best: string | null = null;
    const n = this.order.length;
    const start = this.order.indexOf(id);
    for (let step = 1; step < n; step++) {
      const p = this.order[(((start + step * this.dir) % n) + n) % n];
      if (p === partner || this.hand(p).length === 0) continue;
      if (!best || this.hand(p).length < this.hand(best).length) best = p;
    }
    return best;
  }
  /** takes the waiting penalty; otherwise picks one card (up to the room's limit per turn) */
  pick(id: string): GameEvent[] {
    this.assertTurn(id);
    if (this.penalty > 0) {
      const events = this.closeWindow(id);
      events.push(...this.takePenalty(id, false));
      return [...events, ...this.advance(id)];
    }
    if (this.picks >= this.maxPicks()) throw new GameError(`You picked ${this.picks} this turn. Play a card or pass`);
    if (!this.canDraw()) throw new GameError('No cards left to pick. Play a card or pass');
    const events = this.closeWindow(id);
    const got = this.draw(id, 1, events);
    this.picks++;
    events.push({ kind: 'rgpick', playerId: id, count: got, forced: false });
    this.move('pick', id, null, got);
    const forced = this.forcedCard(id, got);
    if (forced) {
      const put = this.forcePlay(id, forced);
      return [...events, ...put.events, ...(put.next && !this.over ? this.startTurn(put.next) : [])];
    }
    // live games pass a moment later instead (stepAuto)
    if (!this.stepwise && (this.picks >= this.maxPicks() || !this.canDraw()) && this.playable(id).length === 0) return [...events, ...this.autoPass(id)];
    return events;
  }

  /** ends the turn; only after picking at least once */
  pass(id: string): GameEvent[] {
    this.assertTurn(id);
    const blocked = this.penaltyText();
    if (blocked) throw new GameError(blocked);
    if (this.picks === 0) throw new GameError('Pick a card first, or play one');
    if (!this.canPass(id)) throw new GameError(`You picked ${this.picks}. Play a card that fits`);
    const events = this.closeWindow(id);
    events.push({ kind: 'rgpass', playerId: id, auto: false });
    this.move('pass', id, null, 0);
    return [...events, ...this.advance(id)];
  }

  /** "last card!" */
  call(id: string): GameEvent[] {
    if (!this.canCall(id)) {
      if (this.missed.has(id)) throw new GameError('Too late, you were caught');
      throw new GameError(this.called.has(id) ? 'You already said it' : 'Say it when you are down to your last card');
    }
    this.called.add(id);
    if (this.atRisk === id) this.atRisk = null;
    const s = this.stat(id);
    s.lastCalls = (s.lastCalls ?? 0) + 1;
    this.move('call', id, null, 0);
    return [{ kind: 'rgcall', playerId: id }];
  }

  /** challenges the +4: guilty, its player picks 4 and the challenger plays on; fair, the challenger picks 6 and loses the turn */
  challenge(id: string): GameEvent[] {
    this.assertTurn(id);
    if (!this.canChallenge(id)) throw new GameError('Only a +4 played on you can be challenged');
    const { by, guilty, topBy } = this.challengeable!;
    const events = this.closeWindow(id);
    this.challengeable = null;
    this.penalty = 0;
    if (guilty) {
      // caught: the +4 goes back to its player, who also picks 4; the colour they named stays in play
      const four = this.pile.pop()!;
      this.hand(by).push(four);
      byColor(this.hand(by));
      this.topBy = topBy ?? null;
      const s = this.stat(by);
      s.wilds = Math.max(0, (s.wilds ?? 0) - 1);
    }
    const got = this.draw(guilty ? by : id, guilty ? 4 : 6, events);
    events.push({ kind: 'rgchallenge', playerId: id, targetId: by, guilty, count: got });
    this.move('challenge', id, null, got, { targetId: by, guilty });
    return [...events, ...(guilty ? this.startTurn(id, false) : this.advance(id))];
  }

  /** a player walks out: they lose and still pay; their cards go under the deck */
  leave(id: string): GameEvent[] {
    if (this.over || this.hand(id).length === 0 || this.kicked.has(id) || this.forfeited.has(id)) return [];
    this.forfeited.add(id);
    return this.teams ? this.teamOut(id, false) : this.drop(id, false);
  }

  /** the host removed a player: they pay and win nothing */
  removePlayer(id: string): GameEvent[] {
    if (this.over || this.kicked.has(id)) return [];
    this.hand(id);
    this.kicked.add(id);
    return this.teams ? this.teamOut(id, true) : this.drop(id, true);
  }

  /** no person is left playing: nobody wins (2v2: the team of anyone who finished, else stopped) */
  close(): GameEvent[] {
    if (this.over) return [];
    this.closed = true;
    if (this.teams && this.places.length === 0) this.aborted = true;
    this.finishGame();
    return [{ kind: 'gameOver', loserId: null }];
  }

  /** the first one out, or both partners of their team */
  winners(): string[] {
    if (this.aborted || !this.over) return [];
    if (this.timedOut) return this.timeWinners();
    if (this.teams) return [...((this.places[0] ? this.teamOf(this.places[0]) : this.winningTeam) ?? [])];
    return this.places.slice(0, 1);
  }

  handValueOf(id: string): number {
    return rangHandPoints(this.hand(id));
  }

  /** once over: the winner, then everyone still in by fewest points left; walk-outs and removed players get none */
  placeOf(id: string): number | null {
    if (this.teams) return this.winners().includes(id) ? 1 : null;
    return this.standings().get(id) ?? null;
  }

  private standings(): Map<string, number> {
    if (!this.over || this.aborted) return standingsOf(this.places, [], () => 0);
    const still = this.order.filter((id) => !this.kicked.has(id) && !this.forfeited.has(id));
    return standingsOf(this.places, still, (id) => rangHandPoints(this.hand(id)));
  }

  /** time up: the fewest points win, equal points share it; 2v2: the team with fewer points between them (both on a tie) */
  private timeWinners(): string[] {
    const still = this.order.filter((id) => !this.kicked.has(id) && !this.forfeited.has(id));
    if (this.teams) {
      const total = (team: string[]) => team.filter((id) => still.includes(id)).reduce((n, id) => n + rangHandPoints(this.hand(id)), 0);
      const [a, b] = this.teams.map(total);
      return a === b ? [...this.teams[0], ...this.teams[1]] : [...this.teams[a < b ? 0 : 1]];
    }
    const best = Math.min(...still.map((id) => rangHandPoints(this.hand(id))));
    return still.filter((id) => rangHandPoints(this.hand(id)) === best);
  }

  /** the game time ran out before anyone went out: the game ends and everyone is ranked by points held */
  timeUp(): GameEvent[] {
    if (this.over) return [];
    this.timedOut = true;
    this.finishGame();
    return [{ kind: 'gameOver', loserId: null }];
  }

  /** the last place (most points left) plus anyone who walked out */
  losers(): string[] {
    if (this.aborted) return [];
    if (this.timedOut) {
      // everyone tied shares first: nobody loses
      const won = this.winners();
      if (this.teams) return this.order.filter((id) => !won.includes(id) && !this.kicked.has(id));
      return [...this.forfeited, ...lastPlaced(this.standings(), this.places).filter((id) => !won.includes(id))];
    }
    if (this.teams) {
      const won = this.winners();
      return won.length === 0 ? [] : this.order.filter((id) => !won.includes(id) && !this.kicked.has(id));
    }
    if (this.closed) return [...this.forfeited, ...lastPlaced(this.standings(), this.places)];
    return this.winners().length === 0 ? [] : [...this.forfeited, ...lastPlaced(this.standings(), this.places)];
  }

  teamOf(id: string): string[] | null {
    return this.teams?.find((t) => t.includes(id)) ?? null;
  }

  partnerOf(id: string): string | null {
    return this.teamOf(id)?.find((p) => p !== id) ?? null;
  }

  /** 2v2: anyone leaving ends the game; a kick stops it, a walk-out hands it to the other team */
  private teamOut(id: string, kicked: boolean): GameEvent[] {
    this.deck.unshift(...this.hand(id));
    this.hands.set(id, []);
    this.called.delete(id);
    this.missed.delete(id);
    if (kicked) this.aborted = true;
    else this.winningTeam = this.teams!.find((t) => !t.includes(id)) ?? null;
    this.finishGame();
    return [{ kind: 'gameOver', loserId: null }];
  }

  private drop(id: string, kicked: boolean): GameEvent[] {
    this.deck.unshift(...this.hand(id));
    this.hands.set(id, []);
    this.called.delete(id);
    this.missed.delete(id);
    if (this.atRisk === id) this.atRisk = null;
    // their +4 can no longer be challenged
    if (this.challengeable?.by === id) this.challengeable = null;
    const left = this.activeIds();
    if (left.length <= 1) {
      // a kick leaves no fair winner; a walk-out hands the game to whoever is left
      if (kicked || !left[0]) {
        this.aborted = kicked;
        this.finishGame();
        return [{ kind: 'gameOver', loserId: null }];
      }
      this.places.push(left[0]);
      this.finishGame();
      return [{ kind: 'finish', playerId: left[0], place: 1 }, { kind: 'gameOver', loserId: null }];
    }
    if (this.turnId !== id) return [];
    // a +2/+4 aimed at them is gone with them
    this.penalty = 0;
    this.challengeable = null;
    return this.startTurn(this.nextActive(id));
  }

  private advance(fromId: string): GameEvent[] {
    return this.startTurn(this.nextActive(fromId));
  }

  /** runs everything automatic at the start of a turn, until someone has a choice to make; fresh false: the same turn goes on */
  private startTurn(first: string | null, fresh = true): GameEvent[] {
    // live games: just hand over the turn; anything automatic comes one step at a time from stepAuto
    if (this.stepwise) {
      if (first && !this.over && fresh) {
        this.turnId = first;
        this.turnSeq++;
        this.picks = 0;
        this.picked = [];
        this.turnDrew = 0;
      }
      return [];
    }
    const events: GameEvent[] = [];
    let id = first;
    let idle = 0;
    // force play can cycle the same few cards round a tiny table: past this many in one go the player picks by hand
    let forcedLeft = 4 * this.order.length;
    while (id && !this.over) {
      if (fresh) {
        this.turnId = id;
        this.turnSeq++;
        this.picks = 0;
        this.picked = [];
      }
      fresh = true;
      if (this.missed.has(id)) {
        events.push(...this.takeMissed(id));
        id = this.nextActive(id);
        continue;
      }
      if (this.penalty > 0) {
        // with stacking or a challenge everyone gets the choice, so a pause never shows who holds a +2/+4
        if (this.config.rangStack || this.challengeOpen(id)) break;
        events.push(...this.takePenalty(id, true));
        id = this.nextActive(id);
        continue;
      }
      if (this.playable(id).length > 0 || (this.config.rangForce && forcedLeft <= 0)) break;
      // nothing fits: one card is picked for them
      const got = this.canDraw() ? this.draw(id, 1, events) : 0;
      this.picks = 1;
      events.push({ kind: 'rgpick', playerId: id, count: got, forced: true });
      this.move('pick', id, null, got);
      const forced = this.forcedCard(id, got);
      if (forced) {
        const put = this.forcePlay(id, forced);
        events.push(...put.events);
        if (!put.next || this.over) break;
        idle = 0;
        forcedLeft--;
        id = put.next;
        continue;
      }
      if (this.playable(id).length > 0) break;
      if (got > 0 && this.picks < this.maxPicks() && this.canDraw()) break;
      events.push({ kind: 'rgpass', playerId: id, auto: true });
      this.move('pass', id, null, 0);
      // nobody can play and nothing is left to pick
      idle = got === 0 ? idle + 1 : 0;
      if (idle >= this.activeIds().length) {
        events.push(...this.stall());
        break;
      }
      id = this.nextActive(id);
    }
    return events;
  }
  /** forgot to say last card: picks the missed penalty (plus any waiting +2/+4) and misses the turn */
  private takeMissed(id: string): GameEvent[] {
    const events: GameEvent[] = [];
    this.missed.delete(id);
    const count = this.missedPenalty() + this.penalty;
    this.penalty = 0;
    this.challengeable = null;
    const got = this.draw(id, count, events);
    events.push({ kind: 'rgpenalty', playerId: id, count: got, missed: true, forced: true });
    this.move('penalty', id, null, got);
    return events;
  }

  private takePenalty(id: string, forced: boolean): GameEvent[] {
    const events: GameEvent[] = [];
    const count = this.penalty;
    this.penalty = 0;
    this.challengeable = null;
    const got = this.draw(id, count, events);
    events.push({ kind: 'rgpenalty', playerId: id, count: got, missed: false, forced });
    this.move('penalty', id, null, got);
    return events;
  }

  private autoPass(id: string): GameEvent[] {
    this.move('pass', id, null, 0);
    return [{ kind: 'rgpass', playerId: id, auto: true }, ...this.advance(id)];
  }

  /** a stuck table: fewest cards wins (fewest points breaks a tie) */
  private stall(): GameEvent[] {
    const active = this.activeIds();
    const best = active.reduce((a, b) => {
      const d = this.hand(b).length - this.hand(a).length;
      return d < 0 || (d === 0 && rangHandPoints(this.hand(b)) < rangHandPoints(this.hand(a))) ? b : a;
    });
    this.stalled = true;
    this.places.push(best);
    this.finishGame();
    return [{ kind: 'finish', playerId: best, place: 1 }, { kind: 'gameOver', loserId: null }];
  }

  /** 7-0: every hand still in play moves to the next such player in the direction of play */
  private rotate(): void {
    const active = this.activeIds();
    const moved = active.map((p) => [this.nextActive(p)!, this.hand(p)] as const);
    for (const [to, cards] of moved) this.hands.set(to, cards);
    this.unmark(active);
  }

  /** a swapped hand starts clean: nobody can be caught by a swap */
  private unmark(ids: string[]): void {
    for (const p of ids) {
      this.called.delete(p);
      if (this.atRisk === p) this.atRisk = null;
    }
  }

  /** someone else made a move: a player who still hasn't said "last card" is caught */
  private closeWindow(actor: string): GameEvent[] {
    const late = this.atRisk;
    return late && late !== actor ? this.markMissed(late) : [];
  }

  private markMissed(id: string): GameEvent[] {
    this.atRisk = null;
    this.missed.add(id);
    const s = this.stat(id);
    s.missedCalls = (s.missedCalls ?? 0) + 1;
    this.move('missed', id, null, 0);
    return [{ kind: 'rgmissed', playerId: id }];
  }

  /** picks up to n cards, shuffling the pile back in when the deck runs out */
  private draw(id: string, n: number, events: GameEvent[]): number {
    const hand = this.hand(id);
    let got = 0;
    for (let i = 0; i < n; i++) {
      if (this.deck.length === 0) this.reshuffle(events);
      const card = this.deck.pop();
      if (!card) break;
      hand.push(card);
      got++;
      if (this.turnId === id) {
        this.picked.push(card.id);
        this.turnDrew++;
      }
    }
    byColor(hand);
    const s = this.stat(id);
    s.picks = (s.picks ?? 0) + got;
    if (hand.length > 1) {
      this.called.delete(id);
      if (this.atRisk === id) this.atRisk = null;
    }
    return got;
  }

  private reshuffle(events: GameEvent[]): void {
    if (this.pile.length <= 1) return;
    const top = this.pile.pop()!;
    this.deck = shuffle(this.pile, this.rand);
    this.pile = [top];
    events.push({ kind: 'rgshuffle', count: this.deck.length });
    this.move('shuffle', null, null, this.deck.length);
  }

  private finishGame(): void {
    this.over = true;
    this.turnId = null;
    this.penalty = 0;
    this.atRisk = null;
    this.challengeable = null;
  }

  private activeIds(): string[] {
    return this.order.filter((p) => this.hand(p).length > 0);
  }

  /** the next player still holding cards, in the direction of play */
  private nextActive(fromId: string): string | null {
    const n = this.order.length;
    const start = this.order.indexOf(fromId);
    for (let step = 1; step < n; step++) {
      const id = this.order[(((start + step * this.dir) % n) + n) % n];
      if (this.hand(id).length > 0) return id;
    }
    return null;
  }

  private move(kind: RangMove['kind'], playerId: string | null, card: RangCard | null, count: number, extra: Partial<RangMove> = {}): void {
    this.last = { id: ++this.moveSeq, kind, playerId, card, count, ...extra };
  }

  private penaltyText(): string | null {
    if (this.penalty === 0) return null;
    if (!this.config.rangStack) return `Pick ${this.penalty} cards`;
    return this.top()?.value === 'wild4' ? `Play a +4 or pick ${this.penalty} cards` : `Play a +2 or +4, or pick ${this.penalty} cards`;
  }

  private matchText(): string {
    const top = this.top()!;
    const value = isWild(top) ? null : (VALUE_WORD[top.value] ?? top.value);
    return value ? `Play a ${this.color} card, a ${value} or a wild` : `Play a ${this.color} card or a wild`;
  }

  private stat(id: string): PlayerStats {
    const s = this.stats.get(id);
    if (!s) throw new GameError('You are not in this game');
    return s;
  }

  private assertTurn(id: string): void {
    if (this.over) throw new GameError('Game is over');
    if (this.turnId !== id) throw new GameError('Not your turn');
    if (this.autoDue) throw new GameError('One moment, picking for you');
  }


}
