import { randomUUID } from 'node:crypto';
import { buildDeck, secureRandom, shuffle, sortHand, type RandomInt } from './cards.js';
import { lastPlaced, standingsOf } from './standings.js';
import { emptyHabits, noteBotCall, noteBotPlay, notePass, notePlay } from './habits.js';
import type { BetResult, GameEvent, Habits, LoggedPlay, PlayerStats, PlayRecord } from './models.js';
import { backsClaim, claimsAllowed, handValue, MAX_BLUFF_CALLS_IN_A_ROW, RANKS, SHIELD_MAX_CARDS, type Card, type GameConfig, type LieRecap, type PlayerPlays, type Rank, type RevealView } from './types.js';

/** how many uncaught lies the game-over reveal lists */
const LIE_RECAP_MAX = 6;

/** Errors safe to show to the player */
export class GameError extends Error {}

/** Pure game rules; knows nothing about sockets or rooms */
export class Game {
  readonly hands = new Map<string, Card[]>();
  readonly stats = new Map<string, PlayerStats>();
  pile: Card[] = [];
  /** who played each card of the pile, in the same order */
  pileBy: string[] = [];
  /** the rank the next play follows: the round's, or with Seedhi the last claim */
  roundRank: Rank | null = null;
  /** the Kismat card: this game's wild rank, drawn at the deal; null when the twist is off */
  readonly kismat: Rank | null;
  /** this round's claims so far: rank and how many cards */
  private roundClaims: { rank: Rank; n: number }[] = [];
  lastPlay: PlayRecord | null = null;
  passed = new Set<string>();
  turnId: string | null;
  places: string[] = [];
  loserId: string | null = null;
  reveal: RevealView | null = null;
  over = false;
  /** removed by the host mid-game */
  readonly kicked = new Set<string>();
  /** walked out mid-game: they lose and still pay a stake */
  readonly forfeited = new Set<string>();
  /** ended because too few players were left before anyone finished; no coins move */
  aborted = false;
  /** the host ended it after someone won: 1st place wins, everyone else loses */
  endedEarly = false;
  /** ended because only bots were left with cards */
  closed = false;
  /** 2v2 partners, seated alternately (1st & 3rd vs 2nd & 4th); null when everyone plays alone */
  readonly teams: [string[], string[]] | null;
  /** coins bet on bluff calls; paid when the game is saved */
  readonly bets: BetResult[] = [];
  /** bluff calls each player made since their last play or pass */
  private callStreak = new Map<string, number>();
  private peeksUsed = new Map<string, number>();
  private shieldsUsed = new Map<string, number>();
  /** the team whose partners both finished first (or that the host's End game crowned) */
  private winningTeam: string[] | null = null;
  /** seats the server plays; people's habits note how they treat bots' plays */
  readonly bots: ReadonlySet<string>;
  /** a bot's last play that people may still call: saved in their habits once it stands, or for whoever calls it */
  private botWatch: { playId: string; lie: boolean; people: string[] } | null = null;
  /** how many times each player caught each other one lying ("caller>player") */
  private readonly catches = new Map<string, number>();
  /** every play with its true cards, for the reveal once the game is over; settled: it stood or was called, not cut off by a walk-out or End game */
  private readonly playLog: { playId: string; playerId: string; rank: Rank; cards: Card[]; called: boolean; caught: boolean; settled: boolean; shielded: boolean }[] = [];

  constructor(
    readonly order: string[],
    readonly config: GameConfig,
    rand: RandomInt = secureRandom,
    bots: Iterable<string> = [],
  ) {
    this.bots = new Set(bots);
    if (order.length < 2 || order.length > 5) throw new GameError('Need 2 to 5 players');
    if (config.teams && order.length !== 4) throw new GameError('Teams need exactly 4 players');
    this.teams = config.teams ? [[order[0], order[2]], [order[1], order[3]]] : null;
    for (const id of order) {
      this.hands.set(id, []);
      this.stats.set(id, { bluffs: 0, caught: 0, goodCalls: 0, wrongCalls: 0, pickedUp: 0, plays: 0, chances: 0, habits: emptyHabits() });
    }
    shuffle(buildDeck(config.decks), rand).forEach((card, i) => this.hand(order[i % order.length]).push(card));
    for (const id of order) sortHand(this.hand(id));
    this.turnId = order[rand(order.length)];
    // drawn after everything else, so games without the twist deal exactly as before
    this.kismat = config.kismat ? RANKS[rand(RANKS.length)] : null;
  }

