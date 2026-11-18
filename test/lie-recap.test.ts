import { describe, expect, it } from 'vitest';
import { Game } from '../src/game.js';
import { Room } from '../src/rooms.js';
import type { Card, GameConfig, Rank, Suit } from '../src/types.js';
import { parseConfig } from '../src/validate.js';

let seq = 0;
const card = (rank: Rank, suit: Suit = 'S'): Card => ({ id: `${rank}${suit}${++seq}`, rank, suit });
const ids = (...cards: Card[]) => cards.map((c) => c.id);
const BLUFF: GameConfig = parseConfig({ decks: 1, bluffRule: 'one' });
const NAMES = (id: string) => ({ a: 'Asha', b: 'Ravi' })[id] ?? '?';

/** a two-player game with these hands, a to move */
function setup(hands: { a: Card[]; b: Card[] }, config: GameConfig = BLUFF) {
  const g = new Game(['a', 'b'], config);
  g.hands.set('a', hands.a);
  g.hands.set('b', hands.b);
  g.turnId = 'a';
  return g;
}

describe('lie reveal', () => {
  it('turns over the lies nobody caught once the game is over, boldest first, with what each player did', () => {
    const [two, three, qh, four, five, six, seven] = [card('2'), card('3'), card('Q', 'H'), card('4'), card('5'), card('6'), card('7')];
    const [qs, jack] = [card('Q'), card('J')];
    const g = setup({ a: [two, three, qh, four, five, six, seven], b: [qs, jack] });

    // caught: two fakes said to be Kings
    g.play('a', ids(two, three), 'K');
    g.callBluff('b', g.lastPlay!.id, 0);
    // b tells the truth, then a slips a fake behind a real Queen and b turns over the real one
    g.play('b', ids(qs), 'Q');
    g.play('a', ids(qh, four));
    g.callBluff('b', g.lastPlay!.id, 0);
    // three fakes said to be Aces, and b lets them go
    g.play('a', ids(five, six, seven), 'A');
    expect(g.lieRecap(NAMES)).toBe(null);
    g.pass('b');
    g.close();

    expect(g.lieRecap(NAMES)).toEqual({
      lies: [
        { playerId: 'a', rank: 'A', cards: [five, six, seven], survivedCall: false },
        { playerId: 'a', rank: 'Q', cards: [qh, four], survivedCall: true },
      ],
      uncaught: 2,
      players: [
        { playerId: 'a', name: 'Asha', plays: 3, lies: 3, caught: 1 },
        { playerId: 'b', name: 'Ravi', plays: 1, lies: 0, caught: 0 },
      ],
    });
  });

  it('shows every play one player made, truths too, and the cards they still held, only once the game is over', () => {
    const [two, three, qh, four, five, six, seven] = [card('2'), card('3'), card('Q', 'H'), card('4'), card('5'), card('6'), card('7')];
    const [qs, jack] = [card('Q'), card('J')];
    const g = setup({ a: [two, three, qh, four, five, six, seven], b: [qs, jack] });
    g.play('a', ids(two, three), 'K');
    g.callBluff('b', g.lastPlay!.id, 0);
    g.play('b', ids(qs), 'Q');
    g.play('a', ids(qh, four));
    g.callBluff('b', g.lastPlay!.id, 0);
    g.play('a', ids(five, six, seven), 'A');
    g.pass('b');
    expect(g.playsOf('a')).toBe(null);
    g.close();

    expect(g.playsOf('a')).toEqual({
      plays: [
        { rank: 'K', cards: [two, three], called: true, caught: true },
        { rank: 'Q', cards: [qh, four], called: true, caught: false },
        { rank: 'A', cards: [five, six, seven], called: false, caught: false },
      ],
      // the caught pair came back to their hand
      hand: expect.arrayContaining([two, three]),
    });
    expect(g.playsOf('a')!.hand).toHaveLength(2);
    expect(g.playsOf('b')).toEqual({
      plays: [{ rank: 'Q', cards: [qs], called: false, caught: false }],
      hand: expect.arrayContaining([jack, qs, qh, four]),
    });
  });

  it('lists the six boldest but counts every lie that got away', () => {
    const fakes = Array.from({ length: 8 }, (_, i) => Array.from({ length: (i % 3) + 1 }, () => card('2')));
    const g = setup({ a: [...fakes.flat(), card('9')], b: [card('K')] });
    for (const play of fakes) {
      g.play('a', ids(...play), 'A');
      // b lets it go, so the round ends and a starts the next
      g.pass('b');
    }
    g.close();
    const recap = g.lieRecap(NAMES)!;
    expect(recap.uncaught).toBe(8);
    expect(recap.lies.map((l) => l.cards.length)).toEqual([3, 3, 2, 2, 2, 1]);
    // ties keep the order they were played in
    expect(recap.lies[0].cards).toEqual(fakes[2]);
    expect(recap.lies[1].cards).toEqual(fakes[5]);
    expect(recap.players[0]).toEqual({ playerId: 'a', name: 'Asha', plays: 8, lies: 8, caught: 0 });
  });

  it('ranks by fake cards only: a lone fake played first stays ahead of a later fake hidden behind a real card', () => {
    const [lone, ace, hidden] = [card('2'), card('A', 'H'), card('3')];
    const g = setup({ a: [lone, ace, hidden, card('9')], b: [card('K')] });
    g.play('a', ids(lone), 'A');
    g.pass('b');
    g.play('a', ids(ace, hidden), 'A');
    g.pass('b');
    g.close();
    expect(g.lieRecap(NAMES)!.lies.map((l) => l.cards)).toEqual([[lone], [ace, hidden]]);
  });

  it('reaches every view only at game over, unless the host keeps lies secret, and never in Crazy 7', () => {
    const play = (config: GameConfig) => {
      const r = new Room('LIES');
      const [asha, ravi] = [r.addMember('Asha'), r.addMember('Ravi')];
      r.setConfig(asha.id, config);
      r.start(asha.id);
      const watcher = r.addMember('Mira');
      const g = r.game!;
      g.hands.set(asha.id, [card('2')]);
      g.hands.set(ravi.id, [card('3'), card('4')]);
      g.turnId = asha.id;
      // Asha goes out on a lie nobody calls
      g.play(asha.id, [g.hand(asha.id)[0].id], 'K');
      const during = [asha, ravi, watcher].map((m) => r.view(m.id).lieRecap);
      let duringPlays = '';
      try {
        r.playsOf(asha.id);
      } catch (err) {
        duringPlays = (err as Error).message;
      }
      g.pass(ravi.id);
      expect(r.phase).toBe('over');
      return { during, duringPlays, after: [asha, ravi, watcher].map((m) => r.view(m.id).lieRecap), r, asha, ravi, watcher };
    };

    const shown = play(BLUFF);
    expect(shown.during).toEqual([null, null, null]);
    expect(shown.duringPlays).toBe('The cards are shown once the game is over');
    // each player's plays and what they still held, for anyone in the room once it's over
    expect(shown.r.playsOf(shown.asha.id)).toEqual({ plays: [{ rank: 'K', cards: [expect.objectContaining({ rank: '2' })], called: false, caught: false }], hand: [] });
    expect(shown.r.playsOf(shown.ravi.id).hand.map((c) => c.rank).sort()).toEqual(['3', '4']);
    expect(() => shown.r.playsOf(shown.watcher.id)).toThrow('They were not in this game');
    for (const recap of shown.after) {
      expect(recap!.lies).toEqual([{ playerId: shown.asha.id, rank: 'K', cards: [expect.objectContaining({ rank: '2' })], survivedCall: false }]);
      expect(recap!.uncaught).toBe(1);
      expect(recap!.players.map((p) => p.name)).toEqual(['Asha', 'Ravi']);
    }
    // someone who leaves the room after the game keeps their name on everyone else's screen
    shown.r.removeMember(shown.asha.id);
    expect(shown.r.view(shown.ravi.id).lieRecap!.players.map((p) => p.name)).toEqual(['Asha', 'Ravi']);

    const secret = play({ ...BLUFF, secretLies: true });
    expect(secret.after).toEqual([null, null, null]);
    expect(() => secret.r.playsOf(secret.asha.id)).toThrow('Lies are kept secret in this room');

    const c7 = new Room('SEVN');
    const host = c7.addMember('Asha');
    c7.addMember('Ravi');
    c7.setConfig(host.id, { ...BLUFF, game: 'crazy7' });
    c7.start(host.id);
    expect(c7.view(host.id).lieRecap).toBe(null);
    expect(() => c7.playsOf(host.id)).toThrow('The cards are shown once the game is over');
  });

  it('reads the setting from what apps send', () => {
    expect(parseConfig({ decks: 1, bluffRule: 'one' }).secretLies).toBe(false);
    expect(parseConfig({ decks: 1, bluffRule: 'one', secretLies: true }).secretLies).toBe(true);
    expect(() => parseConfig({ decks: 1, bluffRule: 'one', secretLies: 1 })).toThrow('Invalid settings');
  });
});
