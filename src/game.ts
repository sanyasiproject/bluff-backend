import { randomUUID } from 'node:crypto';
import { buildDeck, secureRandom, shuffle, sortHand, type RandomInt } from './cards.js';
import type { BetResult, GameEvent, PlayerStats, PlayRecord } from './models.js';
import { MAX_BLUFF_CALLS_IN_A_ROW, RANKS, type Card, type GameConfig, type Rank, type RevealView } from './types.js';

/** Errors safe to show to the player */
export class GameError extends Error {}

/** Pure game rules; knows nothing about sockets or rooms */
export class Game {
  readonly hands = new Map<string, Card[]>();
  readonly stats = new Map<string, PlayerStats>();
  pile: Card[] = [];
  roundRank: Rank | null = null;
  lastPlay: PlayRecord | null = null;
  passed = new Set<string>();
  turnId: string | null;
  places: string[] = [];
  loserId: string | null = null;
  reveal: RevealView | null = null;
  over = false;
  /** removed by the host mid-game */
  readonly kicked = new Set<string>();
  /** ended because too few players were left before anyone finished; no coins move */
  aborted = false;
  /** the host ended it after someone won: 1st place wins, everyone else loses */
  endedEarly = false;
  /** 2v2 partners, seated alternately (1st & 3rd vs 2nd & 4th); null when everyone plays alone */
  readonly teams: [string[], string[]] | null;
  /** coins bet on bluff calls; paid when the game is saved */
  readonly bets: BetResult[] = [];
  /** bluff calls each player made since their last play or pass */
  private callStreak = new Map<string, number>();
  private peeksUsed = new Map<string, number>();
  /** the team whose partners both finished first (or that the host's End game crowned) */
  private winningTeam: string[] | null = null;

  constructor(
    readonly order: string[],
    readonly config: GameConfig,
    rand: RandomInt = secureRandom,
  ) {
    if (order.length < 2 || order.length > 5) throw new GameError('Need 2 to 5 players');
    if (config.teams && order.length !== 4) throw new GameError('Teams need exactly 4 players');
    this.teams = config.teams ? [[order[0], order[2]], [order[1], order[3]]] : null;
    for (const id of order) {
      this.hands.set(id, []);
      this.stats.set(id, { bluffs: 0, caught: 0, goodCalls: 0, wrongCalls: 0, pickedUp: 0 });
    }
    shuffle(buildDeck(config.decks), rand).forEach((card, i) => this.hand(order[i % order.length]).push(card));
    for (const id of order) sortHand(this.hand(id));
    this.turnId = order[rand(order.length)];
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
    if (cardIds.length < 1) throw new GameError('Put down at least 1 card');
    if (picked.size !== cardIds.length) throw new GameError('Each card can only be played once');
    // kept in the order the player tapped them; others see and pick from that same order
    const cards = cardIds.map((id) => hand.find((c) => c.id === id)).filter((c): c is Card => c !== undefined);
    if (cards.length !== cardIds.length) throw new GameError('You do not have those cards');
    if (this.roundRank && rank && rank !== this.roundRank) throw new GameError(`This round is ${this.roundRank}`);
    const claim = this.roundRank ?? rank;
    if (!claim || !RANKS.includes(claim)) throw new GameError('Choose a rank to start the round');

    const events = this.settleLastPlay();
    if (this.over) return events;

    if (cards.some((c) => c.rank !== claim)) this.stat(playerId).bluffs++;
    this.hands.set(playerId, hand.filter((c) => !picked.has(c.id)));
    this.pile.push(...cards);
    this.roundRank = claim;
    this.lastPlay = { id: randomUUID(), playerId, cards, rank: claim };
    this.callStreak.delete(playerId);
    this.passed.clear();
    this.reveal = null;
    this.turnId = this.nextActive(playerId) ?? playerId;
    events.push({ kind: 'play', playerId, count: cards.length, rank: claim });
    return events;
  }

