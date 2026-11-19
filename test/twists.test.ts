import { describe, expect, it } from 'vitest';
import { Game } from '../src/game.js';
import { emptyHabits, notePlay } from '../src/habits.js';
import { Room } from '../src/rooms.js';
import { backsClaim, claimsAllowed, RANKS, seedhiClaims, type Card, type GameConfig, type Rank, type Suit } from '../src/types.js';
import { parseConfig } from '../src/validate.js';

let seq = 0;
const card = (rank: Rank, suit: Suit = 'S'): Card => ({ id: `${rank}${suit}${++seq}`, rank, suit });
const ids = (...cards: Card[]) => cards.map((c) => c.id);
/** the last choice every time: shuffles keep their order and the Kismat card is K (the last rank) */
const last = (max: number) => max - 1;

function setup(players: string[], hands: Record<string, Card[]>, config: Partial<GameConfig> = {}) {
  const game = new Game(players, { ...parseConfig({ decks: 1, bluffRule: 'all' }), ...config }, last);
  for (const p of players) game.hands.set(p, hands[p] ?? []);
  game.turnId = players[0];
  return game;
}

describe('the twists in the settings', () => {
  it('are off unless the host turns them on; older apps leave them off', () => {
    expect(parseConfig({ decks: 1, bluffRule: 'one' })).toMatchObject({ kismat: false, seedhi: false });
    expect(parseConfig({ decks: 1, bluffRule: 'one', kismat: true, seedhi: true })).toMatchObject({ kismat: true, seedhi: true });
    expect(() => parseConfig({ decks: 1, bluffRule: 'one', seedhi: 1 })).toThrow('Invalid settings');
    expect(new Room('TWST').config).toMatchObject({ kismat: false, seedhi: false });
  });
});

describe('the Kismat card', () => {
  it('is drawn at the deal only when it is on, without changing the deal', () => {
    const plain = new Game(['a', 'b', 'c'], parseConfig({ decks: 1, bluffRule: 'all' }), last);
    const lucky = new Game(['a', 'b', 'c'], parseConfig({ decks: 1, bluffRule: 'all', kismat: true }), last);
    expect(plain.kismat).toBe(null);
    expect(lucky.kismat).toBe('K');
    expect(lucky.turnId).toBe(plain.turnId);
    expect(['a', 'b', 'c'].map((p) => ids(...lucky.hand(p)))).toEqual(['a', 'b', 'c'].map((p) => ids(...plain.hand(p))));
    const seen = new Set(Array.from({ length: 13 }, (_, i) => new Game(['a', 'b'], parseConfig({ decks: 1, bluffRule: 'all', kismat: true }), (max) => (max === 13 ? i : 0)).kismat));
    expect(seen).toEqual(new Set(RANKS));
  });

  it('backs up any claim: a play with Kismat cards is the truth, and calling it is wrong', () => {
    const [k1, q1, two] = [card('K'), card('Q', 'H'), card('2')];
    const g = setup(['a', 'b'], { a: [k1, q1, two, card('3')], b: [card('5'), card('6')] }, { kismat: true });
    g.play('a', ids(k1, q1), 'Q');
    const events = g.callBluff('b', g.lastPlay!.id);
    expect(events[0]).toMatchObject({ kind: 'bluff', bluff: false, loserId: 'b' });
    expect(g.stats.get('a')!.bluffs).toBe(0);
    // a 2 with them is still a lie
    g.turnId = 'a';
    g.play('a', ids(two), 'Q');
    expect(g.callBluff('b', g.lastPlay!.id)[0]).toMatchObject({ bluff: true, loserId: 'a' });
  });

  it('is checked one card at a time under "pick one", and can be claimed as itself', () => {
    const [k1, k2, five] = [card('K'), card('K', 'H'), card('5')];
    const g = setup(['a', 'b'], { a: [k1, five, k2, card('9')], b: [card('3'), card('4')] }, { kismat: true, bluffRule: 'one' });
    g.play('a', ids(k1, five), '7');
    expect(g.callBluff('b', g.lastPlay!.id, 0)[0]).toMatchObject({ bluff: false });
    g.turnId = 'a';
    g.play('a', ids(k2), 'K');
    expect(g.callBluff('b', g.lastPlay!.id, 0)[0]).toMatchObject({ bluff: false });
  });

  it('keeps lies that only hid Kismat cards out of the lie reveal and secret cards', () => {
    const [k1, two] = [card('K'), card('2')];
    const g = setup(['a', 'b'], { a: [k1, two], b: [card('3'), card('4'), card('5')] }, { kismat: true });
    g.play('a', ids(k1), 'J');
    g.pass('b');
    g.play('a', ids(two), 'J');
    expect(g.playLogOf('a').map((p) => p.lie)).toEqual([false, true]);
    g.pass('b');
    expect(g.over).toBe(true);
    const recap = g.lieRecap((id) => id)!;
    expect(recap.uncaught).toBe(1);
    expect(recap.lies.map((l) => l.cards)).toEqual([[two]]);
  });

  it('counts as real cards in what the bots learn about people', () => {
    const h = emptyHabits();
    const [k1, q1] = [card('K'), card('Q')];
    notePlay(h, [k1, q1, card('2')], [k1, q1], 'Q', { opening: true, before: 0, copies: 8 }, 'K');
    expect(h).toMatchObject({ lies: 0, openLies: 0 });
    notePlay(h, [k1, q1, card('2')], [k1, q1], 'Q', { opening: true, before: 0, copies: 4 });
    expect(h).toMatchObject({ lies: 1, openLies: 1 });
  });

  it('is shown to everyone at the table', () => {
    const r = new Room('KISM');
    const [asha, ravi] = [r.addMember('Asha'), r.addMember('Ravi')];
    r.setConfig(asha.id, parseConfig({ decks: 1, bluffRule: 'one', kismat: true }));
    expect(r.view(asha.id).kismat).toBe(null);
    // an app from before the twists can't show them, so the game waits for it to update
    expect(() => r.start(asha.id)).toThrow('Asha, Ravi must update the app (reload it) to play with twists');
    asha.hasTwists = ravi.hasTwists = true;
    r.start(asha.id);
    const kismat = r.game!.kismat;
    expect(RANKS).toContain(kismat);
    expect(r.view(ravi.id).kismat).toBe(kismat);
  });

  it('asks everyone to say they are ready again when a twist changes', () => {
    const r = new Room('RDY2');
    const [asha, ravi] = [r.addMember('Asha'), r.addMember('Ravi')];
    ravi.hasReady = true;
    r.setReady(ravi.id, true);
    expect(r.setConfig(asha.id, parseConfig({ decks: 1, bluffRule: 'one', seedhi: true })).readyAgain).toBe(true);
    expect(ravi.ready).toBe(false);
  });

  it('is a card in the shared rules too', () => {
    expect(backsClaim(card('K'), 'Q', 'K')).toBe(true);
    expect(backsClaim(card('K'), 'Q', null)).toBe(false);
    expect(backsClaim(card('Q'), 'Q', 'K')).toBe(true);
    expect(backsClaim(card('2'), 'Q', 'K')).toBe(false);
  });
});

