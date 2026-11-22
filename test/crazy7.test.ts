import { describe, expect, it } from 'vitest';
import { Crazy7Game } from '../src/crazy7/game.js';
import { GameError } from '../src/game.js';
import type { GameEvent } from '../src/models.js';
import { Room } from '../src/rooms.js';
import type { Card, GameConfig, Rank, Suit } from '../src/types.js';

const CONFIG: GameConfig = {
  game: 'crazy7',
  decks: 1,
  bluffRule: 'one',
  stake: 0,
  peeks: 0,
  bets: false,
  teams: false,
  handSize: 7,
  maxPicks: 1,
  stack7: true,
};

const c = (rank: Rank, suit: Suit, d = 1): Card => ({ id: `${rank}${suit}${d}`, rank, suit });

/** a game in a chosen position; the deck is picked from its end */
function table(hands: Record<string, Card[]>, pile: Card[], turn: string, opts: { deck?: Card[]; config?: Partial<GameConfig> } = {}) {
  return Crazy7Game.fromState({
    order: Object.keys(hands),
    config: { ...CONFIG, ...opts.config },
    hands: new Map(Object.entries(hands).map(([id, cards]) => [id, [...cards]])),
    deck: opts.deck ?? [],
    pile,
    turnId: turn,
    penalty: 0,
    picks: 0,
    picked: [],
    called: new Set(),
    missed: new Set(),
    atRisk: null,
    over: false,
    places: [],
  });
}

const kinds = (events: GameEvent[]) => events.map((e) => e.kind);
const ids = (cards: Card[]) => cards.map((x) => x.id);

describe('crazy 7: dealing', () => {
  it('deals 7 (or 5) each, never starts the pile with a 7, and keeps the rest as the deck', () => {
    for (let seed = 0; seed < 40; seed++) {
      const g = new Crazy7Game(['a', 'b', 'c'], CONFIG);
      expect(g.top()!.rank).not.toBe('7');
      const inHands = [...g.hands.values()].reduce((n, h) => n + h.length, 0);
      expect(inHands + g.deck.length + g.pile.length).toBe(52);
    }
    const five = new Crazy7Game(['a', 'b'], { ...CONFIG, handSize: 5, decks: 2 });
    const total = [...five.hands.values()].reduce((n, h) => n + h.length, 0) + five.deck.length + five.pile.length;
    expect(total).toBe(104);
    expect(() => new Crazy7Game(['a'], CONFIG)).toThrow(GameError);
  });
});

