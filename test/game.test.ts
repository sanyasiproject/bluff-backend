import { describe, expect, it } from 'vitest';
import { computeAwards } from '../src/awards.js';
import { Game } from '../src/game.js';
import type { Card, GameConfig, Rank, Suit } from '../src/types.js';

let seq = 0;
const card = (rank: Rank, suit: Suit = 'S'): Card => ({ id: `${rank}${suit}${++seq}`, rank, suit });
const ids = (...cards: Card[]) => cards.map((c) => c.id);

/** j = i in Fisher-Yates, so shuffles keep their order and tests stay predictable */
const keepOrder = (max: number) => max - 1;

function setup(players: string[], hands: Record<string, Card[]>, config: Partial<GameConfig> = {}) {
  const game = new Game(players, { decks: 1, bluffRule: 'all', ...config }, keepOrder);
  for (const p of players) game.hands.set(p, hands[p] ?? []);
  game.turnId = players[0];
  return game;
}

describe('dealing', () => {
  it('deals all 52 cards, extras going to the first seats', () => {
    const players = ['a', 'b', 'c', 'd', 'e'];
    const g = new Game(players, { decks: 1, bluffRule: 'all' });
    expect(players.map((p) => g.hand(p).length)).toEqual([11, 11, 10, 10, 10]);
    expect(new Set([...g.hands.values()].flat().map((c) => c.id)).size).toBe(52);
    expect(players).toContain(g.turnId);
  });

  it('deals 104 cards with two decks', () => {
    const g = new Game(['a', 'b', 'c'], { decks: 2, bluffRule: 'one' });
    expect(['a', 'b', 'c'].map((p) => g.hand(p).length)).toEqual([35, 35, 34]);
    expect(new Set([...g.hands.values()].flat().map((c) => c.id)).size).toBe(104);
  });

  it('needs 2 to 5 players', () => {
    expect(() => new Game(['a'], { decks: 1, bluffRule: 'all' })).toThrow('Need 2 to 5 players');
    expect(() => new Game(['a', 'b', 'c', 'd', 'e', 'f'], { decks: 1, bluffRule: 'all' })).toThrow('Need 2 to 5');
  });
});

describe('turns', () => {
  it('first play of a round sets the rank and passes the turn on', () => {
    const [q1, q2, k] = [card('Q'), card('Q', 'H'), card('K')];
    const g = setup(['a', 'b', 'c'], { a: [q1, q2, k], b: [card('2')], c: [card('3')] });
    expect(() => g.play('a', ids(q1))).toThrow('Choose a rank');
    expect(g.play('a', ids(q1, q2), 'Q')).toEqual([{ kind: 'play', playerId: 'a', count: 2, rank: 'Q' }]);
    expect(g.roundRank).toBe('Q');
    expect(g.pile).toHaveLength(2);
    expect(g.hand('a')).toEqual([k]);
    expect(g.turnId).toBe('b');
  });

  it('rejects invalid moves', () => {
    const a = [card('A'), card('2'), card('3'), card('4'), card('5')];
    const b1 = card('K');
    const g = setup(['a', 'b'], { a, b: [b1, card('9')] });
    expect(() => g.play('b', ids(b1), 'K')).toThrow('Not your turn');
    expect(() => g.pass('a')).toThrow('You start this round');
    expect(() => g.play('a', ['nope'], 'A')).toThrow('do not have');
    expect(() => g.play('a', [], 'A')).toThrow('at least 1 card');
    expect(() => g.play('a', ids(a[0], a[0]), 'A')).toThrow('only be played once');
    g.play('a', ids(a[0]), 'A');
    expect(() => g.play('b', ids(b1), 'K')).toThrow('This round is A');
  });

  it('allows any number of cards and keeps the order they were tapped', () => {
    const hand = [card('A'), card('2'), card('3'), card('4'), card('5'), card('6'), card('7')];
    const g = setup(['a', 'b'], { a: [...hand, card('K')], b: [card('9')] });
    const tapped = [hand[4], hand[0], hand[6], hand[2], hand[1], hand[5], hand[3]];
    expect(g.play('a', ids(...tapped), '7')).toEqual([{ kind: 'play', playerId: 'a', count: 7, rank: '7' }]);
    expect(g.lastPlay!.cards).toEqual(tapped);
    expect(g.pile).toEqual(tapped);
    expect(g.hand('a').map((c) => c.rank)).toEqual(['K']);
  });

  it('when everyone else passes the pile is discarded and the last player starts', () => {
    const a1 = card('7');
    const g = setup(['a', 'b', 'c'], { a: [a1, card('8')], b: [card('2')], c: [card('3')] });
    g.play('a', ids(a1), '7');
    expect(g.pass('b')).toEqual([{ kind: 'pass', playerId: 'b' }]);
    expect(g.pass('c')).toEqual([
      { kind: 'pass', playerId: 'c' },
      { kind: 'roundEnd', starterId: 'a', discarded: 1 },
    ]);
    expect(g.pile).toEqual([]);
    expect(g.roundRank).toBeNull();
    expect(g.turnId).toBe('a');
  });

  it('a new play resets the passes', () => {
    const [b1, a2] = [card('2'), card('4')];
    const g = setup(['a', 'b', 'c'], { a: [card('3'), a2], b: [b1, card('5')], c: [card('6')] });
    g.play('a', ids(g.hand('a')[0]), '3');
    g.play('b', ids(b1));
    expect(g.passed.size).toBe(0);
    g.pass('c');
    g.play('a', ids(a2));
    expect(g.passed.size).toBe(0);
    expect(g.turnId).toBe('b');
  });
});

