import { buildDeck, secureRandom, shuffle, type RandomInt } from '../cards.js';
import { GameError } from '../game.js';
import type { BetResult, GameEvent, PlayerStats, TableGame } from '../models.js';
import { CRAZY7_MAX_PICKS, RANKS, SEVEN_PENALTY, type Card, type Crazy7Move, type GameConfig, type Suit } from '../types.js';

/** everything needed to copy a game; bots simulate from copies */
export interface Crazy7State {
  order: string[];
  config: GameConfig;
  hands: Map<string, Card[]>;
  deck: Card[];
  pile: Card[];
  turnId: string | null;
  penalty: number;
  picks: number;
  picked: string[];
  called: Set<string>;
  missed: Set<string>;
  atRisk: string | null;
  over: boolean;
  places: string[];
}

// red and black alternate, so matching suits are easy to spot in a hand
const SUIT_ORDER: Suit[] = ['S', 'H', 'C', 'D'];
const SUIT_WORD: Record<Suit, string> = { S: 'spade', H: 'heart', D: 'diamond', C: 'club' };

const bySuit = (cards: Card[]) =>
  cards.sort((a, b) => SUIT_ORDER.indexOf(a.suit) - SUIT_ORDER.indexOf(b.suit) || RANKS.indexOf(a.rank) - RANKS.indexOf(b.rank));

const emptyStats = (): PlayerStats => ({
  bluffs: 0,
  caught: 0,
  goodCalls: 0,
  wrongCalls: 0,
  pickedUp: 0,
  plays: 0,
  chances: 0,
  sevens: 0,
  missedCalls: 0,
  picks: 0,
});

/** Crazy 7 rules: match the top card's suit or number; a 7 makes the next player pick 2; first one out wins */
export class Crazy7Game implements TableGame {
  readonly hands = new Map<string, Card[]>();
  readonly stats = new Map<string, PlayerStats>();
  readonly kicked = new Set<string>();
  readonly forfeited = new Set<string>();
  readonly teams = null;
  readonly bets: BetResult[] = [];
  readonly endedEarly = false;
  /** face down; cards are picked from the end */
  deck: Card[] = [];
  /** face up; the top card is the last one */
  pile: Card[] = [];
  places: string[] = [];
  turnId: string | null = null;
  over = false;
  /** stopped by kicks before anyone finished: no winner, no coins */
  aborted = false;
  /** ended because no person was left playing */
  closed = false;
  /** cards the player on turn must pick because of 7s */
  penalty = 0;
  /** cards the player on turn picked this turn, and which */
  picks = 0;
  picked: string[] = [];
  /** said "last card" */
  called = new Set<string>();
  /** forgot to say it: pick 1 and miss the next turn */
  missed = new Set<string>();
  /** down to one card without saying it; safe if they say it before someone else moves */
  atRisk: string | null = null;
  last: Crazy7Move | null = null;
  moveSeq = 0;
  /** goes up each time a turn starts, so the app can cue a turn that comes straight back */
  turnSeq = 0;
  /** who put the top card down; null for the starting card */
  topBy: string | null = null;
  /** ended because nobody could play and nothing was left to pick */
  stalled = false;
  /** automatic steps of the first turn (a pick when nothing matched) */
  readonly opening: GameEvent[] = [];

  constructor(
    readonly order: string[],
    readonly config: GameConfig,
    private readonly rand: RandomInt = secureRandom,
    deal = true,
  ) {
    if (order.length < 2 || order.length > 5) throw new GameError('Need 2 to 5 players');
    for (const id of order) {
      this.hands.set(id, []);
      this.stats.set(id, emptyStats());
    }
    if (!deal) return;
    const size = config.handSize === 5 ? 5 : 7;
    this.deck = shuffle(buildDeck(config.decks), rand);
    for (let i = 0; i < size; i++) for (const id of order) this.hand(id).push(this.deck.pop()!);
    for (const id of order) bySuit(this.hand(id));
    // a 7 never starts the pile, so nobody is punished before anyone has played
    let first = this.deck.pop()!;
    while (first.rank === '7') {
      this.deck.splice(rand(this.deck.length + 1), 0, first);
      first = this.deck.pop()!;
    }
    this.pile = [first];
    this.opening = this.startTurn(order[rand(order.length)]);
  }

  /** a copy for simulations */
  static fromState(s: Crazy7State, rand: RandomInt = secureRandom): Crazy7Game {
    const g = new Crazy7Game(s.order, s.config, rand, false);
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
    return g;
  }