describe('crazy 7: matching', () => {
  it('takes a card of the same suit or number and moves the turn on', () => {
    const g = table({ a: [c('9', 'H'), c('5', 'S'), c('K', 'C')], b: [c('2', 'H'), c('3', 'S')] }, [c('5', 'H')], 'a');
    expect(ids(g.playable('a'))).toEqual(['9H1', '5S1']);
    expect(() => g.play('a', 'KC1')).toThrow('Play a heart or a 5');
    expect(() => g.play('b', '2H1')).toThrow('Not your turn');
    expect(kinds(g.play('a', '5S1'))).toEqual(['c7play']);
    expect(g.top()!.id).toBe('5S1');
    expect(g.turnId).toBe('b');
  });

  it('picks one card automatically when nothing matches; the player may then play it or pass', () => {
    const g = table({ a: [c('5', 'S'), c('K', 'C'), c('Q', 'C')], b: [c('2', 'D'), c('3', 'D')] }, [c('K', 'H')], 'a', {
      deck: [c('4', 'S'), c('9', 'C')],
    });
    // b has only diamonds against the K♣, so the 9♣ is picked for them, and it fits
    const events = g.play('a', 'KC1');
    expect(events.find((e) => e.kind === 'c7pick')).toMatchObject({ playerId: 'b', forced: true, count: 1 });
    expect(g.turnId).toBe('b');
    expect(g.picks).toBe(1);
    expect(ids(g.playable('b'))).toEqual(['9C1']);
    // one pick a turn: no passing, the card that fits must be played
    expect(g.canPass('b')).toBe(false);
    expect(() => g.pass('b')).toThrow('You picked 1. Play a card that fits');
    g.play('b', '9C1');
    expect(g.turnId).toBe('a');
  });

  it("can't pass before picking; Pass only stops picking early, and at the limit a card that fits must be played", () => {
    const deck = [c('2', 'D'), c('3', 'D'), c('4', 'D'), c('6', 'D')];
    const g = table({ a: [c('9', 'H'), c('J', 'S')], b: [c('2', 'S')] }, [c('9', 'S')], 'a', { deck, config: { maxPicks: 3 } });
    expect(() => g.pass('a')).toThrow('Pick a card first');
    g.pick('a');
    g.pick('a');
    expect(g.picks).toBe(2);
    expect(g.hand('a')).toHaveLength(4);
    expect(g.canPass('a')).toBe(true);
    // still has matching cards, so the turn waits at the limit too
    g.pick('a');
    expect(g.picks).toBe(3);
    expect(() => g.pick('a')).toThrow('You picked 3 this turn');
    expect(g.canPass('a')).toBe(false);
    expect(() => g.pass('a')).toThrow('You picked 3. Play a card that fits');
    expect(g.turnId).toBe('a');
    g.play('a', 'JS1');
    expect(g.turnId).toBe('b');

    const early = table({ a: [c('9', 'H'), c('J', 'S')], b: [c('2', 'S')] }, [c('9', 'S')], 'a', { deck, config: { maxPicks: 3 } });
    early.pick('a');
    early.pass('a');
    expect(early.turnId).toBe('b');
  });

  it('ends the turn by itself when the limit is reached and nothing matches', () => {
    const deck = [c('2', 'D'), c('3', 'D'), c('4', 'D')];
    const g = table({ a: [c('9', 'H'), c('J', 'S'), c('Q', 'S')], b: [c('5', 'C'), c('Q', 'C')] }, [c('8', 'H')], 'a', {
      deck,
      config: { maxPicks: 2 },
    });
    // b has only clubs: the first pick is automatic, the second is theirs to make
    g.play('a', '9H1');
    expect(g.turnId).toBe('b');
    expect(g.picks).toBe(1);
    const events = g.pick('b');
    expect(events.filter((e) => e.kind === 'c7pass')).toEqual([{ kind: 'c7pass', playerId: 'b', auto: true }]);
    expect(g.turnId).toBe('a');
  });
});

