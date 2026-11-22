import { describe, expect, it } from 'vitest';
import { buildRangDeck, RangGame, type RangState } from '../src/rang/game.js';
import { GameError } from '../src/game.js';
import type { GameEvent } from '../src/models.js';
import { RANG_COLORS, rangHandPoints, type GameConfig, type RangCard, type RangColor, type RangValue } from '../src/types.js';

const CONFIG = {
  game: 'rang',
  decks: 1,
  bluffRule: 'one',
  stake: 0,
  peeks: 0,
  bets: false,
  teams: false,
  handSize: 7,
  maxPicks: 1,
  stack7: true,
  rangPicks: 1,
  rangStack: true,
  rangChallenge: true,
  rangSwap: false,
} as unknown as GameConfig;

const ID = /^rg-(?:red|blue|green|yellow|w)-(?:[0-9]|skip|reverse|draw2|wild|wild4)-[1-4]$/;

const rc = (color: RangColor, value: RangValue, d = 1): RangCard => ({ id: `rg-${color}-${value}-${d}`, color, value });
const w = (value: 'wild' | 'wild4', d = 1): RangCard => ({ id: `rg-w-${value}-${d}`, color: null, value });

/** a small seeded generator, so random games repeat */
function seeded(seed: number): (max: number) => number {
  let a = seed >>> 0;
  return (max) => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * max);
  };
}

/** a game in a chosen position; the deck is picked from its end */
function table(
  hands: Record<string, RangCard[]>,
  pile: RangCard[],
  turn: string,
  opts: { deck?: RangCard[]; config?: Partial<GameConfig>; color?: RangColor; penalty?: number; stepwise?: boolean; state?: Partial<RangState> } = {},
) {
  return RangGame.fromState(
    {
      order: Object.keys(hands),
      config: { ...CONFIG, ...opts.config },
      hands: new Map(Object.entries(hands).map(([id, cards]) => [id, [...cards]])),
      deck: opts.deck ?? [],
      pile,
      turnId: turn,
      penalty: opts.penalty ?? 0,
      picks: 0,
      picked: [],
      called: new Set(),
      missed: new Set(),
      atRisk: null,
      over: false,
      places: [],
      color: opts.color ?? pile[pile.length - 1]?.color ?? 'red',
      dir: 1,
      topBy: null,
      challengeable: null,
      ...opts.state,
    },
    seeded(1),
    opts.stepwise ?? false,
  );
}

const kinds = (events: GameEvent[]) => events.map((e) => e.kind);
const ids = (cards: RangCard[]) => cards.map((x) => x.id);
const count = (g: RangGame) => [...g.hands.values()].reduce((n, h) => n + h.length, 0) + g.deck.length + g.pile.length;

describe('rang: deck and deal', () => {
  it('builds 108 cards with unique ids in the agreed format', () => {
    const deck = buildRangDeck();
    expect(deck).toHaveLength(108);
    expect(new Set(ids(deck)).size).toBe(108);
    for (const card of deck) expect(card.id).toMatch(ID);
    for (const color of RANG_COLORS) {
      const mine = deck.filter((c) => c.color === color);
      expect(mine).toHaveLength(25);
      expect(mine.filter((c) => c.value === '0')).toHaveLength(1);
      for (const v of ['1', '9', 'skip', 'reverse', 'draw2'] as const) expect(mine.filter((c) => c.value === v)).toHaveLength(2);
    }
    expect(deck.filter((c) => c.value === 'wild')).toHaveLength(4);
    expect(deck.filter((c) => c.value === 'wild4')).toHaveLength(4);
    expect(deck.filter((c) => c.value === 'wild4').every((c) => c.color === null)).toBe(true);
  });

  it('deals 7 each, starts on a number card, takes its colour and sorts hands', () => {
    const starters = new Set<string>();
    for (let seed = 1; seed <= 60; seed++) {
      const g = new RangGame(['a', 'b', 'c'], CONFIG, seeded(seed), true, true);
      for (const id of g.order) expect(g.hand(id)).toHaveLength(7);
      const top = g.top()!;
      expect(top.value).toMatch(/^[0-9]$/);
      expect(g.color).toBe(top.color);
      expect(g.pile).toHaveLength(1);
      expect(count(g)).toBe(108);
      expect(g.turnId).not.toBeNull();
      starters.add(g.turnId!);
      for (const id of g.order) {
        const h = g.hand(id);
        const key = (c: RangCard) => (c.color ? RANG_COLORS.indexOf(c.color) : 4);
        for (let i = 1; i < h.length; i++) expect(key(h[i - 1])).toBeLessThanOrEqual(key(h[i]));
      }
    }
    expect(starters.size).toBe(3);
    expect(() => new RangGame(['a'], CONFIG)).toThrow(GameError);
  });
});

describe('rang: matching', () => {
  it('takes the same colour or the same value, or a wild', () => {
    const g = table({ a: [rc('red', '9'), rc('blue', '5'), rc('green', '3'), w('wild')], b: [rc('blue', '1'), rc('red', '2')] }, [rc('red', '5')], 'a');
    expect(ids(g.playable('a'))).toEqual(['rg-red-9-1', 'rg-blue-5-1', 'rg-w-wild-1']);
    expect(() => g.play('a', 'rg-green-3-1')).toThrow('Play a red card, a 5 or a wild');
    expect(() => g.play('b', 'rg-red-1-1')).toThrow('Not your turn');
    expect(kinds(g.play('a', 'rg-blue-5-1'))).toEqual(['rgplay']);
    expect(g.color).toBe('blue');
    expect(g.turnId).toBe('b');
    expect(g.stats.get('a')!.plays).toBe(1);
  });

  it('after a wild only the named colour (or another wild) fits, not the value', () => {
    const g = table({ a: [rc('blue', '2'), rc('red', '2'), w('wild', 2)], b: [rc('red', '1')] }, [w('wild')], 'a', { color: 'blue' });
    expect(ids(g.playable('a'))).toEqual(['rg-blue-2-1', 'rg-w-wild-2']);
  });

  it('a wild needs a colour and sets it', () => {
    const g = table({ a: [w('wild'), rc('red', '1')], b: [rc('yellow', '4'), rc('red', '4')] }, [rc('green', '5')], 'a');
    expect(() => g.play('a', 'rg-w-wild-1')).toThrow('Pick a colour');
    expect(() => g.play('a', 'rg-w-wild-1', { color: 'pink' as RangColor })).toThrow('Pick a colour');
    const events = g.play('a', 'rg-w-wild-1', { color: 'yellow' });
    expect(events[0]).toMatchObject({ kind: 'rgplay', color: 'yellow', penalty: 0 });
    expect(g.color).toBe('yellow');
    expect(g.last).toMatchObject({ kind: 'play', playerId: 'a', color: 'yellow' });
    expect(ids(g.playable('b'))).toEqual(['rg-yellow-4-1']);
  });
});