describe('bluff rule: check all cards', () => {
  it('a caught liar picks up the whole pile and the caller starts', () => {
    const [q, five] = [card('Q'), card('5')];
    const g = setup(['a', 'b', 'c'], { a: [q, five, card('9')], b: [card('2')], c: [card('3')] });
    g.play('a', ids(q, five), 'Q');
    const events = g.callBluff('c', g.lastPlay!.id);
    expect(events).toEqual([
      { kind: 'bluff', callerId: 'c', playerId: 'a', bluff: true, loserId: 'a', pileCount: 2 },
      { kind: 'newRound', starterId: 'c' },
    ]);
    expect(g.hand('a')).toHaveLength(3);
    expect(g.reveal?.cards).toEqual([q, five]);
    expect(g.turnId).toBe('c');
    expect(g.lastPlay).toBeNull();
  });

  it('a wrong call makes the caller pick up', () => {
    const [q1, q2] = [card('Q'), card('Q', 'D')];
    const g = setup(['a', 'b'], { a: [q1, q2, card('9')], b: [card('2')] });
    g.play('a', ids(q1, q2), 'Q');
    g.callBluff('b', g.lastPlay!.id);
    expect(g.hand('b')).toHaveLength(3);
    expect(g.reveal?.bluff).toBe(false);
    expect(g.turnId).toBe('a');
  });

  it('rejects stale and self calls', () => {
    const [a1, b1] = [card('Q'), card('K')];
    const g = setup(['a', 'b', 'c'], { a: [a1, card('9')], b: [b1, card('8')], c: [card('3')] });
    g.play('a', ids(a1), 'Q');
    const first = g.lastPlay!.id;
    expect(() => g.callBluff('a', first)).toThrow('yourself');
    g.play('b', ids(b1));
    expect(() => g.callBluff('c', first)).toThrow('Too late');
  });
});

describe('bluff rule: caller picks one card', () => {
  it('only the picked card decides', () => {
    const [q, five] = [card('Q'), card('5')];
    const g = setup(['a', 'b'], { a: [q, five, card('9')], b: [card('2')] }, { bluffRule: 'one' });
    g.play('a', ids(q, five), 'Q');
    expect(() => g.callBluff('b', g.lastPlay!.id)).toThrow('Pick one');
    expect(() => g.callBluff('b', g.lastPlay!.id, 2)).toThrow('Pick one');
    g.callBluff('b', g.lastPlay!.id, 0);
    expect(g.reveal).toMatchObject({ bluff: false, loserId: 'b', pickedIndex: 0, cards: [q, null] });
  });

  it('card positions follow the order the player tapped', () => {
    const [q, five] = [card('Q'), card('5')];
    const g = setup(['a', 'b'], { a: [q, five, card('9')], b: [card('2')] }, { bluffRule: 'one' });
    g.play('a', ids(five, q), 'Q');
    g.callBluff('b', g.lastPlay!.id, 0);
    expect(g.reveal).toMatchObject({ bluff: true, loserId: 'a', pickedIndex: 0, cards: [five, null] });
  });

  it('picking the lie catches the bluffer', () => {
    const [q, five] = [card('Q'), card('5')];
    const g = setup(['a', 'b'], { a: [q, five, card('9')], b: [card('2')] }, { bluffRule: 'one' });
    g.play('a', ids(q, five), 'Q');
    g.callBluff('b', g.lastPlay!.id, 1);
    expect(g.reveal).toMatchObject({ bluff: true, loserId: 'a', cards: [null, five] });
    expect(g.hand('a')).toHaveLength(3);
  });
});