  pass(playerId: string): GameEvent[] {
    this.assertTurn(playerId);
    const play = this.lastPlay;
    if (!play) throw new GameError(this.roundRank ? 'Put down cards to keep the round going' : 'You start this round, play some cards');
    this.passed.add(playerId);
    this.callStreak.delete(playerId);
    const events: GameEvent[] = [{ kind: 'pass', playerId }];
    const others = this.order.filter((id) => id !== play.playerId && this.hand(id).length > 0);
    if (others.every((id) => this.passed.has(id))) return [...events, ...this.endRound()];
    this.turnId = this.nextActive(playerId);
    return events;
  }

  /** secretly look at one card of the last play; only the player who peeks learns it */
  peek(playerId: string, playId: string, cardIndex: number): Card {
    if (this.over) throw new GameError('Game is over');
    const play = this.lastPlay;
    if (!play || play.id !== playId) throw new GameError('Too late, that play is closed');
    if (play.playerId === playerId) throw new GameError('Those are your own cards');
    if (this.hand(playerId).length === 0) throw new GameError('You are already out');
    if (this.peeksLeft(playerId) === 0) throw new GameError(this.config.peeks > 0 ? 'No peeks left this game' : 'Peeks are off in this room');
    if (!Number.isInteger(cardIndex) || cardIndex < 0 || cardIndex >= play.cards.length) throw new GameError('Pick one of the played cards');
    this.peeksUsed.set(playerId, (this.peeksUsed.get(playerId) ?? 0) + 1);
    return play.cards[cardIndex];
  }

  peeksLeft(playerId: string): number {
    return Math.max(0, this.config.peeks - (this.peeksUsed.get(playerId) ?? 0));
  }

  /** bet: coins the caller stakes on being right; the room checks the amount, the game records who pays whom */
  callBluff(callerId: string, playId: string, cardIndex?: number, bet = 0): GameEvent[] {
    if (this.over) throw new GameError('Game is over');
    const play = this.lastPlay;
    if (!play || play.id !== playId) throw new GameError('Too late, that play is closed');
    if (play.playerId === callerId) throw new GameError('You cannot call bluff on yourself');
    if (this.hand(callerId).length === 0) throw new GameError('You are already out');
    if (this.partnerOf(callerId) === play.playerId) throw new GameError("You can't call bluff on your partner");
    if (bet > 0 && !this.config.bets) throw new GameError('Bets are off in this room');
    if (this.bluffCallsLeft(callerId) === 0) {
      throw new GameError(`You called bluff ${MAX_BLUFF_CALLS_IN_A_ROW} times in a row. Play or pass your turn first`);
    }

    let pickedIndex: number | null = null;
    let checked = play.cards;
    if (this.config.bluffRule === 'one') {
      if (cardIndex === undefined || !Number.isInteger(cardIndex) || cardIndex < 0 || cardIndex >= play.cards.length) {
        throw new GameError('Pick one of the played cards');
      }
      pickedIndex = cardIndex;
      checked = [play.cards[cardIndex]];
    }

    // counted only once the call is valid
    this.callStreak.set(callerId, (this.callStreak.get(callerId) ?? 0) + 1);
    const bluff = checked.some((c) => c.rank !== play.rank);
    const loserId = bluff ? play.playerId : callerId;
    const winnerId = bluff ? callerId : play.playerId;
    const pileCount = this.pile.length;
    if (bluff) {
      this.stat(callerId).goodCalls++;
      this.stat(play.playerId).caught++;
    } else {
      this.stat(callerId).wrongCalls++;
    }
    this.stat(loserId).pickedUp += pileCount;
    if (bet > 0) this.bets.push({ from: loserId, to: winnerId, amount: bet });
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
      bet,
    };