describe('rang: action cards', () => {
  const three = () => ({
    a: [rc('red', 'skip'), rc('red', 'reverse'), rc('red', '1')],
    b: [rc('red', '2'), rc('red', '3')],
    c: [rc('red', '4'), rc('red', '6')],
  });

  it('a Skip passes over the next player', () => {
    const g = table(three(), [rc('red', '5')], 'a');
    const events = g.play('a', 'rg-red-skip-1');
    expect(events[0]).toMatchObject({ kind: 'rgplay', skipped: 'b' });
    expect(g.turnId).toBe('c');
    expect(g.last).toMatchObject({ kind: 'play', targetId: 'b' });
  });

  it('a Reverse turns the direction', () => {
    const g = table(three(), [rc('red', '5')], 'a');
    expect(g.play('a', 'rg-red-reverse-1')[0]).toMatchObject({ kind: 'rgplay', reversed: true });
    expect(g.dir).toBe(-1);
    expect(g.turnId).toBe('c');
    g.play('c', 'rg-red-4-1');
    expect(g.turnId).toBe('b');
  });

  it('with two players a Reverse acts as a Skip', () => {
    const g = table({ a: [rc('red', 'reverse'), rc('red', '1')], b: [rc('red', '2'), rc('red', '3')] }, [rc('red', '5')], 'a');
    const seq = g.turnSeq;
    expect(g.play('a', 'rg-red-reverse-1')[0]).toMatchObject({ kind: 'rgplay', reversed: true, skipped: 'b' });
    expect(g.turnId).toBe('a');
    expect(g.turnSeq).toBe(seq + 1);
  });
});

describe('rang: +2 and +4', () => {
  const deck = () => [rc('green', '1'), rc('green', '2'), rc('green', '3'), rc('green', '4'), rc('green', '5'), rc('green', '6'), rc('green', '7'), rc('green', '8')];

  it('without stacking the next player picks 2 and loses the turn', () => {
    const g = table(
      { a: [rc('red', 'draw2'), rc('red', '1')], b: [rc('blue', 'draw2'), rc('red', '3')], c: [rc('red', '4'), rc('red', '6')] },
      [rc('red', '5')],
      'a',
      { deck: deck(), config: { rangStack: false } },
    );
    const events = g.play('a', 'rg-red-draw2-1');
    expect(events.find((e) => e.kind === 'rgpenalty')).toMatchObject({ playerId: 'b', count: 2, forced: true, missed: false });
    expect(g.hand('b')).toHaveLength(4);
    expect(g.turnId).toBe('c');
    expect(g.penalty).toBe(0);
  });

  it('without stacking a live game takes the penalty as an automatic step', () => {
    const g = table({ a: [rc('red', 'draw2'), rc('red', '1')], b: [rc('blue', 'draw2'), rc('red', '3')] }, [rc('red', '5')], 'a', {
      deck: deck(),
      config: { rangStack: false },
      stepwise: true,
    });
    g.play('a', 'rg-red-draw2-1');
    expect(g.turnId).toBe('b');
    expect(g.autoDue).toBe(true);
    expect(g.playable('b')).toEqual([]);
    expect(() => g.pick('b')).toThrow('One moment');
    expect(kinds(g.stepAuto())).toEqual(['rgpenalty']);
    expect(g.turnId).toBe('a');
  });

  it('with stacking a +2 is answered by a +2 or +4 of any colour, and the total is picked', () => {
    const g = table(
      { a: [rc('red', 'draw2'), rc('red', '1'), rc('blue', '9')], b: [rc('blue', 'draw2'), rc('red', '3'), w('wild4')], c: [rc('red', '4'), rc('red', '6')] },
      [rc('red', '5')],
      'a',
      { deck: deck() },
    );
    g.play('a', 'rg-red-draw2-1');
    expect(g.turnId).toBe('b');
    expect(g.penalty).toBe(2);
    expect(ids(g.playable('b'))).toEqual(['rg-blue-draw2-1', 'rg-w-wild4-1']);
    expect(() => g.play('b', 'rg-red-3-1')).toThrow('Play a +2 or +4, or pick 2 cards');
    expect(() => g.pass('b')).toThrow('Play a +2 or +4');
    g.play('b', 'rg-blue-draw2-1');
    expect(g.stats.get('b')!.stacks).toBe(1);
    expect(g.penalty).toBe(4);
    expect(g.turnId).toBe('c');
    expect(g.canPick('c')).toBe(true);
    const events = g.pick('c');
    expect(events.find((e) => e.kind === 'rgpenalty')).toMatchObject({ playerId: 'c', count: 4, forced: false });
    expect(g.turnId).toBe('a');
  });

  it('once a +4 tops the chain only a +4 answers it, and a stacked +4 cannot be challenged', () => {
    const g = table(
      { a: [rc('red', 'draw2'), rc('red', '1')], b: [w('wild4'), rc('red', '3')], c: [rc('red', 'draw2', 2), w('wild4', 2), rc('red', '6')] },
      [rc('red', '5')],
      'a',
      { deck: deck() },
    );
    g.play('a', 'rg-red-draw2-1');
    g.play('b', 'rg-w-wild4-1', { color: 'red' });
    expect(g.penalty).toBe(6);
    expect(g.canChallenge('c')).toBe(false);
    expect(ids(g.playable('c'))).toEqual(['rg-w-wild4-2']);
    expect(() => g.play('c', 'rg-red-draw2-2')).toThrow('Play a +4 or pick 6 cards');
    expect(() => g.challenge('c')).toThrow('Only a +4 played on you can be challenged');
  });
});