describe('crazy 7: sevens', () => {
  it('with stacking on, waits for the next player to take the pick, so nobody learns who holds a 7', () => {
    const g = table({ a: [c('7', 'H'), c('K', 'S'), c('2', 'H')], b: [c('2', 'S'), c('3', 'C')] }, [c('5', 'H')], 'a', {
      deck: [c('A', 'D'), c('Q', 'D')],
    });
    g.play('a', '7H1');
    expect(g.turnId).toBe('b');
    expect(g.penalty).toBe(2);
    expect(g.playable('b')).toEqual([]);
    expect(g.canPick('b')).toBe(true);
    expect(g.pick('b').find((e) => e.kind === 'c7penalty')).toMatchObject({ playerId: 'b', count: 2, forced: false });
    expect(g.turnId).toBe('a');
  });

  it('makes the next player pick 2 and lose the turn when stacking is off', () => {
    const g = table(
      { a: [c('7', 'H'), c('K', 'S')], b: [c('2', 'H'), c('3', 'C')], c: [c('9', 'H'), c('4', 'C')] },
      [c('5', 'H')],
      'a',
      { deck: [c('A', 'D'), c('Q', 'D'), c('J', 'D')], config: { stack7: false } },
    );
    const events = g.play('a', '7H1');
    expect(events.find((e) => e.kind === 'c7penalty')).toMatchObject({ playerId: 'b', count: 2, forced: true, missed: false });
    expect(g.hand('b')).toHaveLength(4);
    expect(g.turnId).toBe('c');
    expect(g.penalty).toBe(0);
    // the 7 is an ordinary card now
    expect(ids(g.playable('c'))).toEqual(['9H1']);
  });

  it('lets the next player answer with their own 7, passing 4 on', () => {
    const g = table(
      { a: [c('7', 'H'), c('K', 'S'), c('3', 'C')], b: [c('7', 'C'), c('5', 'C')], c: [c('9', 'H'), c('4', 'C')] },
      [c('5', 'H')],
      'a',
      { deck: [c('A', 'D'), c('Q', 'D'), c('J', 'D'), c('10', 'D')] },
    );
    g.play('a', '7H1');
    expect(g.turnId).toBe('b');
    expect(g.penalty).toBe(2);
    expect(ids(g.playable('b'))).toEqual(['7C1']);
    expect(() => g.play('b', '5C1')).toThrow('Play a 7 or pick 2 cards');
    expect(() => g.pass('b')).toThrow('Play a 7 or pick 2 cards');
    g.play('b', '7C1');
    expect(g.turnId).toBe('c');
    expect(g.penalty).toBe(4);
    expect(g.pick('c').find((e) => e.kind === 'c7penalty')).toMatchObject({ playerId: 'c', count: 4 });
    expect(g.turnId).toBe('a');
  });

  it('lets a player with a 7 take the pick instead, and takes it for them when stacking is off', () => {
    const deck = [c('A', 'D'), c('Q', 'D'), c('J', 'D'), c('10', 'D')];
    const g = table({ a: [c('7', 'H'), c('K', 'S'), c('2', 'H')], b: [c('7', 'C'), c('3', 'C')] }, [c('5', 'H')], 'a', { deck });
    g.play('a', '7H1');
    expect(kinds(g.pick('b'))).toEqual(['c7penalty']);
    expect(g.hand('b')).toHaveLength(4);
    expect(g.turnId).toBe('a');

    const off = table({ a: [c('7', 'H'), c('K', 'S'), c('2', 'H')], b: [c('7', 'C'), c('3', 'C')] }, [c('5', 'H')], 'a', {
      deck,
      config: { stack7: false },
    });
    off.play('a', '7H1');
    expect(off.hand('b')).toHaveLength(4);
    expect(off.turnId).toBe('a');
  });
});

