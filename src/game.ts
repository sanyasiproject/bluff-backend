import { randomUUID } from 'node:crypto';
import { buildDeck, secureRandom, shuffle, sortHand, type RandomInt } from './cards.js';
import type { GameEvent, PlayRecord } from './models.js';
import { RANKS, type Card, type GameConfig, type Rank, type RevealView } from './types.js';

/** Errors safe to show to the player */
export class GameError extends Error {}

/** Pure game rules; knows nothing about sockets or rooms */
export class Game {
  readonly hands = new Map<string, Card[]>();
  pile: Card[] = [];
  roundRank: Rank | null = null;
  lastPlay: PlayRecord | null = null;
  passed = new Set<string>();
  turnId: string | null;
  places: string[] = [];
  loserId: string | null = null;
  reveal: RevealView | null = null;
  over = false;

  constructor(
    readonly order: string[],
    readonly config: GameConfig,
    private readonly rand: RandomInt = secureRandom,
  ) {
    if (order.length < 2 || order.length > 5) throw new GameError('Need 2 to 5 players');
    for (const id of order) this.hands.set(id, []);
    shuffle(buildDeck(config.decks), rand).forEach((card, i) => this.hand(order[i % order.length]).push(card));
    for (const id of order) sortHand(this.hand(id));
    this.turnId = order[rand(order.length)];
  }

  get maxPerPlay(): number {
    return 4 * this.config.decks;
  }

  hand(id: string): Card[] {
    const cards = this.hands.get(id);
    if (!cards) throw new GameError('You are not in this game');
    return cards;
  }

  play(playerId: string, cardIds: string[], rank?: Rank): GameEvent[] {
    this.assertTurn(playerId);
    const hand = this.hand(playerId);
    const picked = new Set(cardIds);
    if (picked.size !== cardIds.length || cardIds.length < 1 || cardIds.length > this.maxPerPlay) {
      throw new GameError(`Play 1 to ${this.maxPerPlay} cards`);
    }
    // shuffled so a card's position in the play gives nothing away when the caller picks one
    const cards = shuffle(
      hand.filter((c) => picked.has(c.id)),
      this.rand,
    );
    if (cards.length !== cardIds.length) throw new GameError('You do not have those cards');
    if (this.roundRank && rank && rank !== this.roundRank) throw new GameError(`This round is ${this.roundRank}`);
    const claim = this.roundRank ?? rank;
    if (!claim || !RANKS.includes(claim)) throw new GameError('Choose a rank to start the round');

    const events = this.settleLastPlay();
    if (this.over) return events;

    this.hands.set(playerId, hand.filter((c) => !picked.has(c.id)));
    this.pile.push(...cards);
    this.roundRank = claim;
    this.lastPlay = { id: randomUUID(), playerId, cards, rank: claim };
    this.passed.clear();
    this.reveal = null;
    this.turnId = this.nextActive(playerId) ?? playerId;
    events.push({ kind: 'play', playerId, count: cards.length, rank: claim });
    return events;
  }

  pass(playerId: string): GameEvent[] {
    this.assertTurn(playerId);
    const play = this.lastPlay;
    if (!play) throw new GameError('You start this round, play some cards');
    this.passed.add(playerId);
    const events: GameEvent[] = [{ kind: 'pass', playerId }];
    const others = this.order.filter((id) => id !== play.playerId && this.hand(id).length > 0);
    if (others.every((id) => this.passed.has(id))) return [...events, ...this.endRound()];
    this.turnId = this.nextActive(playerId);
    return events;
  }

  callBluff(callerId: string, playId: string, cardIndex?: number): GameEvent[] {
    if (this.over) throw new GameError('Game is over');
    const play = this.lastPlay;
    if (!play || play.id !== playId) throw new GameError('Too late, that play is closed');
    if (play.playerId === callerId) throw new GameError('You cannot call bluff on yourself');
    if (this.hand(callerId).length === 0) throw new GameError('You are already out');

    let pickedIndex: number | null = null;
    let checked = play.cards;
    if (this.config.bluffRule === 'one') {
      if (cardIndex === undefined || !Number.isInteger(cardIndex) || cardIndex < 0 || cardIndex >= play.cards.length) {
        throw new GameError('Pick one of the played cards');
      }
      pickedIndex = cardIndex;
      checked = [play.cards[cardIndex]];
    }

    const bluff = checked.some((c) => c.rank !== play.rank);
    const loserId = bluff ? play.playerId : callerId;
    const winnerId = bluff ? callerId : play.playerId;
    const pileCount = this.pile.length;
    this.hands.set(loserId, sortHand([...this.hand(loserId), ...this.pile]));
    this.pile = [];
    this.reveal = {
      playId,
      callerId,
      playerId: play.playerId,
      rank: play.rank,
      cards: play.cards.map((c, i) => (pickedIndex === null || i === pickedIndex ? c : null)),
      pickedIndex,
      bluff,
      loserId,
      pileCount,
    };

    const events: GameEvent[] = [{ kind: 'bluff', callerId, playerId: play.playerId, bluff, loserId, pileCount }];
    events.push(...this.settleLastPlay());
    this.lastPlay = null;
    this.roundRank = null;
    this.passed.clear();
    if (this.over) return events;
    this.turnId = this.hand(winnerId).length > 0 ? winnerId : this.nextActive(winnerId);
    if (this.turnId) events.push({ kind: 'newRound', starterId: this.turnId });
    return events;
  }

  private endRound(): GameEvent[] {
    const starter = this.lastPlay!.playerId;
    const discarded = this.pile.length;
    const events = this.settleLastPlay();
    this.pile = [];
    this.lastPlay = null;
    this.roundRank = null;
    this.passed.clear();
    if (this.over) return events;
    this.turnId = this.hand(starter).length > 0 ? starter : this.nextActive(starter);
    if (this.turnId) events.push({ kind: 'roundEnd', starterId: this.turnId, discarded });
    return events;
  }

  /** The last play stands; a player whose hand it emptied is now finished */
  private settleLastPlay(): GameEvent[] {
    const id = this.lastPlay?.playerId;
    if (!id || this.hand(id).length > 0 || this.places.includes(id)) return [];
    this.places.push(id);
    const events: GameEvent[] = [{ kind: 'finish', playerId: id, place: this.places.length }];
    const left = this.order.filter((p) => this.hand(p).length > 0);
    if (left.length <= 1) {
      this.over = true;
      this.loserId = left[0] ?? null;
      this.turnId = null;
      events.push({ kind: 'gameOver', loserId: this.loserId });
    }
    return events;
  }

  private assertTurn(playerId: string): void {
    if (this.over) throw new GameError('Game is over');
    if (this.turnId !== playerId) throw new GameError('Not your turn');
  }

  private nextActive(fromId: string): string | null {
    const start = this.order.indexOf(fromId);
    for (let step = 1; step < this.order.length; step++) {
      const id = this.order[(start + step) % this.order.length];
      if (this.hand(id).length > 0) return id;
    }
    return null;
  }
}