describe('rang: +4 challenge', () => {
  const deck = () => Array.from({ length: 10 }, (_, i) => rc('yellow', String(i) as RangValue, 2));

  it('guilty: the +4 player picks 4 and the challenger plays on', () => {
    const g = table(
      { a: [rc('red', '3'), w('wild4'), rc('blue', '1')], b: [rc('green', '2'), rc('blue', '4')], c: [rc('red', '4'), rc('red', '6')] },
      [rc('red', '5')],
      'a',
      { deck: deck(), config: { rangStack: false } },
    );
    g.play('a', 'rg-w-wild4-1', { color: 'green' });
    expect(g.turnId).toBe('b');
    expect(g.penalty).toBe(4);
    expect(g.canChallenge('b')).toBe(true);
    expect(g.canChallenge('c')).toBe(false);
    const events = g.challenge('b');
    expect(events.find((e) => e.kind === 'rgchallenge')).toMatchObject({ playerId: 'b', targetId: 'a', guilty: true, count: 4 });
    expect(g.last).toMatchObject({ kind: 'challenge', targetId: 'a', guilty: true });
    expect(g.hand('a')).toHaveLength(6);
    expect(g.penalty).toBe(0);
    expect(g.turnId).toBe('b');
    expect(ids(g.playable('b'))).toEqual(['rg-green-2-1']);
    g.play('b', 'rg-green-2-1');
    expect(g.turnId).toBe('c');
  });

  it('not guilty: the challenger picks 6 and loses the turn', () => {
    const g = table(
      { a: [w('wild4'), rc('blue', '1')], b: [rc('green', '2'), rc('blue', '4')], c: [rc('green', '4'), rc('red', '6')] },
      [rc('red', '5')],
      'a',
      { deck: deck() },
    );
    g.play('a', 'rg-w-wild4-1', { color: 'green' });
    const events = g.challenge('b');
    expect(events.find((e) => e.kind === 'rgchallenge')).toMatchObject({ playerId: 'b', targetId: 'a', guilty: false, count: 6 });
    expect(g.hand('b')).toHaveLength(8);
    expect(g.hand('a')).toHaveLength(1);
    expect(g.turnId).toBe('c');
  });

  it('is not allowed with challenges off or on a +2', () => {
    const off = table({ a: [rc('red', '3'), w('wild4')], b: [rc('green', '2'), rc('blue', '4')] }, [rc('red', '5')], 'a', {
      deck: deck(),
      config: { rangChallenge: false },
    });
    off.play('a', 'rg-w-wild4-1', { color: 'green' });
    expect(off.canChallenge('b')).toBe(false);
    expect(() => off.challenge('b')).toThrow(GameError);
    const two = table({ a: [rc('red', 'draw2'), rc('red', '1')], b: [rc('green', '2'), rc('blue', '4')], c: [rc('red', '1', 2)] }, [rc('red', '5')], 'a', { deck: deck() });
    two.play('a', 'rg-red-draw2-1');
    expect(two.canChallenge('b')).toBe(false);
  });
});

describe('rang: 7-0', () => {
  const swap = { rangSwap: true };

  it('a 7 swaps hands with the chosen player, and nobody is caught by it', () => {
    const g = table(
      { a: [rc('red', '7'), rc('red', '1'), rc('blue', '2')], b: [rc('green', '4')], c: [rc('yellow', '5'), rc('red', '6')] },
      [rc('red', '3')],
      'a',
      { config: swap, state: { called: new Set(['b']) } },
    );
    expect(() => g.play('a', 'rg-red-7-1')).toThrow('Pick a player to swap with');
    expect(() => g.play('a', 'rg-red-7-1', { targetId: 'a' })).toThrow('Pick a player to swap with');
    expect(() => g.play('a', 'rg-red-7-1', { targetId: 'zz' })).toThrow('Pick a player to swap with');
    expect(g.hand('a')).toHaveLength(3);
    const events = g.play('a', 'rg-red-7-1', { targetId: 'b' });
    expect(events[0]).toMatchObject({ kind: 'rgplay', targetId: 'b' });
    expect(ids(g.hand('a'))).toEqual(['rg-green-4-1']);
    expect(ids(g.hand('b'))).toEqual(['rg-red-1-1', 'rg-blue-2-1']);
    expect(g.atRisk).toBeNull();
    expect(g.called.has('b')).toBe(false);
    expect(g.turnId).toBe('b');
  });

  it('a 0 passes every hand on in the direction of play', () => {
    const g = table(
      { a: [rc('red', '0'), rc('red', '1')], b: [rc('green', '4'), rc('green', '5')], c: [rc('yellow', '5'), rc('red', '6'), rc('red', '8')] },
      [rc('red', '3')],
      'a',
      { config: swap },
    );
    expect(g.play('a', 'rg-red-0-1')[0]).toMatchObject({ kind: 'rgplay', rotated: true });
    expect(ids(g.hand('b'))).toEqual(['rg-red-1-1']);
    expect(ids(g.hand('c'))).toEqual(['rg-green-4-1', 'rg-green-5-1']);
    expect(g.hand('a')).toHaveLength(3);
    expect(g.atRisk).toBeNull();
  });

  it('a 7 or 0 as the last card just wins', () => {
    for (const value of ['7', '0'] as const) {
      const g = table({ a: [rc('red', value)], b: [rc('green', '4')] }, [rc('red', '3')], 'a', { config: swap, state: { called: new Set(['a']) } });
      expect(kinds(g.play('a', `rg-red-${value}-1`))).toEqual(['rgplay', 'finish', 'gameOver']);
      expect(g.winners()).toEqual(['a']);
      expect(ids(g.hand('b'))).toEqual(['rg-green-4-1']);
    }
  });

  it('with 7-0 off a 7 and a 0 are plain numbers', () => {
    const g = table({ a: [rc('red', '7'), rc('red', '1')], b: [rc('red', '4')] }, [rc('red', '3')], 'a');
    g.play('a', 'rg-red-7-1');
    expect(ids(g.hand('b'))).toEqual(['rg-red-4-1']);
  });
});