describe('crazy 7: last card', () => {
  it('catches a player who goes down to one card without saying it: they pick 1 and miss a turn', () => {
    const deck = [c('2', 'D'), c('3', 'D'), c('4', 'D')];
    const g = table({ a: [c('9', 'H'), c('J', 'H')], b: [c('5', 'H'), c('6', 'H'), c('8', 'H')] }, [c('2', 'H')], 'a', { deck });
    g.play('a', '9H1');
    expect(g.atRisk).toBe('a');
    expect(g.canCall('a')).toBe(true);
    // b moves first: too late
    const events = g.play('b', '5H1');
    expect(kinds(events)).toEqual(['c7missed', 'c7play', 'c7penalty']);
    expect(events[2]).toMatchObject({ playerId: 'a', count: 1, missed: true });
    expect(g.hand('a')).toHaveLength(2);
    expect(g.turnId).toBe('b');
    expect(g.stats.get('a')!.missedCalls).toBe(1);
  });

  it('is safe when said before playing the second-last card, or right after', () => {
    const g = table({ a: [c('9', 'H'), c('J', 'H')], b: [c('5', 'H'), c('6', 'H'), c('8', 'H')] }, [c('2', 'H')], 'a');
    expect(kinds(g.call('a'))).toEqual(['c7call']);
    g.play('a', '9H1');
    expect(g.atRisk).toBe(null);
    g.play('b', '5H1');
    expect(g.turnId).toBe('a');
    expect(g.hand('a')).toHaveLength(1);

    const h = table({ a: [c('9', 'H'), c('J', 'H')], b: [c('5', 'H'), c('6', 'H'), c('8', 'H')] }, [c('2', 'H')], 'a');
    h.play('a', '9H1');
    h.call('a');
    h.play('b', '5H1');
    expect(h.turnId).toBe('a');
    expect(() => h.call('b')).toThrow('Say it when you are down to your last card');
  });

  it('can be said before stacking a 7 as the second-last card', () => {
    const g = table({ a: [c('7', 'H'), c('K', 'S')], b: [c('7', 'C'), c('2', 'S')], c: [c('9', 'D')] }, [c('5', 'H')], 'a', {
      deck: [c('A', 'D'), c('Q', 'D'), c('J', 'D'), c('10', 'D'), c('3', 'D')],
    });
    g.call('a');
    g.play('a', '7H1');
    expect(g.penalty).toBe(2);
    expect(g.canCall('b')).toBe(true);
    g.call('b');
    g.play('b', '7C1');
    g.pick('c');
    expect(g.stats.get('b')!.missedCalls).toBe(0);
    expect(g.stats.get('a')!.missedCalls).toBe(0);
  });

  it("doesn't catch them when the turn comes straight back with nobody else moving", () => {
    // b has only clubs and the pick limit is 1, so b passes automatically
    const g = table({ a: [c('9', 'H'), c('J', 'H')], b: [c('5', 'C')] }, [c('2', 'H')], 'a', { deck: [c('2', 'C'), c('3', 'D'), c('4', 'D')] });
    const events = g.play('a', '9H1');
    expect(kinds(events)).toEqual(['c7play', 'c7pick', 'c7pass']);
    expect(g.turnId).toBe('a');
    expect(g.atRisk).toBe('a');
    expect(g.canCall('a')).toBe(true);
    // and the last card wins
    expect(kinds(g.play('a', 'JH1'))).toEqual(['c7play', 'finish', 'gameOver']);
  });

  it('tells a caught player it is too late', () => {
    const g = table({ a: [c('9', 'H'), c('J', 'H')], b: [c('5', 'H'), c('6', 'H')], c: [c('4', 'H'), c('K', 'H')] }, [c('2', 'H')], 'a', {
      deck: [c('3', 'D')],
    });
    g.play('a', '9H1');
    g.play('b', '5H1');
    // caught, and the penalty comes on their next turn
    expect(g.missed.has('a')).toBe(true);
    expect(() => g.call('a')).toThrow('Too late, you were caught');
  });
});

describe('crazy 7: ending', () => {
  it('ranks the rest by lowest card value left once someone wins: only the highest value loses', () => {
    // b 5 + 6 + 8 = 19, c K = 13, d Q + J = 23
    const g = table({ a: [c('9', 'H')], b: [c('5', 'C'), c('6', 'C'), c('8', 'C')], c: [c('K', 'S')], d: [c('Q', 'S'), c('J', 'S')] }, [c('2', 'H')], 'a');
    g.called.add('a');
    expect(g.placeOf('a')).toBeNull();
    g.play('a', '9H1');
    expect(['a', 'b', 'c', 'd'].map((id) => g.placeOf(id))).toEqual([1, 3, 2, 4]);
    expect(g.losers()).toEqual(['d']);
    // equal values share a place, and both are last
    const tie = table({ a: [c('9', 'H')], b: [c('5', 'C'), c('6', 'C')], c: [c('4', 'S'), c('7', 'S')] }, [c('2', 'H')], 'a');
    tie.called.add('a');
    tie.play('a', '9H1');
    expect(['a', 'b', 'c'].map((id) => tie.placeOf(id))).toEqual([1, 2, 2]);
    expect(tie.losers()).toEqual(['b', 'c']);
  });

  it('ends the moment someone plays their last card: they win, the highest card value left loses', () => {
    const g = table({ a: [c('9', 'H')], b: [c('5', 'C')], c: [c('K', 'S')] }, [c('2', 'H')], 'a');
    g.called.add('a');
    const events = g.play('a', '9H1');
    expect(kinds(events)).toEqual(['c7play', 'finish', 'gameOver']);
    expect(g.over).toBe(true);
    expect(g.winners()).toEqual(['a']);
    expect(g.losers()).toEqual(['c']);
  });

  it('shuffles the pile back into the deck when it runs out', () => {
    const g = table({ a: [c('9', 'H'), c('2', 'S'), c('5', 'H')], b: [c('5', 'C'), c('6', 'C')] }, [c('3', 'S'), c('4', 'D'), c('2', 'H')], 'a');
    // b matches nothing: the automatic pick needs the pile shuffled in
    const events = g.play('a', '9H1');
    expect(events.find((e) => e.kind === 'c7shuffle')).toEqual({ kind: 'c7shuffle', count: 3 });
    expect(g.pile.map((x) => x.id)).toEqual(['9H1']);
    expect(g.hand('b')).toHaveLength(3);
  });

  it('a walk-out loses; with one player left that player wins. A kick that leaves one stops the game', () => {
    const g = table({ a: [c('9', 'H'), c('2', 'S')], b: [c('5', 'C'), c('6', 'C')] }, [c('3', 'S')], 'a');
    expect(kinds(g.leave('b'))).toEqual(['finish', 'gameOver']);
    expect(g.winners()).toEqual(['a']);
    expect(g.losers()).toEqual(['b']);

    const k = table({ a: [c('9', 'H'), c('2', 'S')], b: [c('5', 'C'), c('6', 'C')] }, [c('3', 'S')], 'a');
    k.removePlayer('b');
    expect(k.aborted).toBe(true);
    expect(k.winners()).toEqual([]);
    expect(k.losers()).toEqual([]);
  });
});