  /** the card backs up the claim: that rank, or the Kismat card */
  backs(card: Card, claim: Rank): boolean {
    return backsClaim(card, claim, this.kismat);
  }

  /** copies in the game that could back up a claim of this rank (the Kismat cards count too) */
  copiesFor(claim: Rank): number {
    return 4 * this.config.decks * (this.kismat && this.kismat !== claim ? 2 : 1);
  }

  hand(id: string): Card[] {
    const cards = this.hands.get(id);
    if (!cards) throw new GameError('You are not in this game');
    return cards;
  }

  /** shield: 🔒 nobody can call or peek at this play (up to SHIELD_MAX_CARDS, never the cards that empty the hand) */
  play(playerId: string, cardIds: string[], rank?: Rank, shield = false): GameEvent[] {
    this.assertTurn(playerId);
    const hand = this.hand(playerId);
    const picked = new Set(cardIds);
    if (cardIds.length < 1) throw new GameError('Put down at least 1 card');
    if (picked.size !== cardIds.length) throw new GameError('Each card can only be played once');
    // kept in the order the player tapped them; others see and pick from that same order
    const cards = cardIds.map((id) => hand.find((c) => c.id === id)).filter((c): c is Card => c !== undefined);
    if (cards.length !== cardIds.length) throw new GameError('You do not have those cards');
    const allowed = claimsAllowed(this.roundRank, this.config.seedhi);
    if (this.roundRank && rank && !allowed.includes(rank)) {
      throw new GameError(this.config.seedhi ? `Claim ${allowed.join(', ')} this time` : `This round is ${this.roundRank}`);
    }
    // following without a rank (older apps): the same rank
    const claim = rank ?? this.roundRank;
    if (!claim || !RANKS.includes(claim)) throw new GameError('Choose a rank to start the round');
    if (shield) {
      if ((this.config.shields ?? 0) === 0) throw new GameError('Card Shields are off in this room');
      if (this.shieldsLeft(playerId) === 0) throw new GameError('No Card Shields left this game');
      if (cards.length > SHIELD_MAX_CARDS) throw new GameError(`A Card Shield covers up to ${SHIELD_MAX_CARDS} cards`);
      if (cards.length === hand.length) throw new GameError("Your last cards can't be shielded");
    }

    const events = this.settleLastPlay();
    if (this.over) return events;
    // the play before this one stood
    this.watchStood();

    const lie = cards.some((c) => !this.backs(c, claim));
    if (lie) this.stat(playerId).bluffs++;
    this.stat(playerId).plays++;
    // saved with the game for the bots' read on this player; nobody sees it while the game runs (cards claimed as this rank this round so far).
    // Not from Seedhi games: there a pass or a "push" doesn't mean what it means in the classic game; nor shielded plays, which nobody could call
    if (!this.config.seedhi && !shield) notePlay(
      this.habits(playerId),
      hand,
      cards,
      claim,
      {
        opening: this.roundRank === null,
        before: this.roundClaims.filter((c) => c.rank === claim).reduce((sum, c) => sum + c.n, 0),
        copies: this.copiesFor(claim),
      },
      this.kismat,
    );
    this.hands.set(playerId, hand.filter((c) => !picked.has(c.id)));
    // everyone still in who may challenge this play had a chance to call it (a shielded one gives nobody a chance)
    for (const id of this.order) {
      if (!shield && id !== playerId && this.hand(id).length > 0 && this.partnerOf(id) !== playerId) this.stat(id).chances++;
    }
    this.pile.push(...cards);
    this.pileBy.push(...cards.map(() => playerId));
    this.roundRank = claim;
    this.roundClaims.push({ rank: claim, n: cards.length });
    if (shield) this.shieldsUsed.set(playerId, (this.shieldsUsed.get(playerId) ?? 0) + 1);
    this.lastPlay = { id: randomUUID(), playerId, cards, rank: claim, ...(shield && { shielded: true }) };
    this.playLog.push({ playId: this.lastPlay.id, playerId, rank: claim, cards, called: false, caught: false, settled: false, shielded: shield });
    // a bot's play that doesn't empty its hand: how people treat it is saved for the bots, once each person has had their chance at it
    if (this.bots.has(playerId) && hand.length > cards.length && !shield) {
      const people = this.order.filter((id) => !this.bots.has(id) && this.hand(id).length > 0 && this.partnerOf(id) !== playerId && this.bluffCallsLeft(id) > 0);
      this.botWatch = people.length > 0 ? { playId: this.lastPlay.id, lie, people } : null;
    }
    this.callStreak.delete(playerId);
    this.passed.clear();
    this.reveal = null;
    this.turnId = this.nextActive(playerId) ?? playerId;
    events.push({ kind: 'play', playerId, count: cards.length, rank: claim, ...(shield && { shielded: true }) });
    return events;
  }

