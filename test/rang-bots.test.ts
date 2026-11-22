import { afterEach, describe, expect, it } from 'vitest';
import type { Rand, RangAction, RangPersonality, RangSeatView } from '../src/rang/bot-models.js';
import { candidates, fallback, guiltChance, makePersonality, RANG_STYLES, seededRand, think } from '../src/rang/brain.js';
import { RangAuto } from '../src/rang/auto.js';
import { RangBots } from '../src/rang/driver.js';
import { isWild, RangGame, type RangState } from '../src/rang/game.js';
import { RangMemory } from '../src/rang/memory.js';
import type { GameEvent } from '../src/models.js';
import { Room } from '../src/rooms.js';
import type { GameConfig, RangCard, RangColor, RangValue } from '../src/types.js';
import { parseConfig } from '../src/validate.js';

const BASE = {
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

const rc = (color: RangColor, value: RangValue, d = 1): RangCard => ({ id: `rg-${color}-${value}-${d}`, color, value });
const w = (value: 'wild' | 'wild4', d = 1): RangCard => ({ id: `rg-w-${value}-${d}`, color: null, value });

/** the table as one seat sees it: the same fields Room.view sends, nothing hidden */
function viewFor(g: RangGame, id: string): RangSeatView {
  return {
    meId: id,
    turnId: g.turnId,
    config: g.config,
    players: g.order.map((p) => ({ id: p, cardCount: g.hand(p).length })),
    rang: {
      hand: [...g.hand(id)],
      top: g.top(),
      under: g.pile.slice(-4, -1),
      color: g.color,
      pileCount: g.pile.length,
      deckCount: g.deck.length,
      dir: g.dir,
      penalty: g.penalty,
      picks: g.picks,
      maxPicks: g.maxPicks(),
      playable: g.playable(id).map((c) => c.id),
      canPick: g.canPick(id),
      canPass: g.canPass(id),
      canCall: g.canCall(id),
      canChallenge: g.canChallenge(id),
      picked: g.turnId === id ? [...g.picked] : [],
      called: [...g.called],
      missed: [...g.missed],
      atRisk: g.atRisk,
      last: g.last ? { ...g.last } : null,
      turn: g.turnSeq,
      auto: g.autoDue,
      topBy: g.topBy,
      watch: null,
    },
  };
}

/** the simple player the bots must beat: first card that fits (a wild names its first colour, a 7 swaps with the next player), else pick, else pass */
function greedy(v: RangSeatView): RangAction {
  const r = v.rang;
  if (r.playable.length > 0) {
    const card = r.hand.find((c) => c.id === r.playable[0])!;
    const a: RangAction = { kind: 'play', cardId: card.id };
    if (isWild(card)) a.color = r.hand.find((c) => c.color)?.color ?? 'red';
    if (v.config.rangSwap && card.value === '7' && r.hand.length > 1) a.targetId = v.players.find((p) => p.id !== v.meId && p.cardCount > 0)!.id;
    return a;
  }
  return r.canPick ? { kind: 'pick' } : { kind: 'pass' };
}

type Kind = 'bot' | 'greedy';

/** runs a move like the driver: "last card" with the second-last card, and again if still owed */
function run(g: RangGame, id: string, a: RangAction): GameEvent[] {
  const events: GameEvent[] = [];
  if (a.kind === 'play') {
    if (g.hand(id).length === 2 && g.canCall(id)) events.push(...g.call(id));
    events.push(...g.play(id, a.cardId, { color: a.color, targetId: a.targetId, extra: a.extra }));
    if (!g.over && g.atRisk === id && g.canCall(id)) events.push(...g.call(id));
  } else if (a.kind === 'pick') {
    events.push(...g.pick(id));
    // force play may have put the picked card down
    if (!g.over && g.atRisk === id && g.canCall(id)) events.push(...g.call(id));
  }
  else if (a.kind === 'pass') events.push(...g.pass(id));
  else events.push(...g.challenge(id));
  return events;
}

/** a whole game through the real rules; every bot move is one the rules offer, and wilds always name a colour */
function playGame(config: GameConfig, kinds: Kind[], seed: number, limits: { budgetMs: number; maxPlayouts: number }) {
  const rand: Rand = seededRand(seed);
  const ids = kinds.map((_, i) => `p${i}`);
  const g = new RangGame(ids, config, (max) => Math.floor(rand() * max));
  const mems = new Map(ids.map((id) => [id, new RangMemory(id, config, ids)]));
  const people = new Map<string, RangPersonality>(ids.map((id, i) => [id, makePersonality(RANG_STYLES[i % 4], rand)]));
  const feed = (events: GameEvent[]) => mems.forEach((m) => m.observe(events));
  feed(g.opening);
  const missed: string[] = [];
  const stats = { challenges: 0, wilds: 0, swaps: 0, doubles: 0, forced: 0 };
  let moves = 0;
  while (!g.over && moves++ < 5000) {
    const id = g.turnId!;
    const kind = kinds[ids.indexOf(id)];
    mems.forEach((m) => m.see(g.hand(m.meId)));
    // a bot left on one card by force play says it at once, like the driver's call timer
    const late = g.atRisk;
    if (late && kinds[ids.indexOf(late)] === 'bot' && g.canCall(late)) feed(g.call(late));
    const view = viewFor(g, id);
    const mem = mems.get(id)!;
    mem.sync(view);
    const action = kind === 'bot' ? think({ view, mem, me: people.get(id)!, rand, ...limits }).action : greedy(view);
    // only moves the rules offer: the bot's own options (with its memory and style), or the safe fallback
    if (kind === 'bot') expect([...candidates(view, mem, people.get(id)!), fallback(view)]).toContainEqual(action);
    if (action.kind === 'play') {
      const card = g.hand(id).find((c) => c.id === action.cardId)!;
      expect(g.fits(card)).toBe(true);
      if (isWild(card)) {
        expect(action.color).toBeTruthy();
        stats.wilds++;
      }
      if (config.rangSwap && card.value === '7' && g.hand(id).length > 1) {
        expect(action.targetId).toBeTruthy();
        stats.swaps++;
      }
    }
    if (action.kind === 'challenge') stats.challenges++;
    if (action.kind === 'play' && action.extra?.length) stats.doubles++;
    const events = run(g, id, action);
    stats.forced += events.filter((e) => e.kind === 'rgplay' && e.forced).length;
    for (const e of events) if (e.kind === 'rgmissed' && kinds[ids.indexOf(e.playerId)] === 'bot') missed.push(e.playerId);
    feed(events);
  }
  return { g, missed, moves, stats };
}

describe('rang bots', () => {
  it('play whole games by the rules with every setting', () => {
    let games = 0;
    let seed = 1;
    const totals = { challenges: 0, wilds: 0, swaps: 0 };
    for (const rangStack of [true, false]) {
      for (const rangChallenge of [true, false]) {
        for (const rangSwap of [true, false]) {
          for (const rangPicks of [1, 3, 7]) {
            for (const seats of [2, 3, 4, 5]) {
              const config = { ...BASE, rangStack, rangChallenge, rangSwap, rangPicks };
              const { g, missed, stats } = playGame(config, Array(seats).fill('bot'), seed++, { budgetMs: 1, maxPlayouts: 2 });
              expect(g.over).toBe(true);
              expect(g.winners()).toHaveLength(1);
              // bots always say "last card" in time
              expect(missed).toEqual([]);
              totals.challenges += stats.challenges;
              totals.wilds += stats.wilds;
              totals.swaps += stats.swaps;
              games++;
            }
          }
        }
      }
    }
    expect(games).toBe(96);
    expect(totals.wilds).toBeGreaterThan(0);
    expect(totals.swaps).toBeGreaterThan(0);
    expect(totals.challenges).toBeGreaterThan(0);
  }, 120_000);

  it('play whole games with force play, doubles, 2v2, hand sizes and missed penalties', () => {
    let seed = 500;
    const totals = { doubles: 0, forced: 0 };
    const setups: Partial<GameConfig>[] = [
      { rangForce: true },
      { rangDoubles: true },
      { rangDoubles: true, rangSwap: true },
      { rangForce: true, rangDoubles: true, rangSwap: true, rangPicks: 3 },
      { rangHand: 5, rangMissed: 1 },
      { rangHand: 10, rangMissed: 4, rangForce: true },
    ];
    for (const extra of setups) {
      for (const seats of [2, 3, 4, 5]) {
        const config = { ...BASE, ...extra } as GameConfig;
        const { g, missed, stats } = playGame(config, Array(seats).fill('bot'), seed++, { budgetMs: 1, maxPlayouts: 2 });
        expect(g.over).toBe(true);
        expect(g.winners()).toHaveLength(1);
        expect(missed).toEqual([]);
        totals.doubles += stats.doubles;
        totals.forced += stats.forced;
      }
    }
    for (const extra of [{}, { rangDoubles: true, rangForce: true, rangSwap: true }, { rangHand: 5, rangMissed: 4 }, { rangHand: 10, rangMissed: 1, rangDoubles: true }]) {
      for (let k = 0; k < 3; k++) {
        const config = { ...BASE, teams: true, ...extra } as GameConfig;
        const { g, missed } = playGame(config, Array(4).fill('bot'), seed++, { budgetMs: 1, maxPlayouts: 2 });
        expect(g.over).toBe(true);
        expect(g.teams).not.toBeNull();
        const won = g.winners();
        expect(won).toHaveLength(2);
        expect(g.partnerOf(won[0])).toBe(won[1]);
        expect(g.losers().sort()).toEqual(g.order.filter((id) => !won.includes(id)).sort());
        expect(missed).toEqual([]);
      }
    }
    expect(totals.doubles).toBeGreaterThan(0);
    expect(totals.forced).toBeGreaterThan(0);
  }, 120_000);

  it('offers doubles beside single plays, and in 2v2 keeps a 7 swap off its partner', () => {
    const g = RangGame.fromState({
      order: ['a', 'b', 'c', 'd'],
      config: { ...BASE, rangDoubles: true, rangSwap: true, teams: true },
      hands: new Map([
        ['a', [rc('red', '5'), rc('blue', '5'), rc('blue', '1'), rc('blue', '2'), rc('red', '7'), rc('green', '7')]],
        ['b', [rc('green', '5'), rc('green', '6'), rc('green', '1'), rc('green', '2')]],
        ['c', [rc('yellow', '5'), rc('yellow', '6'), rc('yellow', '7')]],
        ['d', [rc('yellow', '1'), rc('yellow', '2')]],
      ]),
      deck: [rc('yellow', '9')],
      pile: [rc('red', '2')],
      turnId: 'a',
      penalty: 0,
      picks: 0,
      picked: [],
      called: new Set(['c']),
      missed: new Set(),
      atRisk: null,
      over: false,
      places: [],
      color: 'red',
      dir: 1,
      topBy: null,
      challengeable: null,
    });
    expect(g.partnerOf('a')).toBe('c');
    const v = viewFor(g, 'a');
    const plays = candidates(v).filter((a) => a.kind === 'play');
    // single red 5, and both 5s with the blue one (the colour held most) on top
    expect(plays).toContainEqual({ kind: 'play', cardId: 'rg-red-5-1' });
    expect(plays).toContainEqual({ kind: 'play', cardId: 'rg-red-5-1', extra: ['rg-blue-5-1'] });
    // 7s: the partner (not far fewer cards) is not a target; the doubled 7s swap once
    const sevens = plays.filter((a) => a.kind === 'play' && a.cardId === 'rg-red-7-1');
    expect(sevens.every((a) => a.kind === 'play' && a.targetId !== 'c')).toBe(true);
    expect(sevens).toContainEqual({ kind: 'play', cardId: 'rg-red-7-1', extra: ['rg-green-7-1'], targetId: 'd' });
    for (const a of plays) if (a.kind === 'play') expect(() => RangGame.fromState(g.state()).play('a', a.cardId, { color: a.color, targetId: a.targetId, extra: a.extra })).not.toThrow();
  });

  it('a wild is offered once per colour held, a 7 swap at the fewest cards first, and the fallback names the colour held most', () => {
    const g = RangGame.fromState({
      order: ['a', 'b', 'c'],
      config: { ...BASE, rangSwap: true },
      hands: new Map([
        ['a', [w('wild'), rc('blue', '3'), rc('blue', '4'), rc('green', '9'), rc('red', '7')]],
        ['b', [rc('green', '5'), rc('green', '6'), rc('green', '1')]],
        ['c', [rc('yellow', '5')]],
      ]),
      deck: [rc('yellow', '1')],
      pile: [rc('red', '2')],
      turnId: 'a',
      penalty: 0,
      picks: 0,
      picked: [],
      called: new Set(['c']),
      missed: new Set(),
      atRisk: null,
      over: false,
      places: [],
      color: 'red',
      dir: 1,
      topBy: null,
      challengeable: null,
    });
    const v = viewFor(g, 'a');
    const plays = candidates(v).filter((a) => a.kind === 'play');
    // ties go to the first in RANG_COLORS
    expect(plays.filter((a) => a.cardId === 'rg-w-wild-1').map((a) => (a.kind === 'play' ? a.color : null))).toEqual(['blue', 'red', 'green']);
    expect(plays.filter((a) => a.cardId === 'rg-red-7-1').map((a) => (a.kind === 'play' ? a.targetId : null))).toEqual(['c', 'b']);
    expect(fallback(v)).toEqual({ kind: 'play', cardId: 'rg-w-wild-1', color: 'blue' });
    const sevenOnly = viewFor(g, 'a');
    sevenOnly.rang.playable = ['rg-red-7-1'];
    expect(fallback(sevenOnly)).toEqual({ kind: 'play', cardId: 'rg-red-7-1', targetId: 'c' });
  });

  it('decides from its own view only: hidden cards moved around change nothing', () => {
    for (const rangSwap of [false, true]) {
      const rand = seededRand(rangSwap ? 11 : 7);
      const ids = ['a', 'b', 'c'];
      const g = new RangGame(ids, { ...BASE, rangPicks: 3, rangSwap }, (max) => Math.floor(rand() * max));
      const mem = new RangMemory('a', g.config, ids);
      mem.observe(g.opening);
      const step = () => {
        const id = g.turnId!;
        mem.see(g.hand('a'));
        mem.observe(run(g, id, greedy(viewFor(g, id))));
      };
      for (let i = 0; i < 6 && !g.over; i++) step();
      while (!g.over && g.turnId !== 'a') step();
      if (g.over) continue;
      const me = makePersonality('counter', seededRand(3));
      const before = viewFor(g, 'a');
      mem.sync(before);
      const first = think({ view: before, mem, me, rand: seededRand(42), budgetMs: 1e9, maxPlayouts: 12 });

      // swap hidden cards between the other hands and the deck, keeping every count the same
      const s = g.state();
      const hidden = [...s.hands.get('b')!, ...s.hands.get('c')!, ...s.deck].reverse();
      s.hands.set('b', hidden.splice(0, s.hands.get('b')!.length));
      s.hands.set('c', hidden.splice(0, s.hands.get('c')!.length));
      s.deck = hidden;
      const other = RangGame.fromState(s);
      other.last = g.last;
      other.moveSeq = g.moveSeq;
      other.turnSeq = g.turnSeq;
      const after = viewFor(other, 'a');
      expect(after).toEqual(before);
      const second = think({ view: after, mem, me, rand: seededRand(42), budgetMs: 1e9, maxPlayouts: 12 });
      expect(second.action).toEqual(first.action);
      expect(second.scores).toEqual(first.scores);
    }
  });

  it('challenges from public information only: what the +4 player really held changes nothing', () => {
    const hit = (bHand: RangCard[]): RangState => ({
      order: ['a', 'b', 'c'],
      config: BASE,
      hands: new Map([
        ['a', [rc('blue', '3'), rc('green', '4'), rc('yellow', '9'), rc('red', '1')]],
        ['b', bHand],
        ['c', [rc('yellow', '5'), rc('yellow', '6'), rc('blue', '1'), rc('blue', '2')]],
      ]),
      deck: [rc('green', '1'), rc('green', '2'), rc('green', '3'), rc('green', '5'), rc('green', '6'), rc('green', '7')],
      pile: [rc('red', '5'), w('wild4')],
      turnId: 'a',
      penalty: 4,
      picks: 0,
      picked: [],
      called: new Set(),
      missed: new Set(),
      atRisk: null,
      over: false,
      places: [],
      color: 'green',
      dir: 1,
      topBy: 'b',
      challengeable: { by: 'b', guilty: bHand.some((c) => c.color === 'red') },
    });
    const guilty = RangGame.fromState(hit([rc('red', '8'), rc('red', '9'), rc('blue', '9'), rc('yellow', '1'), rc('yellow', '2')]));
    const fair = RangGame.fromState(hit([rc('blue', '8'), rc('blue', '9'), rc('blue', '7'), rc('yellow', '1'), rc('yellow', '2')]));
    expect(guilty.challengeable?.guilty).toBe(true);
    expect(fair.challengeable?.guilty).toBe(false);
    const me = makePersonality('striker', seededRand(5));
    const decideOn = (g: RangGame) => {
      const mem = new RangMemory('a', BASE, g.order);
      mem.color = 'red';
      mem.observe([{ kind: 'rgplay', playerId: 'c', card: rc('red', '5'), color: 'red', penalty: 0 }]);
      mem.observe([{ kind: 'rgplay', playerId: 'b', card: w('wild4'), color: 'green', penalty: 4 }]);
      const view = viewFor(g, 'a');
      expect(view.rang.canChallenge).toBe(true);
      mem.sync(view);
      return think({ view, mem, me, rand: seededRand(9), budgetMs: 1e9, maxPlayouts: 10 });
    };
    const x = decideOn(guilty);
    const y = decideOn(fair);
    expect(viewFor(guilty, 'a')).toEqual(viewFor(fair, 'a'));
    expect(x.guilt).toBeGreaterThan(0);
    expect(x.guilt).toEqual(y.guilt);
    expect(x.action).toEqual(y.action);
    expect(x.scores).toEqual(y.scores);
  });

  it('doubts a +4 less from a player who just picked because nothing fit that colour', () => {
    const view: RangSeatView = {
      meId: 'a',
      turnId: 'a',
      config: BASE,
      players: [
        { id: 'a', cardCount: 5 },
        { id: 'b', cardCount: 6 },
      ],
      rang: {
        ...viewFor(RangGame.fromState({ order: ['a', 'b'], config: BASE, hands: new Map([['a', [rc('blue', '1')]], ['b', [rc('blue', '2')]]]), deck: [], pile: [w('wild4')], turnId: 'a', penalty: 4, picks: 0, picked: [], called: new Set(), missed: new Set(), atRisk: null, over: false, places: [], color: 'green', dir: 1, topBy: 'b', challengeable: { by: 'b', guilty: false } }), 'a').rang,
        hand: [rc('blue', '3'), rc('green', '4'), rc('yellow', '9'), rc('red', '1'), rc('red', '2')],
      },
    };
    const fresh = new RangMemory('a', BASE, ['a', 'b']);
    fresh.color = 'red';
    fresh.observe([{ kind: 'rgplay', playerId: 'a', card: rc('red', '5'), color: 'red', penalty: 0 }]);
    fresh.observe([{ kind: 'rgplay', playerId: 'b', card: w('wild4'), color: 'green', penalty: 4 }]);
    const read = new RangMemory('a', BASE, ['a', 'b']);
    read.color = 'red';
    read.observe([{ kind: 'rgplay', playerId: 'a', card: rc('red', '5'), color: 'red', penalty: 0 }]);
    // b had nothing red, no 5 and no wild, picked one and passed
    read.observe([{ kind: 'rgpick', playerId: 'b', count: 1, forced: true }]);
    expect([...read.read('b').voidColors]).toEqual(['red']);
    expect([...read.read('b').voidValues].sort()).toEqual(['5', 'wild', 'wild4']);
    read.observe([{ kind: 'rgpass', playerId: 'b', auto: true }]);
    expect(read.read('b').fresh).toBe(0);
    read.observe([{ kind: 'rgplay', playerId: 'a', card: rc('red', '6'), color: 'red', penalty: 0 }]);
    read.observe([{ kind: 'rgpick', playerId: 'b', count: 1, forced: false }]);
    // the +4 must be the card picked since: it breaks the read and uses up that fresh card
    read.observe([{ kind: 'rgplay', playerId: 'b', card: w('wild4'), color: 'green', penalty: 4 }]);
    expect(read.read('b').fresh).toBe(0);
    expect(read.four).toEqual({ by: 'b', color: 'red' });
    const open = guiltChance(view, fresh);
    const narrowed = guiltChance(view, read);
    expect(open).toBeGreaterThan(0.2);
    expect(narrowed).toBeLessThan(0.01);
  });

  it('reads a penalty taken with stacking on, and knows the hand it gave away with a 7', () => {
    const mem = new RangMemory('me', { ...BASE, rangSwap: true }, ['me', 'x', 'y']);
    mem.observe([{ kind: 'rgplay', playerId: 'y', card: rc('red', 'draw2'), color: 'red', penalty: 2 }]);
    mem.observe([{ kind: 'rgpenalty', playerId: 'x', count: 2, missed: false, forced: false }]);
    expect([...mem.read('x').voidValues].sort()).toEqual(['draw2', 'wild4']);
    expect(mem.read('x').fresh).toBe(2);
    const off = new RangMemory('me', { ...BASE, rangStack: false }, ['me', 'x', 'y']);
    off.observe([{ kind: 'rgpenalty', playerId: 'x', count: 2, missed: false, forced: true }]);
    expect(off.read('x').voidValues.size).toBe(0);
    // my 7 swaps with y: y now holds the rest of my old hand, card for card, and x's read stays with x
    mem.see([rc('blue', '7'), rc('green', '1'), rc('yellow', '2')]);
    mem.observe([{ kind: 'rgplay', playerId: 'me', card: rc('blue', '7'), color: 'blue', penalty: 0, targetId: 'y' }]);
    expect(mem.read('y').known.map((c) => c.id)).toEqual(['rg-green-1-1', 'rg-yellow-2-1']);
    expect(mem.read('x').fresh).toBe(2);
    // a 0 passes every hand on (me to x, x to y, y to me): x now holds my hand, y has x's read
    mem.see([rc('red', '3'), rc('red', '4')]);
    mem.observe([{ kind: 'rgplay', playerId: 'x', card: rc('blue', '0'), color: 'blue', penalty: 0, rotated: true }]);
    expect(mem.read('x').known.map((c) => c.id)).toEqual(['rg-red-3-1', 'rg-red-4-1']);
    expect(mem.read('y').fresh).toBe(2);
    expect(mem.reads.has('me')).toBe(false);
  });

  it('search bots beat simple players clearly', () => {
    const GAMES = 500;
    let botWins = 0;
    for (let i = 0; i < GAMES; i++) {
      // seats alternate, and who sits where swaps every game, so turn order favours nobody
      const kinds: Kind[] = i % 2 === 0 ? ['bot', 'greedy', 'bot', 'greedy'] : ['greedy', 'bot', 'greedy', 'bot'];
      const { g } = playGame(BASE, kinds, 1000 + i, { budgetMs: 1e9, maxPlayouts: 30 });
      const winner = g.winners()[0];
      if (kinds[g.order.indexOf(winner)] === 'bot') botWins++;
    }
    const rate = botWins / GAMES;
    console.log(`2 search bots vs 2 simple players: bots won ${botWins}/${GAMES} (${Math.round(rate * 100)}%, even would be 50%)`);
    // measured 53-55% over 500 games (greedy that names its longest colour reaches ~54%); a small, real edge
    expect(rate).toBeGreaterThan(0.52);
  }, 300_000);
});

async function until(check: () => boolean, ms: number) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('rang bots in a room', () => {
  const stops: (() => void)[] = [];
  afterEach(() => {
    stops.forEach((s) => s());
    stops.length = 0;
  });

  it('a person and two bots finish a game through RangBots and RangAuto, the person played by the turn-timer stand-in', async () => {
    const room = new Room('RBOT');
    const asha = room.addMember('Asha');
    asha.hasRang = true;
    asha.socketId = 's-asha';
    room.setConfig(asha.id, parseConfig({ decks: 1, bluffRule: 'one', game: 'rang', rangPicks: 3, rangSwap: true, turnTimer: true }));
    room.addBot(asha.id, 'Bot A');
    room.addBot(asha.id, 'Bot B');
    room.start(asha.id);
    const g = room.rang!;
    const seen: GameEvent[] = [];
    let personTimer: ReturnType<typeof setTimeout> | null = null;
    const wake = () => {
      bots.wake(room);
      auto.wake(room);
      // the person's turn: the stand-in plays it straight away, like a turn timer that ran out
      if (g.over || g.turnId !== asha.id || g.autoDue || personTimer) return;
      personTimer = setTimeout(() => {
        personTimer = null;
        const events = bots.playFor(room, asha.id);
        if (events.length > 0) onMove(room, events);
        else wake();
      }, 1);
    };
    const onMove = (r: Room, events: GameEvent[]) => {
      seen.push(...events);
      bots.observe(r, events);
      wake();
    };
    const bots = new RangBots({ onMove, onChat: () => {} }, () => true, 0.002, seededRand(4));
    const auto = new RangAuto(onMove, () => true, 0.002, seededRand(5));
    stops.push(() => {
      bots.stop();
      auto.stop();
      if (personTimer) clearTimeout(personTimer);
    });
    bots.observe(room, g.opening);
    wake();
    await until(() => g.over, 60_000);
    expect(g.winners()).toHaveLength(1);
    const players = new Set(seen.filter((e) => e.kind === 'rgplay').map((e) => (e.kind === 'rgplay' ? e.playerId : '')));
    expect(players.size).toBe(3);
    // every wild named a colour; the stand-in always says last card in time
    for (const e of seen) if (e.kind === 'rgplay' && isWild(e.card)) expect(e.color).toBeTruthy();
    expect(seen.some((e) => e.kind === 'rgmissed' && e.playerId === asha.id)).toBe(false);
    // automatic steps went through RangAuto, never a bot
    expect(g.autoDue).toBe(false);
  }, 70_000);

  it('the stand-in leaves automatic steps to RangAuto and plays nothing out of turn', () => {
    const room = new Room('RBO2');
    const asha = room.addMember('Asha');
    asha.hasRang = true;
    asha.socketId = 's-asha';
    room.setConfig(asha.id, parseConfig({ decks: 1, bluffRule: 'one', game: 'rang' }));
    room.addBot(asha.id, 'Bot A');
    room.start(asha.id);
    const bots = new RangBots({ onMove: () => {}, onChat: () => {} }, () => true, 0.002, seededRand(4));
    const g = room.rang!;
    const other = g.order.find((id) => id !== g.turnId)!;
    expect(bots.playFor(room, other)).toEqual([]);
    bots.stop();
  });
});