describe('crazy 7 live games: one automatic step at a time', () => {
  it('stops after each automatic step so the room can show it at a human pace', () => {
    const g = table({ a: [c('9', 'H'), c('J', 'S'), c('Q', 'H')], b: [c('5', 'C'), c('Q', 'C')], c: [c('2', 'C'), c('3', 'C')] }, [c('8', 'H')], 'a', {
      deck: [c('4', 'D'), c('6', 'D')],
    });
    const live = Crazy7Game.fromState(g.state());
    Object.defineProperty(live, 'stepwise', { value: true });
    // a's play hands the turn to b, who has nothing for the 9♥: nothing happens yet
    expect(kinds(live.play('a', '9H1'))).toEqual(['c7play']);
    expect(live.turnId).toBe('b');
    expect(live.autoDue).toBe(true);
    expect(live.playable('b')).toEqual([]);
    expect(live.canPick('b')).toBe(false);
    expect(() => live.pick('b')).toThrow('One moment, picking for you');
    // step 1: the automatic pick (6♦, no help)
    expect(kinds(live.stepAuto())).toEqual(['c7pick']);
    expect(live.turnId).toBe('b');
    expect(live.autoDue).toBe(true);
    // step 2: the turn passes by itself, to c, who also has nothing
    expect(kinds(live.stepAuto())).toEqual(['c7pass']);
    expect(live.turnId).toBe('c');
    expect(live.autoDue).toBe(true);
    // c's picked 4♦ doesn't fit either; then a's turn waits for a real choice
    expect(kinds(live.stepAuto())).toEqual(['c7pick']);
    expect(kinds(live.stepAuto())).toEqual(['c7pass']);
    expect(live.turnId).toBe('a');
    expect(live.autoDue).toBe(false);
    expect(live.stepAuto()).toEqual([]);
  });
});

describe('crazy 7 in a room', () => {
  it('only the player on turn gets choices, nobody seated sees another hand, and watchers see every hand', () => {
    const room = new Room('ABCD');
    const host = room.addMember('Asha');
    const ravi = room.addMember('Ravi');
    room.setConfig(host.id, { ...CONFIG });
    room.start(host.id);
    const watcher = room.addMember('Mira');
    expect(watcher.watching).toBe(true);
    const turn = room.c7!.turnId!;
    for (const m of [host, ravi]) {
      const v = room.view(m.id);
      expect(v.crazy7).not.toBe(null);
      expect(v.watch).toBe(null);
      expect(v.hand.map((x) => x.id)).toEqual(room.c7!.hand(m.id).map((x) => x.id));
      expect(JSON.stringify(v)).not.toContain(JSON.stringify(room.c7!.hand(m.id === host.id ? ravi.id : host.id)));
      if (m.id !== turn) expect(v.crazy7!.playable).toEqual([]);
    }
    const w = room.view(watcher.id);
    expect(Object.keys(w.watch!.hands).sort()).toEqual([host.id, ravi.id].sort());
    expect(() => room.endGame(host.id)).toThrow('first player out wins');
  });
});