  state(): Crazy7State {
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
    };
  }

  hand(id: string): Card[] {
    const cards = this.hands.get(id);
    if (!cards) throw new GameError('You are not in this game');
    return cards;
  }

  top(): Card | null {
    return this.pile[this.pile.length - 1] ?? null;
  }

  /** the card may go on the pile now: same suit or number, or only a 7 while a penalty waits */
  fits(card: Card): boolean {
    if (this.penalty > 0) return this.config.stack7 && card.rank === '7';
    const top = this.top();
    return !top || card.suit === top.suit || card.rank === top.rank;
  }

  playable(id: string): Card[] {
    if (this.over || this.turnId !== id) return [];
    return this.hand(id).filter((c) => this.fits(c));
  }

  maxPicks(): number {
    return Math.min(CRAZY7_MAX_PICKS, Math.max(1, Math.floor(this.config.maxPicks) || 1));
  }

  /** a card is left to pick, from the deck or by shuffling the pile back in */
  private canDraw(): boolean {
    return this.deck.length > 0 || this.pile.length > 1;
  }

  canPick(id: string): boolean {
    if (this.over || this.turnId !== id) return false;
    return this.penalty > 0 || (this.picks < this.maxPicks() && this.canDraw());
  }

  /** Pass only stops picking early: after at least one pick, while more picks are still allowed. At the limit a card that fits must be played */
  canPass(id: string): boolean {
    return !this.over && this.turnId === id && this.penalty === 0 && this.picks > 0 && this.picks < this.maxPicks() && this.canDraw();
  }

  /** with one card left, or on your turn with two (said before playing the second-last, a stacked 7 too) */
  canCall(id: string): boolean {
    if (this.over || this.called.has(id) || this.missed.has(id)) return false;
    const n = this.hands.get(id)?.length ?? 0;
    return n === 1 || (n === 2 && this.turnId === id);
  }

  play(id: string, cardId: string): GameEvent[] {
    this.assertTurn(id);
    const hand = this.hand(id);
    const card = hand.find((c) => c.id === cardId);
    if (!card) throw new GameError('You do not have that card');
    if (!this.fits(card)) throw new GameError(this.penaltyText() ?? this.matchText());
    const events = this.closeWindow(id);
    this.hands.set(id, hand.filter((c) => c !== card));
    this.pile.push(card);
    this.topBy = id;
    if (card.rank === '7') {
      this.penalty += SEVEN_PENALTY;
      const s = this.stat(id);
      s.sevens = (s.sevens ?? 0) + 1;
    }
    this.move('play', id, card, 0);
    events.push({ kind: 'c7play', playerId: id, card, penalty: this.penalty });
    const left = this.hand(id).length;
    if (left === 0) {
      this.places.push(id);
      this.finishGame();
      return [...events, { kind: 'finish', playerId: id, place: 1 }, { kind: 'gameOver', loserId: null }];
    }
    if (left === 1 && !this.called.has(id)) this.atRisk = id;
    if (left > 1) this.called.delete(id);
    return [...events, ...this.advance(id)];
  }

  /** takes the 7 penalty when one waits; otherwise picks one card (up to the room's limit per turn) */
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
    events.push({ kind: 'c7pick', playerId: id, count: got, forced: false, top: this.top() });
    this.move('pick', id, null, got);
    if ((this.picks >= this.maxPicks() || !this.canDraw()) && this.playable(id).length === 0) return [...events, ...this.autoPass(id)];
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
    events.push({ kind: 'c7pass', playerId: id, auto: false });
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
    this.move('call', id, null, 0);
    return [{ kind: 'c7call', playerId: id }];
  }

  /** a player walks out: they lose and still pay; their cards go under the deck */
  leave(id: string): GameEvent[] {
    if (this.over || this.hand(id).length === 0 || this.kicked.has(id) || this.forfeited.has(id)) return [];
    this.forfeited.add(id);
    return this.drop(id, false);
  }

  /** the host removed a player: they pay and win nothing */
  removePlayer(id: string): GameEvent[] {
    if (this.over || this.kicked.has(id)) return [];
    this.hand(id);
    this.kicked.add(id);
    return this.drop(id, true);
  }

  /** no person is left playing: nobody wins */
  close(): GameEvent[] {
    if (this.over) return [];
    this.closed = true;
    this.finishGame();
    return [{ kind: 'gameOver', loserId: null }];
  }

  winners(): string[] {
    if (this.aborted || !this.over) return [];
    return this.places.slice(0, 1);
  }

  /** everyone but the winner; closed games: whoever walked out or still held cards */
  losers(): string[] {
    if (this.aborted) return [];
    if (this.closed) return [...this.forfeited, ...this.order.filter((id) => this.hand(id).length > 0 && !this.kicked.has(id))];
    const won = this.winners();
    return won.length === 0 ? [] : this.order.filter((id) => !won.includes(id) && !this.kicked.has(id));
  }

  private drop(id: string, kicked: boolean): GameEvent[] {
    this.deck.unshift(...this.hand(id));
    this.hands.set(id, []);
    this.called.delete(id);
    this.missed.delete(id);
    if (this.atRisk === id) this.atRisk = null;
    const left = this.order.filter((p) => this.hand(p).length > 0);
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
    // a 7 aimed at them is gone with them
    this.penalty = 0;
    return this.startTurn(this.nextActive(id));
  }

  private advance(fromId: string): GameEvent[] {
    return this.startTurn(this.nextActive(fromId));
  }

  /** runs everything automatic at the start of a turn, until someone has a choice to make */
  private startTurn(first: string | null): GameEvent[] {
    const events: GameEvent[] = [];
    let id = first;
    let idle = 0;
    while (id && !this.over) {
      this.turnId = id;
      this.turnSeq++;
      this.picks = 0;
      this.picked = [];
      // nobody moved since they went down to one card, so nobody caught them: they can still say it, or just play it
      if (this.missed.has(id)) {
        this.missed.delete(id);
        const count = 1 + this.penalty;
        this.penalty = 0;
        const got = this.draw(id, count, events);
        events.push({ kind: 'c7penalty', playerId: id, count: got, missed: true, forced: true });
        this.move('penalty', id, null, got);
        id = this.nextActive(id);
        continue;
      }
      if (this.penalty > 0) {
        // with stacking everyone gets the choice, so a pause never shows who holds a 7
        if (this.config.stack7) break;
        events.push(...this.takePenalty(id, true));
        id = this.nextActive(id);
        continue;
      }
      if (this.playable(id).length > 0) break;
      // nothing matches: one card is picked for them
      const got = this.canDraw() ? this.draw(id, 1, events) : 0;
      this.picks = 1;
      events.push({ kind: 'c7pick', playerId: id, count: got, forced: true, top: this.top() });
      this.move('pick', id, null, got);
      if (this.playable(id).length > 0) break;
      if (got > 0 && this.picks < this.maxPicks() && this.canDraw()) break;
      events.push({ kind: 'c7pass', playerId: id, auto: true });
      this.move('pass', id, null, 0);
      // nobody can play and nothing is left to pick: fewest cards wins
      idle = got === 0 ? idle + 1 : 0;
      const active = this.order.filter((p) => this.hand(p).length > 0);
      if (idle >= active.length) {
        const best = active.reduce((a, b) => (this.hand(b).length < this.hand(a).length ? b : a));
        this.stalled = true;
        this.places.push(best);
        this.finishGame();
        events.push({ kind: 'finish', playerId: best, place: 1 }, { kind: 'gameOver', loserId: null });
        break;
      }
      id = this.nextActive(id);
    }
    return events;
  }

  private takePenalty(id: string, forced: boolean): GameEvent[] {
    const events: GameEvent[] = [];
    const count = this.penalty;
    this.penalty = 0;
    const got = this.draw(id, count, events);
    events.push({ kind: 'c7penalty', playerId: id, count: got, missed: false, forced });
    this.move('penalty', id, null, got);
    return events;
  }

  private autoPass(id: string): GameEvent[] {
    this.move('pass', id, null, 0);
    return [{ kind: 'c7pass', playerId: id, auto: true }, ...this.advance(id)];
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
    return [{ kind: 'c7missed', playerId: id }];
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
      if (this.turnId === id) this.picked.push(card.id);
    }
    bySuit(hand);
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
    events.push({ kind: 'c7shuffle', count: this.deck.length });
    this.move('shuffle', null, null, this.deck.length);
  }

  private finishGame(): void {
    this.over = true;
    this.turnId = null;
    this.penalty = 0;
    this.atRisk = null;
  }

  private nextActive(fromId: string): string | null {
    const start = this.order.indexOf(fromId);
    for (let step = 1; step < this.order.length; step++) {
      const id = this.order[(start + step) % this.order.length];
      if (this.hand(id).length > 0) return id;
    }
    return null;
  }

  private move(kind: Crazy7Move['kind'], playerId: string | null, card: Card | null, count: number): void {
    this.last = { id: ++this.moveSeq, kind, playerId, card, count };
  }

  private penaltyText(): string | null {
    if (this.penalty === 0) return null;
    return this.config.stack7 ? `Play a 7 or pick ${this.penalty} cards` : `Pick ${this.penalty} cards`;
  }

  private matchText(): string {
    const top = this.top()!;
    return `Play a ${SUIT_WORD[top.suit]} or a ${top.rank}`;
  }

  private stat(id: string): PlayerStats {
    const s = this.stats.get(id);
    if (!s) throw new GameError('You are not in this game');
    return s;
  }

  private assertTurn(id: string): void {
    if (this.over) throw new GameError('Game is over');
    if (this.turnId !== id) throw new GameError('Not your turn');
  }
}