describe('rang: picking and passing', () => {
  const misfits = () => [rc('green', '1'), rc('green', '2'), rc('green', '4'), rc('green', '5')];

  it('one pick per turn: the turn passes by itself when the pick does not fit', () => {
    const g = table({ a: [rc('blue', '1'), rc('blue', '2')], b: [rc('red', '4')] }, [rc('red', '3')], 'a', { deck: misfits() });
    expect(() => g.pass('a')).toThrow('Pick a card first');
    expect(g.canPass('a')).toBe(false);
    const events = g.pick('a');
    expect(kinds(events)).toEqual(['rgpick', 'rgpass']);
    expect(g.turnId).toBe('b');
  });

  it('three picks per turn: may pick on or pass, and at the limit the turn passes', () => {
    const g = table({ a: [rc('blue', '1'), rc('blue', '2')], b: [rc('red', '4')] }, [rc('red', '3')], 'a', { deck: misfits(), config: { rangPicks: 3 } });
    expect(g.maxPicks()).toBe(3);
    g.pick('a');
    expect(g.canPass('a')).toBe(true);
    g.pick('a');
    expect(g.picks).toBe(2);
    expect(g.picked).toHaveLength(2);
    expect(kinds(g.pick('a'))).toEqual(['rgpick', 'rgpass']);
    expect(g.turnId).toBe('b');
    expect(g.stats.get('a')!.picks).toBe(3);
    const h = table({ a: [rc('blue', '1')], b: [rc('red', '4')] }, [rc('red', '3')], 'a', { deck: misfits(), config: { rangPicks: 3 } });
    h.pick('a');
    expect(kinds(h.pass('a'))).toEqual(['rgpass']);
    expect(h.turnId).toBe('b');
  });

  it('after a pick the player may pass, even when the picked card fits; no more picks at the limit', () => {
    const g = table({ a: [rc('blue', '1')], b: [rc('red', '4'), rc('red', '6')] }, [rc('red', '3')], 'a', { deck: [rc('red', '9')] });
    expect(g.canPass('a')).toBe(false);
    g.pick('a');
    expect(g.turnId).toBe('a');
    expect(ids(g.playable('a'))).toEqual(['rg-red-9-1']);
    expect(() => g.pick('a')).toThrow('You picked 1 this turn');
    expect(g.canPass('a')).toBe(true);
    expect(kinds(g.pass('a'))).toEqual(['rgpass']);
    expect(g.turnId).toBe('b');
    expect(g.hand('a')).toHaveLength(2);
  });

  it('a turn with nothing to play picks for the player (and passes) automatically', () => {
    const g = table({ a: [rc('red', '1'), rc('red', '2')], b: [rc('blue', '4'), rc('blue', '5')], c: [rc('green', '9'), rc('red', '7')] }, [rc('red', '3')], 'a', {
      deck: misfits(),
    });
    const events = g.play('a', 'rg-red-1-1');
    expect(events.slice(1).map((e) => [e.kind, 'playerId' in e ? e.playerId : null])).toEqual([
      ['rgpick', 'b'],
      ['rgpass', 'b'],
    ]);
    expect(g.turnId).toBe('c');
  });

  it('live games pick and pass one step at a time', () => {
    const g = table({ a: [rc('blue', '1'), rc('blue', '2')], b: [rc('red', '4')] }, [rc('red', '3')], 'a', { deck: misfits(), stepwise: true });
    expect(g.autoDue).toBe(true);
    expect(g.canPick('a')).toBe(false);
    expect(g.stepAuto()[0]).toMatchObject({ kind: 'rgpick', playerId: 'a', forced: true, count: 1 });
    expect(g.turnId).toBe('a');
    expect(g.autoDue).toBe(true);
    expect(g.stepAuto()[0]).toMatchObject({ kind: 'rgpass', playerId: 'a', auto: true });
    expect(g.turnId).toBe('b');
    expect(g.autoDue).toBe(false);
    expect(g.stepAuto()).toEqual([]);
  });

  it('shuffles the pile back in (all but the top) when the deck runs out', () => {
    const g = table({ a: [rc('blue', '1')], b: [rc('red', '4')] }, [rc('green', '1'), rc('green', '2'), rc('red', '3')], 'a');
    const events = g.pick('a');
    expect(events[0]).toMatchObject({ kind: 'rgshuffle', count: 2 });
    expect(ids(g.pile)).toEqual(['rg-red-3-1']);
    expect(g.deck).toHaveLength(1);
    expect(g.hand('a')).toHaveLength(2);
  });
});