describe('crazy 7 power cards', () => {
  const POWER = { c7Power: true };
  const play = (events: GameEvent[]) => events.find((e) => e.kind === 'c7play') as Extract<GameEvent, { kind: 'c7play' }>;

  it('J is wild: needs a suit, then only that suit or another J fits; any other card clears the wish', () => {
    const g = table(
      { a: [c('J', 'S'), c('5', 'C'), c('9', 'H')], b: [c('4', 'C'), c('J', 'D'), c('6', 'H')] },
      [c('3', 'D')],
      'a',
      { config: POWER },
    );
    expect(ids(g.playable('a'))).toEqual(['JS1']);
    expect(() => g.play('a', 'JS1')).toThrow('Pick a suit for the J');
    expect(g.turnId).toBe('a');
    expect(play(g.play('a', 'JS1', 'H'))).toMatchObject({ wish: 'H', skipped: null, reversed: false });
    expect(g.wish).toBe('H');
    expect(ids(g.playable('b'))).toEqual(['JD1', '6H1']);
    expect(() => g.play('b', '4C1')).toThrow('Play a heart or a J');
    // a J on a J names a new wish
    g.play('b', 'JD1', 'C');
    expect(g.wish).toBe('C');
    expect(ids(g.playable('a'))).toEqual(['5C1']);
    expect(play(g.play('a', '5C1')).wish).toBe(null);
    expect(g.wish).toBe(null);
  });

  it('8 skips the next player', () => {
    const g = table({ a: [c('8', 'H'), c('K', 'S')], b: [c('9', 'H'), c('2', 'S')], c: [c('5', 'H'), c('4', 'C')] }, [c('5', 'H')], 'a', {
      config: POWER,
    });
    expect(play(g.play('a', '8H1'))).toMatchObject({ skipped: 'b', reversed: false });
    expect(g.turnId).toBe('c');
  });

  it('A turns the direction round; with two players it acts as a skip', () => {
    const g = table(
      { a: [c('A', 'H'), c('K', 'H')], b: [c('9', 'H'), c('2', 'S')], c: [c('5', 'H'), c('4', 'H')] },
      [c('5', 'H')],
      'a',
      { config: POWER },
    );
    expect(play(g.play('a', 'AH1'))).toMatchObject({ reversed: true, skipped: null });
    expect(g.dir).toBe(-1);
    expect(g.turnId).toBe('c');
    g.play('c', '5H1');
    expect(g.turnId).toBe('b');
    // the copy keeps the direction for bots
    expect(Crazy7Game.fromState(g.state()).dir).toBe(-1);

    const duel = table({ a: [c('A', 'H'), c('K', 'H')], b: [c('9', 'H'), c('2', 'S')] }, [c('5', 'H')], 'a', { config: POWER });
    expect(play(duel.play('a', 'AH1'))).toMatchObject({ reversed: true, skipped: 'b' });
    expect(duel.turnId).toBe('a');
  });

  it('2 makes the next player pick 2; 2s and 7s stack on each other', () => {
    const deck = [c('A', 'D'), c('Q', 'D'), c('J', 'D'), c('10', 'D'), c('9', 'D'), c('6', 'D'), c('5', 'D')];
    const g = table(
      { a: [c('2', 'H'), c('K', 'S'), c('3', 'C')], b: [c('7', 'C'), c('5', 'C'), c('6', 'S')], c: [c('2', 'C'), c('4', 'C'), c('9', 'S')] },
      [c('5', 'H')],
      'a',
      { deck, config: POWER },
    );
    g.play('a', '2H1');
    expect(g.penalty).toBe(2);
    expect(ids(g.playable('b'))).toEqual(['7C1']);
    expect(() => g.play('b', '5C1')).toThrow('Play a 7 or a 2 or pick 2 cards');
    g.play('b', '7C1');
    expect(g.penalty).toBe(4);
    expect(g.stats.get('b')!.stacks).toBe(1);
    g.play('c', '2C1');
    expect(g.penalty).toBe(6);
    expect(g.stats.get('c')!.stacks).toBe(1);
    expect(g.pick('a').find((e) => e.kind === 'c7penalty')).toMatchObject({ playerId: 'a', count: 6 });
    expect(g.turnId).toBe('b');
  });

  it('with stacking off, a 2 is picked for the next player who loses the turn', () => {
    const g = table(
      { a: [c('2', 'H'), c('K', 'S')], b: [c('2', 'C'), c('3', 'C')], c: [c('9', 'H'), c('4', 'C')] },
      [c('5', 'H')],
      'a',
      { deck: [c('A', 'D'), c('Q', 'D'), c('10', 'D')], config: { ...POWER, stack7: false } },
    );
    const events = g.play('a', '2H1');
    expect(events.find((e) => e.kind === 'c7penalty')).toMatchObject({ playerId: 'b', count: 2, forced: true });
    expect(g.turnId).toBe('c');
    expect(g.penalty).toBe(0);
  });

  it('a power card as the last card wins straight away', () => {
    const g = table({ a: [c('8', 'H')], b: [c('9', 'H'), c('2', 'S')] }, [c('5', 'H')], 'a', { config: POWER });
    g.called.add('a');
    expect(kinds(g.play('a', '8H1'))).toEqual(['c7play', 'finish', 'gameOver']);
    expect(g.winners()).toEqual(['a']);
  });

  it('skips and reverses in live games too', () => {
    const g = table({ a: [c('8', 'H'), c('K', 'S')], b: [c('9', 'H'), c('2', 'S')], c: [c('3', 'C'), c('4', 'C')] }, [c('5', 'H')], 'a', {
      deck: [c('6', 'D')],
      config: POWER,
    });
    const live = Crazy7Game.fromState(g.state());
    Object.defineProperty(live, 'stepwise', { value: true });
    expect(kinds(live.play('a', '8H1'))).toEqual(['c7play']);
    // b is skipped; c has nothing for the 8♥ and waits for the automatic pick
    expect(live.turnId).toBe('c');
    expect(live.autoDue).toBe(true);
  });

  it('never starts the pile with a power card', () => {
    for (let i = 0; i < 60; i++) {
      const g = new Crazy7Game(['a', 'b', 'c'], { ...CONFIG, ...POWER });
      expect(['7', '2', '8', 'A', 'J']).not.toContain(g.top()!.rank);
      const inHands = [...g.hands.values()].reduce((n, h) => n + h.length, 0);
      expect(inHands + g.deck.length + g.pile.length).toBe(52);
    }
  });

  it('with power off, J, 8, A and 2 are ordinary cards', () => {
    const g = table(
      { a: [c('J', 'S'), c('8', 'H'), c('K', 'C')], b: [c('A', 'H'), c('9', 'S')], c: [c('2', 'H'), c('4', 'C')] },
      [c('5', 'H')],
      'a',
    );
    expect(ids(g.playable('a'))).toEqual(['8H1']);
    expect(g.play('a', '8H1')[0]).toEqual({ kind: 'c7play', playerId: 'a', card: c('8', 'H'), penalty: 0 });
    expect(g.turnId).toBe('b');
    g.play('b', 'AH1');
    expect(g.dir).toBe(1);
    expect(g.turnId).toBe('c');
    g.play('c', '2H1');
    expect(g.penalty).toBe(0);
    expect(g.turnId).toBe('a');
    expect(() => g.play('a', 'JS1')).toThrow('Play a heart or a 2');
  });
});