    const events: GameEvent[] = [{ kind: 'bluff', callerId, playerId: play.playerId, bluff, loserId, pileCount, bet }];
    events.push(...this.settleLastPlay());
    this.lastPlay = null;
    this.roundRank = null;
    this.passed.clear();
    if (this.over) return events;
    this.turnId = this.hand(winnerId).length > 0 ? winnerId : this.nextActive(winnerId);
    if (this.turnId) events.push({ kind: 'newRound', starterId: this.turnId });
    return events;
  }

  /** host's End game once someone has finished 1st; an unsettled last play is not counted */
  endEarly(): GameEvent[] {
    if (this.over) throw new GameError('Game is over');
    if (this.places.length === 0) throw new GameError('Nobody has won yet. Use Stop game instead');
    this.over = true;
    this.endedEarly = true;
    this.turnId = null;
    this.loserId = null;
    // with teams, 1st place's team wins
    if (this.teams) this.winningTeam = this.teamOf(this.places[0]);
    return [{ kind: 'gameOver', loserId: null }];
  }

  /** 1st place, or both partners of the winning team */
  winners(): string[] {
    if (this.aborted || !this.over) return [];
    if (this.teams) return this.winningTeam ?? [];
    return this.places.slice(0, 1);
  }

  /** the last player holding cards; everyone but the winners when the host ended it or teams played */
  losers(): string[] {
    if (this.aborted) return [];
    if (this.endedEarly || this.teams) {
      const won = this.winners();
      return won.length === 0 ? [] : this.order.filter((id) => !won.includes(id) && !this.kicked.has(id));
    }
    return this.loserId ? [this.loserId] : [];
  }

  teamOf(id: string): string[] | null {
    return this.teams?.find((t) => t.includes(id)) ?? null;
  }

  partnerOf(id: string): string | null {
    return this.teamOf(id)?.find((p) => p !== id) ?? null;
  }

  bluffCallsLeft(playerId: string): number {
    return Math.max(0, MAX_BLUFF_CALLS_IN_A_ROW - (this.callStreak.get(playerId) ?? 0));
  }

  /** the host removed a player: their cards leave the game and they get no place */
  removePlayer(playerId: string): GameEvent[] {
    if (this.over || this.kicked.has(playerId)) return [];
    this.hand(playerId);
    this.kicked.add(playerId);
    this.hands.set(playerId, []);
    this.passed.delete(playerId);
    // their last play can't be challenged any more; the round rank stays
    if (this.lastPlay?.playerId === playerId) this.lastPlay = null;

    // a team without its partner can't go on: stop the game, nobody wins or pays
    if (this.teams) {
      this.over = true;
      this.aborted = true;
      this.turnId = null;
      this.loserId = null;
      return [{ kind: 'gameOver', loserId: null }];
    }

    const left = this.order.filter((p) => this.hand(p).length > 0);
    if (left.length <= 1) {
      this.over = true;
      this.turnId = null;
      // nobody finished yet means there is no fair winner: stop the game instead
      this.aborted = this.places.length === 0;
      this.loserId = this.aborted ? null : (left[0] ?? null);
      return [{ kind: 'gameOver', loserId: this.loserId }];
    }
    if (this.turnId === playerId) this.turnId = this.nextActive(playerId);
    const play = this.lastPlay;
    if (play) {
      const others = this.order.filter((id) => id !== play.playerId && this.hand(id).length > 0);
      if (others.every((id) => this.passed.has(id))) return this.endRound();
    }
    return [];
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
    if (!id || this.hand(id).length > 0 || this.places.includes(id) || this.kicked.has(id)) return [];
    this.places.push(id);
    const events: GameEvent[] = [{ kind: 'finish', playerId: id, place: this.places.length }];
    // teams: the first team with both partners out wins
    const team = this.teamOf(id);
    if (team) {
      if (team.every((p) => this.places.includes(p))) {
        this.over = true;
        this.winningTeam = team;
        this.turnId = null;
        events.push({ kind: 'gameOver', loserId: null });
      }
      return events;
    }
    const left = this.order.filter((p) => this.hand(p).length > 0);
    if (left.length <= 1) {
      this.over = true;
      this.loserId = left[0] ?? null;
      this.turnId = null;
      events.push({ kind: 'gameOver', loserId: this.loserId });
    }
    return events;
  }

  private stat(id: string): PlayerStats {
    const s = this.stats.get(id);
    if (!s) throw new GameError('You are not in this game');
    return s;
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