describe('rang: last card', () => {
  const deck = () => [rc('green', '1'), rc('green', '2'), rc('green', '4'), rc('green', '5')];

  it('said in time keeps the player safe', () => {
    const g = table({ a: [rc('red', '1'), rc('red', '2')], b: [rc('red', '4'), rc('red', '5')] }, [rc('red', '3')], 'a', { deck: deck() });
    expect(g.canCall('a')).toBe(true);
    expect(g.canCall('b')).toBe(false);
    expect(kinds(g.call('a'))).toEqual(['rgcall']);
    expect(() => g.call('a')).toThrow('You already said it');
    g.play('a', 'rg-red-1-1');
    expect(g.atRisk).toBeNull();
    g.play('b', 'rg-red-4-1');
    expect(g.missed.size).toBe(0);
    expect(g.stats.get('a')!.lastCalls).toBe(1);
  });

  it('caught: picks 2 and misses the next turn', () => {
    const g = table({ a: [rc('red', '1'), rc('red', '2')], b: [rc('red', '4'), rc('red', '5')] }, [rc('red', '3')], 'a', { deck: deck() });
    g.play('a', 'rg-red-1-1');
    expect(g.atRisk).toBe('a');
    const events = g.play('b', 'rg-red-4-1');
    expect(kinds(events)).toEqual(['rgmissed', 'rgplay', 'rgpenalty']);
    expect(events[2]).toMatchObject({ playerId: 'a', count: 2, missed: true, forced: true });
    expect(g.hand('a')).toHaveLength(3);
    expect(g.turnId).toBe('b');
    expect(g.stats.get('a')!.missedCalls).toBe(1);
    expect(() => g.call('a')).toThrow(GameError);
  });

  it('a late call still counts before anyone else moves', () => {
    const g = table({ a: [rc('red', '1'), rc('red', '2')], b: [rc('red', '4'), rc('red', '5')] }, [rc('red', '3')], 'a', { deck: deck() });
    g.play('a', 'rg-red-1-1');
    g.call('a');
    expect(kinds(g.play('b', 'rg-red-4-1'))).toEqual(['rgplay']);
  });
});

describe('rang: ending', () => {
  it('the first empty hand wins; the rest rank by points and only the highest loses', () => {
    const g = table(
      { a: [rc('red', '1')], b: [w('wild')], c: [rc('red', '9'), rc('red', '2')], d: [rc('blue', 'skip')], e: [rc('blue', '9'), rc('green', '2')] },
      [rc('red', '3')],
      'a',
      { state: { called: new Set(['a']) } },
    );
    expect(kinds(g.play('a', 'rg-red-1-1'))).toEqual(['rgplay', 'finish', 'gameOver']);
    expect(g.over).toBe(true);
    expect(g.winners()).toEqual(['a']);
    expect(g.handValueOf('b')).toBe(50);
    expect(g.handValueOf('d')).toBe(20);
    expect(g.placeOf('a')).toBe(1);
    expect(g.placeOf('c')).toBe(2);
    expect(g.placeOf('e')).toBe(2);
    expect(g.placeOf('d')).toBe(4);
    expect(g.placeOf('b')).toBe(5);
    expect(g.losers()).toEqual(['b']);
    expect(() => g.pick('b')).toThrow('Game is over');
  });

  it('a walk-out loses; with two players the other one wins', () => {
    const g = table({ a: [rc('red', '1'), rc('red', '2')], b: [rc('red', '4'), rc('red', '5')], c: [rc('red', '6'), rc('blue', '9')] }, [rc('red', '3')], 'a');
    expect(g.leave('a')).toEqual([]);
    expect(g.turnId).toBe('b');
    expect(g.deck).toHaveLength(2);
    expect(g.leave('a')).toEqual([]);
    expect(kinds(g.leave('c'))).toEqual(['finish', 'gameOver']);
    expect(g.winners()).toEqual(['b']);
    expect(g.losers().sort()).toEqual(['a', 'c']);
  });

  it('a kick that leaves one player stops the game with no winner', () => {
    const g = table({ a: [rc('red', '1')], b: [rc('red', '4')] }, [rc('red', '3')], 'a');
    expect(kinds(g.removePlayer('b'))).toEqual(['gameOver']);
    expect(g.aborted).toBe(true);
    expect(g.winners()).toEqual([]);
    expect(g.losers()).toEqual([]);
  });

  it('a kick on turn clears a +4 aimed at them; close ends with no winner', () => {
    const g = table({ a: [w('wild4'), rc('red', '1')], b: [rc('red', '4')], c: [rc('green', '6'), rc('green', '9')] }, [rc('red', '3')], 'a', { config: { rangStack: false } });
    g.play('a', 'rg-w-wild4-1', { color: 'green' });
    expect(g.turnId).toBe('b');
    g.removePlayer('b');
    expect(g.penalty).toBe(0);
    expect(g.challengeable).toBeNull();
    expect(g.turnId).toBe('c');
    expect(kinds(g.close())).toEqual(['gameOver']);
    expect(g.winners()).toEqual([]);
  });
});

describe('rang: copies', () => {
  it('state() and fromState() round-trip without sharing anything', () => {
    const g = new RangGame(['a', 'b', 'c'], { ...CONFIG, rangSwap: true, rangPicks: 3 }, seeded(7));
    const copy = RangGame.fromState(g.state(), seeded(7));
    expect(copy.state()).toEqual(g.state());
    const id = copy.turnId!;
    if (copy.playable(id).length > 0) {
      const card = copy.playable(id)[0];
      const others = copy.order.filter((p) => p !== id);
      copy.play(id, card.id, { color: 'red', targetId: others[0] });
    } else copy.pick(id);
    expect(copy.state()).not.toEqual(g.state());
    expect(count(g)).toBe(108);
    expect(count(copy)).toBe(108);
  });
});