describe('end-of-game awards', () => {
  it('counts bluffs, calls and pickups', () => {
    const [q, five, k1, k2] = [card('Q'), card('5'), card('K'), card('K', 'H')];
    const g = setup(['a', 'b', 'c'], { a: [q, five, card('9')], b: [k1, k2, card('8')], c: [card('3'), card('4')] });
    g.play('a', ids(five), 'Q');
    g.callBluff('b', g.lastPlay!.id);
    g.play('b', ids(k1, k2), 'K');
    g.callBluff('c', g.lastPlay!.id);
    expect(g.stats.get('a')).toEqual({ bluffs: 1, caught: 1, goodCalls: 0, wrongCalls: 0, pickedUp: 1 });
    expect(g.stats.get('b')).toEqual({ bluffs: 0, caught: 0, goodCalls: 1, wrongCalls: 0, pickedUp: 0 });
    expect(g.stats.get('c')).toEqual({ bluffs: 0, caught: 0, goodCalls: 0, wrongCalls: 1, pickedUp: 2 });
    expect(computeAwards(g.stats)).toEqual([
      { emoji: '🤥', title: 'Biggest liar', playerIds: ['a'], detail: '1 bluff' },
      { emoji: '🕵️', title: 'Best detective', playerIds: ['b'], detail: 'caught 1 bluff' },
      { emoji: '🙈', title: 'Trust issues', playerIds: ['c'], detail: '1 wrong call' },
      { emoji: '🧲', title: 'Card collector', playerIds: ['c'], detail: 'picked up 2 cards' },
    ]);
  });

  it('shares an award on a tie and credits bluffs nobody caught', () => {
    const [a5, b5] = [card('5'), card('5', 'H')];
    const g = setup(['a', 'b', 'c'], { a: [a5, card('9')], b: [b5, card('8')], c: [card('3')] });
    g.play('a', ids(a5), 'Q');
    g.play('b', ids(b5));
    const liar = computeAwards(g.stats).find((x) => x.title === 'Biggest liar');
    const smooth = computeAwards(g.stats).find((x) => x.title === 'Smoothest liar');
    expect(liar).toMatchObject({ playerIds: ['a', 'b'], detail: '1 bluff' });
    expect(smooth).toMatchObject({ playerIds: ['a', 'b'], detail: '1 bluff never caught' });
  });
});

describe('finishing', () => {
  it('a player who empties their hand finishes once the next player moves', () => {
    const [q, b1] = [card('Q'), card('2')];
    const g = setup(['a', 'b', 'c'], { a: [q], b: [b1, card('3')], c: [card('4')] });
    g.play('a', ids(q), 'Q');
    expect(g.places).toEqual([]);
    expect(g.turnId).toBe('b');
    expect(g.play('b', ids(b1))).toEqual([
      { kind: 'finish', playerId: 'a', place: 1 },
      { kind: 'play', playerId: 'b', count: 1, rank: 'Q' },
    ]);
    expect(g.turnId).toBe('c');
  });

  it('with two players the game ends and the other player loses', () => {
    const q = card('Q');
    const g = setup(['a', 'b'], { a: [q], b: [card('2')] });
    g.play('a', ids(q), 'Q');
    expect(g.pass('b')).toEqual([
      { kind: 'pass', playerId: 'b' },
      { kind: 'finish', playerId: 'a', place: 1 },
      { kind: 'gameOver', loserId: 'b' },
    ]);
    expect(g.over).toBe(true);
    expect(g.turnId).toBeNull();
    expect(() => g.pass('b')).toThrow('Game is over');
  });

  it('getting caught on the last cards puts the player back in', () => {
    const five = card('5');
    const g = setup(['a', 'b', 'c'], { a: [five], b: [card('2')], c: [card('3')] });
    g.play('a', ids(five), 'Q');
    g.callBluff('b', g.lastPlay!.id);
    expect(g.places).toEqual([]);
    expect(g.hand('a')).toEqual([five]);
    expect(g.turnId).toBe('b');
  });

  it('a true last play survives the call and the player finishes', () => {
    const q = card('Q');
    const g = setup(['a', 'b', 'c'], { a: [q], b: [card('2')], c: [card('3')] });
    g.play('a', ids(q), 'Q');
    const events = g.callBluff('c', g.lastPlay!.id);
    expect(events.map((e) => e.kind)).toEqual(['bluff', 'finish', 'newRound']);
    expect(g.places).toEqual(['a']);
    expect(g.turnId).toBe('b');
  });

  it('keeps going until one player is left holding cards', () => {
    const [q, k] = [card('Q'), card('K')];
    const g = setup(['a', 'b', 'c'], { a: [q], b: [k], c: [card('2'), card('3')] });
    g.play('a', ids(q), 'Q');
    g.play('b', ids(k));
    expect(g.places).toEqual(['a']);
    expect(g.turnId).toBe('c');
    const events = g.pass('c');
    expect(events.map((e) => e.kind)).toEqual(['pass', 'finish', 'gameOver']);
    expect(g.places).toEqual(['a', 'b']);
    expect(g.loserId).toBe('c');
  });
});
