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
  it('ends the moment someone plays their last card: they win, everyone else loses', () => {
    const g = table({ a: [c('9', 'H')], b: [c('5', 'C')], c: [c('K', 'S')] }, [c('2', 'H')], 'a');
    g.called.add('a');
    const events = g.play('a', '9H1');
    expect(kinds(events)).toEqual(['c7play', 'finish', 'gameOver']);
    expect(g.over).toBe(true);
    expect(g.winners()).toEqual(['a']);
    expect(g.losers()).toEqual(['b', 'c']);
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