describe('rang: random games', () => {
  /** the table never breaks a rule: cards conserved, no card twice, the player on turn still holds cards */
  function check(g: RangGame): void {
    expect(count(g)).toBe(108);
    const all = [...[...g.hands.values()].flat(), ...g.deck, ...g.pile].map((c) => c.id);
    expect(new Set(all).size).toBe(108);
    expect(g.penalty).toBeGreaterThanOrEqual(0);
    expect(g.picks).toBeLessThanOrEqual(g.maxPicks());
    expect(g.pile.length).toBeGreaterThan(0);
    if (g.over) {
      expect(g.turnId).toBeNull();
      return;
    }
    expect(g.turnId).not.toBeNull();
    expect(g.hand(g.turnId!).length).toBeGreaterThan(0);
    expect(g.color).not.toBeNull();
  }

  it('plays 200 full games of random legal moves to the end', () => {
    const r = seeded(2026);
    let shuffles = 0;
    let challenges = 0;
    for (let n = 0; n < 200; n++) {
      const players = ['a', 'b', 'c', 'd', 'e'].slice(0, 2 + r(4));
      const config = { ...CONFIG, rangPicks: 1 + r(7), rangStack: r(2) === 0, rangChallenge: r(2) === 0, rangSwap: r(2) === 0 } as GameConfig;
      const stepwise = n % 2 === 1;
      const g = new RangGame(players, config, seeded(n + 1), true, stepwise);
      check(g);
      let steps = 0;
      while (!g.over && steps++ < 5000) {
        // anyone may say "last card" at any moment
        for (const p of players) if (g.canCall(p) && r(3) > 0) g.call(p);
        if (g.autoDue) {
          const ev = g.stepAuto();
          shuffles += ev.filter((e) => e.kind === 'rgshuffle').length;
          check(g);
          continue;
        }
        const id = g.turnId!;
        const others = players.filter((p) => p !== id && g.hand(p).length > 0);
        const cards = g.playable(id);
        const moves: (() => GameEvent[])[] = cards.map(
          (c) => () => g.play(id, c.id, { color: RANG_COLORS[r(4)], targetId: others[r(others.length)] }),
        );
        if (g.canPick(id)) moves.push(() => g.pick(id));
        if (g.canPass(id)) moves.push(() => g.pass(id));
        if (g.canChallenge(id)) {
          moves.push(() => g.challenge(id));
          challenges++;
        }
        if (r(400) === 0 && players.length > 2) moves.push(() => g.leave(others[0] ?? id));
        expect(moves.length).toBeGreaterThan(0);
        // mostly play when something fits, so hands shrink and games end
        const ev = (cards.length > 0 && r(5) > 0 ? moves[r(cards.length)] : moves[r(moves.length)])();
        shuffles += ev.filter((e) => e.kind === 'rgshuffle').length;
        check(g);
      }
      expect(g.over).toBe(true);
      if (!g.aborted && !g.closed) {
        expect(g.winners()).toHaveLength(1);
        const winner = g.winners()[0];
        expect(g.placeOf(winner)).toBe(1);
        if (!g.stalled && g.forfeited.size === 0) expect(g.hand(winner)).toHaveLength(0);
        const losers = g.losers();
        expect(losers.length).toBeGreaterThan(0);
        const still = players.filter((p) => p !== winner && !g.forfeited.has(p));
        const worst = Math.max(...still.map((p) => rangHandPoints(g.hand(p))));
        for (const p of still) if (rangHandPoints(g.hand(p)) === worst) expect(losers).toContain(p);
      }
    }
    expect(shuffles).toBeGreaterThan(0);
    expect(challenges).toBeGreaterThan(0);
  });
});

describe('rang: hand size and missed penalty', () => {
  it('deals the hand size the room picked', () => {
    for (const rangHand of [5, 7, 10] as const) {
      const g = new RangGame(['a', 'b', 'c', 'd'], { ...CONFIG, rangHand }, seeded(rangHand), true, true);
      for (const id of g.order) expect(g.hand(id)).toHaveLength(rangHand);
      expect(count(g)).toBe(108);
    }
  });

  it('a missed last card picks the penalty the room picked', () => {
    for (const rangMissed of [1, 2, 4] as const) {
      const deck = [rc('green', '1'), rc('green', '2'), rc('green', '4'), rc('green', '5'), rc('green', '6')];
      const g = table({ a: [rc('red', '1'), rc('red', '2')], b: [rc('red', '4'), rc('red', '5')] }, [rc('red', '3')], 'a', { deck, config: { rangMissed } });
      g.play('a', 'rg-red-1-1');
      const events = g.play('b', 'rg-red-4-1');
      expect(events.find((e) => e.kind === 'rgpenalty')).toMatchObject({ playerId: 'a', count: rangMissed, missed: true });
      expect(g.hand('a')).toHaveLength(1 + rangMissed);
    }
  });
});