describe('Seedhi', () => {
  it('lets the next claim be one below, the same or one above, with A and K wrapping round', () => {
    expect(seedhiClaims('7')).toEqual(['6', '7', '8']);
    expect(seedhiClaims('A')).toEqual(['K', 'A', '2']);
    expect(seedhiClaims('K')).toEqual(['Q', 'K', 'A']);
    expect(claimsAllowed(null, true)).toEqual(RANKS);
    expect(claimsAllowed('7', false)).toEqual(['7']);
    expect(claimsAllowed('7', true)).toEqual(['6', '7', '8']);
  });

  it('moves the round along with each claim, and a call or a cleared pile opens it again', () => {
    const hand = () => [card('2'), card('3'), card('4'), card('5'), card('6'), card('7')];
    const g = setup(['a', 'b'], { a: hand(), b: hand() }, { seedhi: true });
    const one = (p: string) => ids(g.hand(p)[0]);
    g.play('a', one('a'), '7');
    expect(() => g.play('b', one('b'), '9')).toThrow('Claim 6, 7, 8 this time');
    g.play('b', one('b'), '8');
    expect(g.roundRank).toBe('8');
    g.play('a', one('a'), '9');
    // following without a rank (an older app): the same rank
    g.play('b', one('b'));
    expect(g.lastPlay!.rank).toBe('9');
    g.callBluff('a', g.lastPlay!.id);
    expect(g.roundRank).toBe(null);
    g.turnId = 'a';
    g.play('a', one('a'), 'K');
    g.play('b', one('b'), 'A');
    g.pass('a');
    expect(g.roundRank).toBe(null);
  });

  it('is off by default: the round keeps its rank', () => {
    const g = setup(['a', 'b'], { a: [card('2'), card('3')], b: [card('4'), card('5')] });
    g.play('a', ids(g.hand('a')[0]), '7');
    expect(() => g.play('b', ids(g.hand('b')[0]), '8')).toThrow('This round is 7');
    g.play('b', ids(g.hand('b')[0]), '7');
  });
});