  pass(playerId: string): GameEvent[] {
    this.assertTurn(playerId);
    const play = this.lastPlay;
    if (!play) throw new GameError(this.roundRank ? 'Put down cards to keep the round going' : 'You start this round, play some cards');
    if (!this.config.seedhi) notePass(this.habits(playerId), this.hand(playerId), play.rank, this.kismat);
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
    if (play.shielded) throw new GameError('That play has a Card Shield 🔒');
    if (this.hand(playerId).length === 0) throw new GameError('You are already out');
    if (this.peeksLeft(playerId) === 0) throw new GameError(this.config.peeks > 0 ? 'No peeks left this game' : 'Peeks are off in this room');
    if (!Number.isInteger(cardIndex) || cardIndex < 0 || cardIndex >= play.cards.length) throw new GameError('Pick one of the played cards');
    this.peeksUsed.set(playerId, (this.peeksUsed.get(playerId) ?? 0) + 1);
    return play.cards[cardIndex];
  }

  shieldsLeft(playerId: string): number {
    return Math.max(0, (this.config.shields ?? 0) - (this.shieldsUsed.get(playerId) ?? 0));
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
    if (play.shielded) throw new GameError("That play has a Card Shield 🔒 You can't call it");
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
    // a person calling a bot's play (not its last cards), saved for the bots; anyone else didn't get their full chance at it
    const watch = this.botWatch?.playId === playId ? this.botWatch : null;
    this.botWatch = null;
    if (watch?.people.includes(callerId)) {
      noteBotPlay(this.habits(callerId), watch.lie);
      noteBotCall(this.habits(callerId), watch.lie);
    }
    const bluff = checked.some((c) => !this.backs(c, play.rank));
    const logged = this.playLog.find((l) => l.playId === playId);
    if (logged) {
      logged.called = true;
      logged.caught = bluff;
    }
    const loserId = bluff ? play.playerId : callerId;
    const winnerId = bluff ? callerId : play.playerId;
    const pileCount = this.pile.length;
    if (bluff) {
      this.stat(callerId).goodCalls++;
      this.stat(play.playerId).caught++;
      const pair = `${callerId}>${play.playerId}`;
      this.catches.set(pair, (this.catches.get(pair) ?? 0) + 1);
    } else {
      this.stat(callerId).wrongCalls++;
    }
    this.stat(loserId).pickedUp += pileCount;
    if (bet > 0) this.bets.push({ from: loserId, to: winnerId, amount: bet });
    this.hands.set(loserId, sortHand([...this.hand(loserId), ...this.pile]));
    this.pile = [];
    this.pileBy = [];
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
    this.roundClaims = [];
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

  /** no person is left holding cards (only bots play on): 1st place, if any, wins; whoever still holds cards loses */
  close(): GameEvent[] {
    if (this.over) return [];
    this.over = true;
    this.closed = true;
    this.turnId = null;
    this.loserId = null;
    return [{ kind: 'gameOver', loserId: null }];
  }

  /** game over: the boldest lies nobody caught and how much each player lied (named by the room); null while the game runs */
  lieRecap(nameOf: (id: string) => string): LieRecap | null {
    if (!this.over) return null;
    const fakes = (l: { rank: Rank; cards: Card[] }) => l.cards.filter((c) => !this.backs(c, l.rank)).length;
    const away = this.playLog.filter((l) => fakes(l) > 0 && !l.caught);
    // most fake cards first; the sort is stable, so ties keep the order they were played
    const lies = [...away]
      .sort((a, b) => fakes(b) - fakes(a))
      .slice(0, LIE_RECAP_MAX)
      .map((l) => ({ playerId: l.playerId, rank: l.rank, cards: [...l.cards], survivedCall: l.called, ...(l.shielded && { shielded: true }) }));
    const players = this.order.map((id) => {
      const s = this.stat(id);
      return { playerId: id, name: nameOf(id), plays: s.plays, lies: s.bluffs, caught: s.caught };
    });
    return { lies, uncaught: away.length, players };
  }

  /** game over: every play one player made, in order, with the real cards, and what they still held; null while the game runs */
  playsOf(playerId: string): PlayerPlays | null {
    if (!this.over) return null;
    const plays = this.playLog
      .filter((l) => l.playerId === playerId)
      .map((l) => ({ rank: l.rank, cards: [...l.cards], called: l.called, caught: l.caught }));
    return { plays, hand: [...this.hand(playerId)] };
  }

  /** server only: one player's plays so far with the true cards, for their secret mission card; never put it in a view */
  playLogOf(playerId: string): LoggedPlay[] {
    return this.playLog
      .filter((l) => l.playerId === playerId)
      .map((l) => ({ rank: l.rank, cards: [...l.cards], called: l.called, caught: l.caught, open: !l.settled, lie: l.cards.some((c) => !this.backs(c, l.rank)) }));
  }

  /** who caught whom lying this game, for the saved game */
  catchList(): { by: string; of: string; n: number }[] {
    return [...this.catches].map(([pair, n]) => {
      const [by, of] = pair.split('>');
      return { by, of, n };
    });
  }

  /** 1st place, or both partners of the winning team */
  winners(): string[] {
    if (this.aborted || !this.over) return [];
    if (this.teams) return this.winningTeam ?? [];
    return this.places.slice(0, 1);
  }

  handValueOf(id: string): number {
    return handValue(this.hand(id));
  }

  /** once over: finishing order, then lowest value of cards left (A 1 … K 13); walk-outs, removed players and 2v2 seats that didn't finish get none */
  placeOf(id: string): number | null {
    return this.standings().get(id) ?? null;
  }

  private standings(): Map<string, number> {
    if (!this.over || this.aborted || this.teams) return standingsOf(this.places, [], () => 0);
    const still = this.order.filter((id) => !this.kicked.has(id) && !this.forfeited.has(id));
    return standingsOf(this.places, still, (id) => handValue(this.hand(id)));
  }

  /** the last place plus anyone who walked out; 2v2: everyone but the winning team */
  losers(): string[] {
    if (this.aborted) return [];
    if (this.teams) {
      // closed with bots still holding cards: they never finished, and anyone who walked out lost
      if (this.closed) return [...this.forfeited, ...this.order.filter((id) => this.hand(id).length > 0 && !this.kicked.has(id))];
      const won = this.winners();
      return won.length === 0 ? [] : this.order.filter((id) => !won.includes(id) && !this.kicked.has(id));
    }
    // the host ended it or only bots were left: whoever holds the highest value is last
    if (this.endedEarly || this.closed) return [...this.forfeited, ...lastPlaced(this.standings(), this.places)];
    const out = [...this.forfeited];
    if (this.loserId && !out.includes(this.loserId)) out.push(this.loserId);
    return out;
  }

  /** a player walks out: their cards leave, they lose (and still pay a stake); in 2v2 their team loses */
  leave(playerId: string): GameEvent[] {
    if (this.over) return [];
    // already finished: leaving changes nothing (last cards still open to a call are not finished)
    if ((this.hand(playerId).length === 0 && this.goingOut() !== playerId) || this.kicked.has(playerId) || this.forfeited.has(playerId)) return [];
    this.forfeited.add(playerId);
    this.hands.set(playerId, []);
    this.passed.delete(playerId);
    if (this.lastPlay?.playerId === playerId) this.lastPlay = null;
    this.unwatch(playerId);

    if (this.teams) {
      this.over = true;
      this.turnId = null;
      this.loserId = null;
      this.winningTeam = this.teams.find((t) => !t.includes(playerId)) ?? null;
      return [{ kind: 'gameOver', loserId: null }];
    }
    // someone whose last cards are still open to a call is still in the game
    const out = this.goingOut();
    const left = this.order.filter((p) => this.hand(p).length > 0 || p === out);
    if (left.length <= 1) {
      // the last one still holding cards finishes next: 1st if nobody had finished yet
      const events: GameEvent[] = [];
      if (left[0]) {
        this.places.push(left[0]);
        events.push({ kind: 'finish', playerId: left[0], place: this.places.length });
      }
      this.over = true;
      this.turnId = null;
      this.loserId = null;
      return [...events, { kind: 'gameOver', loserId: null }];
    }
    if (this.turnId === playerId) this.turnId = this.nextActive(playerId);
    const play = this.lastPlay;
    if (play) {
      const others = this.order.filter((id) => id !== play.playerId && this.hand(id).length > 0);
      if (others.every((id) => this.passed.has(id))) return this.endRound();
    }
    return [];
  }

  teamOf(id: string): string[] | null {
    return this.teams?.find((t) => t.includes(id)) ?? null;
  }

  partnerOf(id: string): string | null {
    return this.teamOf(id)?.find((p) => p !== id) ?? null;
  }

  /** calls left in a row; a player's last cards can always be called; no limit once only two players hold cards */
  bluffCallsLeft(playerId: string): number {
    if (this.order.filter((id) => this.hand(id).length > 0 || id === this.goingOut()).length <= 2) return MAX_BLUFF_CALLS_IN_A_ROW;
    const left = Math.max(0, MAX_BLUFF_CALLS_IN_A_ROW - (this.callStreak.get(playerId) ?? 0));
    return left === 0 && this.goingOut() ? 1 : left;
  }

  /** whoever emptied their hand with the last play; they aren't out until it settles, so it can still be called */
  goingOut(): string | null {
    const id = this.lastPlay?.playerId;
    return id && !this.over && this.hand(id).length === 0 && !this.places.includes(id) ? id : null;
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
    this.unwatch(playerId);

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
    // everyone passed: the last play stood
    this.watchStood();
    const starter = this.lastPlay!.playerId;
    const discarded = this.pile.length;
    const events = this.settleLastPlay();
    this.pile = [];
    this.pileBy = [];
    this.lastPlay = null;
    this.roundRank = null;
    this.roundClaims = [];
    this.passed.clear();
    if (this.over) return events;
    this.turnId = this.hand(starter).length > 0 ? starter : this.nextActive(starter);
    if (this.turnId) events.push({ kind: 'roundEnd', starterId: this.turnId, discarded });
    return events;
  }

  /** The last play stands; a player whose hand it emptied is now finished */
  private settleLastPlay(): GameEvent[] {
    // the play had its chance to be called: it stood, or a call just settled it
    const logged = this.lastPlay ? this.playLog.find((l) => l.playId === this.lastPlay!.id) : undefined;
    if (logged) logged.settled = true;
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

  /** the watched bot play stood without a call: everyone watching it had their chance */
  private watchStood(): void {
    const w = this.botWatch;
    this.botWatch = null;
    if (w) for (const id of w.people) noteBotPlay(this.habits(id), w.lie);
  }

  /** someone left: they're off the watch, and a play nobody can call any more is off it altogether */
  private unwatch(playerId: string): void {
    if (!this.botWatch) return;
    if (this.lastPlay?.id !== this.botWatch.playId) this.botWatch = null;
    else this.botWatch.people = this.botWatch.people.filter((id) => id !== playerId);
  }

  private habits(id: string): Habits {
    const s = this.stat(id);
    s.habits ??= emptyHabits();
    return s.habits;
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