describe('rang: force play', () => {
  const force = { rangForce: true };

  it('a tapped pick that fits is played at once', () => {
    const g = table({ a: [rc('red', '1'), rc('blue', '2')], b: [rc('green', '4'), rc('green', '5')] }, [rc('red', '3')], 'a', { deck: [rc('red', '8')], config: { ...force, rangPicks: 3 }, stepwise: true });
    const events = g.pick('a');
    expect(kinds(events)).toEqual(['rgpick', 'rgplay']);
    expect(events[1]).toMatchObject({ playerId: 'a', card: { id: 'rg-red-8-1' }, forced: true });
    expect(g.last).toMatchObject({ kind: 'play', forced: true });
    expect(ids(g.hand('a'))).toEqual(['rg-red-1-1', 'rg-blue-2-1']);
    expect(g.turnId).toBe('b');
  });

  it('a picked card that does not fit is kept; off, a fitting pick waits for the player', () => {
    const g = table({ a: [rc('red', '1'), rc('blue', '2')], b: [rc('green', '4')] }, [rc('red', '3')], 'a', { deck: [rc('green', '8')], config: { ...force, rangPicks: 3 } });
    expect(kinds(g.pick('a'))).toEqual(['rgpick']);
    const off = table({ a: [rc('red', '1'), rc('blue', '2')], b: [rc('green', '4')] }, [rc('red', '3')], 'a', { deck: [rc('red', '8')], config: { rangPicks: 3 } });
    expect(kinds(off.pick('a'))).toEqual(['rgpick']);
    expect(off.turnId).toBe('a');
  });

  it('a wild names the colour held most (else the colour in play)', () => {
    const g = table({ a: [rc('blue', '1'), rc('green', '2'), rc('green', '6')], b: [rc('green', '4'), rc('green', '5')] }, [rc('red', '3')], 'a', { deck: [w('wild')], config: force });
    const auto = g.pick('a');
    expect(auto.find((e) => e.kind === 'rgplay')).toMatchObject({ card: { id: 'rg-w-wild-1' }, color: 'green', forced: true });
    expect(g.color).toBe('green');
    const lone = table({ a: [w('wild', 2), rc('blue', '6')], b: [rc('green', '4'), rc('green', '5')] }, [rc('red', '3')], 'a', { deck: [w('wild')], config: { ...force, rangPicks: 2 } });
    lone.hands.set('a', [w('wild', 2)]);
    lone.pick('a');
    expect(lone.color).toBe('red');
  });

  it('a 7 with 7-0 swaps with the opponent holding the fewest cards (ties: next in turn)', () => {
    const g = table(
      { a: [rc('blue', '1'), rc('blue', '2')], b: [rc('green', '4'), rc('green', '5'), rc('green', '6')], c: [rc('yellow', '4'), rc('yellow', '5')], d: [rc('yellow', '1'), rc('yellow', '2')] },
      [rc('red', '3')],
      'a',
      { deck: [rc('red', '7')], config: { ...force, rangSwap: true }, stepwise: true },
    );
    const events = g.stepAuto();
    expect(events.find((e) => e.kind === 'rgplay')).toMatchObject({ targetId: 'c', forced: true });
    expect(ids(g.hand('c'))).toEqual(['rg-blue-1-1', 'rg-blue-2-1']);
  });

  it('works for the automatic pick, non-stepwise and stepwise', () => {
    const hands = () => ({ a: [rc('blue', '1'), rc('blue', '2')], b: [rc('green', '4'), rc('red', '5'), rc('red', '6')] });
    const g = table(hands(), [rc('red', '3')], 'b', { deck: [rc('red', '9')], config: force });
    // b plays red 5; a has nothing that fits, picks red 9 and plays it
    const events = g.play('b', 'rg-red-5-1');
    expect(kinds(events)).toEqual(['rgplay', 'rgpick', 'rgplay']);
    expect(events[2]).toMatchObject({ playerId: 'a', forced: true });
    expect(g.turnId).toBe('b');
    const live = table(hands(), [rc('red', '3')], 'b', { deck: [rc('red', '9')], config: force, stepwise: true });
    live.play('b', 'rg-red-5-1');
    expect(live.turnId).toBe('a');
    expect(live.autoDue).toBe(true);
    expect(kinds(live.stepAuto())).toEqual(['rgpick', 'rgplay']);
    expect(live.turnId).toBe('b');
    expect(live.autoDue).toBe(false);
  });

  it('never follows a +2/+4 pick', () => {
    const g = table({ a: [rc('red', 'draw2'), rc('red', '1'), rc('red', '2')], b: [rc('blue', '4'), rc('blue', '5')] }, [rc('red', '3')], 'a', {
      deck: [rc('green', '1'), rc('blue', '9')],
      config: { ...force, rangStack: true },
      stepwise: true,
    });
    g.play('a', 'rg-red-draw2-1');
    const events = g.pick('b');
    expect(kinds(events)).toEqual(['rgpenalty']);
    expect(g.hand('b')).toHaveLength(4);
    expect(g.turnId).toBe('a');
  });
});

describe('rang: doubles', () => {
  const on = { rangDoubles: true };

  it('puts down every card of one number; the last one is on top and sets the colour', () => {
    const g = table({ a: [rc('red', '5'), rc('blue', '5'), rc('green', '5'), rc('green', '1')], b: [rc('green', '4'), rc('green', '6')] }, [rc('yellow', '5')], 'a', { config: on, stepwise: true });
    const events = g.play('a', 'rg-red-5-1', { extra: ['rg-green-5-1', 'rg-blue-5-1'] });
    expect(events[0]).toMatchObject({ kind: 'rgplay', card: { id: 'rg-blue-5-1' }, color: 'blue' });
    expect(events[0].kind === 'rgplay' && ids(events[0].cards!)).toEqual(['rg-red-5-1', 'rg-green-5-1', 'rg-blue-5-1']);
    expect(ids(g.last!.cards!)).toEqual(['rg-red-5-1', 'rg-green-5-1', 'rg-blue-5-1']);
    expect(g.top()!.id).toBe('rg-blue-5-1');
    expect(g.color).toBe('blue');
    expect(g.hand('a')).toHaveLength(1);
    expect(g.atRisk).toBe('a');
    expect(g.stats.get('a')!.plays).toBe(1);
  });

  it('refuses when off, mixed numbers, action cards, wilds, cards not held, repeats, or a first card that does not fit', () => {
    const hand = [rc('red', '5'), rc('blue', '5'), rc('red', '6'), rc('red', 'skip'), rc('blue', 'skip'), w('wild'), w('wild', 2), rc('green', '9'), rc('blue', '9')];
    const make = (config = on) => table({ a: [...hand], b: [rc('green', '4')] }, [rc('red', '3')], 'a', { config, stepwise: true });
    expect(() => make({ rangDoubles: false } as typeof on).play('a', 'rg-red-5-1', { extra: ['rg-blue-5-1'] })).toThrow('Doubles are off in this room');
    expect(() => make().play('a', 'rg-red-5-1', { extra: ['rg-red-6-1'] })).toThrow('Only number cards of the same number go together');
    expect(() => make().play('a', 'rg-red-skip-1', { extra: ['rg-blue-skip-1'] })).toThrow('Only number cards of the same number go together');
    expect(() => make().play('a', 'rg-w-wild-1', { color: 'red', extra: ['rg-w-wild-2'] })).toThrow('Only number cards of the same number go together');
    expect(() => make().play('a', 'rg-red-5-1', { extra: ['rg-green-5-1'] })).toThrow('You do not have that card');
    expect(() => make().play('a', 'rg-red-5-1', { extra: ['rg-red-5-1'] })).toThrow(GameError);
    expect(() => make().play('a', 'rg-green-9-1', { extra: ['rg-blue-9-1'] })).toThrow(GameError);
    // more than one card only on the same number: on a red 3 the red 5 fits by colour, but goes alone
    expect(() => make().play('a', 'rg-red-5-1', { extra: ['rg-blue-5-1'] })).toThrow('Put down more than one card only on the same number');
    expect(kinds(make().play('a', 'rg-red-5-1'))).toEqual(['rgplay']);
    // on a 5, every 5 goes down together
    const five = table({ a: [...hand], b: [rc('green', '4')] }, [rc('yellow', '5')], 'a', { config: on, stepwise: true });
    expect(kinds(five.play('a', 'rg-red-5-1', { extra: ['rg-blue-5-1'] }))).toEqual(['rgplay']);
  });

  it('on a green 8, a green 4 can go but not together with the other 4s', () => {
    const g = table({ a: [rc('green', '4'), rc('red', '4'), rc('blue', '1')], b: [rc('green', '6')] }, [rc('green', '8')], 'a', { config: on, stepwise: true });
    expect(() => g.play('a', 'rg-green-4-1', { extra: ['rg-red-4-1'] })).toThrow('Put down more than one card only on the same number');
    g.play('a', 'rg-green-4-1');
    expect(g.top()!.id).toBe('rg-green-4-1');
    expect(g.hand('a')).toHaveLength(2);
  });

  it('a doubled 7 swaps once and a doubled 0 rotates once', () => {
    const g = table(
      { a: [rc('red', '7'), rc('blue', '7'), rc('green', '1')], b: [rc('green', '4'), rc('green', '6')], c: [rc('yellow', '1'), rc('yellow', '2'), rc('yellow', '3')] },
      [rc('yellow', '7')],
      'a',
      { config: { ...on, rangSwap: true }, stepwise: true },
    );
    expect(() => g.play('a', 'rg-red-7-1', { extra: ['rg-blue-7-1'] })).toThrow('Pick a player to swap with');
    const events = g.play('a', 'rg-red-7-1', { extra: ['rg-blue-7-1'], targetId: 'c' });
    expect(events[0]).toMatchObject({ kind: 'rgplay', targetId: 'c' });
    expect(ids(g.hand('c'))).toEqual(['rg-green-1-1']);
    expect(g.hand('a')).toHaveLength(3);
    const z = table(
      { a: [rc('red', '0'), rc('blue', '0'), rc('green', '1')], b: [rc('green', '4'), rc('green', '6')], c: [rc('yellow', '1')] },
      [rc('yellow', '0')],
      'a',
      { config: { ...on, rangSwap: true }, stepwise: true },
    );
    z.play('a', 'rg-red-0-1', { extra: ['rg-blue-0-1'] });
    expect(ids(z.hand('b'))).toEqual(['rg-green-1-1']);
    expect(ids(z.hand('c'))).toEqual(['rg-green-4-1', 'rg-green-6-1']);
    expect(ids(z.hand('a'))).toEqual(['rg-yellow-1-1']);
  });

  it('doubles that empty the hand win (a 7 needs no target then)', () => {
    const g = table({ a: [rc('red', '7'), rc('blue', '7')], b: [rc('green', '4')] }, [rc('yellow', '7')], 'a', { config: { ...on, rangSwap: true }, state: { called: new Set(['a']) } });
    expect(kinds(g.play('a', 'rg-red-7-1', { extra: ['rg-blue-7-1'] }))).toEqual(['rgplay', 'finish', 'gameOver']);
    expect(g.winners()).toEqual(['a']);
  });
});

describe('rang: 2 vs 2', () => {
  const four = () => ({ a: [rc('red', '1')], b: [rc('blue', '4'), rc('blue', '5')], c: [rc('green', '6'), rc('green', '7')], d: [rc('yellow', '1'), rc('yellow', '2')] });
  const teams = { teams: true };

  it('partners sit across; the first one out wins for both', () => {
    const g = table(four(), [rc('red', '3')], 'a', { config: teams, state: { called: new Set(['a']) } });
    expect(g.teams).toEqual([['a', 'c'], ['b', 'd']]);
    expect(g.partnerOf('a')).toBe('c');
    expect(g.partnerOf('d')).toBe('b');
    g.play('a', 'rg-red-1-1');
    expect(g.winners()).toEqual(['a', 'c']);
    expect(g.losers()).toEqual(['b', 'd']);
    expect(g.placeOf('a')).toBe(1);
    expect(g.placeOf('c')).toBe(1);
    expect(g.placeOf('b')).toBeNull();
    expect(table({ a: [rc('red', '1')], b: [rc('blue', '4')], c: [rc('green', '6')] }, [rc('red', '3')], 'a', { config: teams }).teams).toBeNull();
  });

  it('a walk-out hands the game to the other team', () => {
    const g = table(four(), [rc('red', '3')], 'a', { config: teams });
    expect(kinds(g.leave('b'))).toEqual(['gameOver']);
    expect(g.over).toBe(true);
    expect(g.winners()).toEqual(['a', 'c']);
    expect(g.losers()).toEqual(['b', 'd']);
    expect(g.placeOf('c')).toBe(1);
  });

  it('a kick stops the game; close with nobody out stops it too', () => {
    const g = table(four(), [rc('red', '3')], 'a', { config: teams });
    expect(kinds(g.removePlayer('c'))).toEqual(['gameOver']);
    expect(g.aborted).toBe(true);
    expect(g.winners()).toEqual([]);
    expect(g.losers()).toEqual([]);
    const h = table(four(), [rc('red', '3')], 'a', { config: teams });
    expect(kinds(h.close())).toEqual(['gameOver']);
    expect(h.aborted).toBe(true);
    expect(h.winners()).toEqual([]);
  });
});
