import { describe, expect, it } from 'vitest';
import type { Crazy7Action, Crazy7Personality, Rand, SeatView } from '../src/crazy7/bot-models.js';
import { candidates, CRAZY7_STYLES, makePersonality, seededRand, think } from '../src/crazy7/brain.js';
import { Crazy7Game } from '../src/crazy7/game.js';
import { Crazy7Memory } from '../src/crazy7/memory.js';
import type { GameEvent } from '../src/models.js';
import type { GameConfig } from '../src/types.js';

const BASE: GameConfig = {
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

/** the table as one seat sees it: the same fields Room.view sends, nothing hidden */
function viewFor(g: Crazy7Game, id: string): SeatView {
  return {
    meId: id,
    turnId: g.turnId,
    config: g.config,
    hand: [...g.hand(id)],
    players: g.order.map((p) => ({ id: p, cardCount: g.hand(p).length })),
    c7: {
      top: g.top(),
      under: g.pile.slice(-4, -1),
      pileCount: g.pile.length,
      deckCount: g.deck.length,
      penalty: g.penalty,
      picks: g.picks,
      playable: g.playable(id).map((c) => c.id),
      canPick: g.canPick(id),
      canPass: g.canPass(id),
      canCall: g.canCall(id),
      picked: g.turnId === id ? [...g.picked] : [],
      called: [...g.called],
      missed: [...g.missed],
      atRisk: g.atRisk,
      last: g.last ? { ...g.last } : null,
    },
  };
}

/** the simple player the bots must beat: first matching card, else pick, else pass */
function greedy(v: SeatView): Crazy7Action {
  if (v.c7.playable.length > 0) return { kind: 'play', cardId: v.c7.playable[0] };
  return v.c7.canPick ? { kind: 'pick' } : { kind: 'pass' };
}

type Kind = 'bot' | 'greedy';

/** a whole game through the real rules; bots say "last card" before their second-last card, like the driver */
function playGame(config: GameConfig, kinds: Kind[], seed: number, limits: { budgetMs: number; maxPlayouts: number }) {
  const rand: Rand = seededRand(seed);
  const ids = kinds.map((_, i) => `p${i}`);
  const g = new Crazy7Game(ids, config, (max) => Math.floor(rand() * max));
  const mems = new Map(ids.map((id) => [id, new Crazy7Memory(id, config)]));
  const people = new Map<string, Crazy7Personality>(ids.map((id, i) => [id, makePersonality(CRAZY7_STYLES[i % 4], rand)]));
  const feed = (events: GameEvent[]) => mems.forEach((m) => m.observe(events));
  feed(g.opening);
  const missed: string[] = [];
  let moves = 0;
  while (!g.over && moves++ < 3000) {
    const id = g.turnId!;
    const kind = kinds[ids.indexOf(id)];
    const view = viewFor(g, id);
    const mem = mems.get(id)!;
    mem.sync(view.c7);
    const action = kind === 'bot' ? think({ view, mem, me: people.get(id)!, rand, ...limits }).action : greedy(view);
    // only ever one of the moves the rules offer right now
    if (kind === 'bot') expect(candidates(view)).toContainEqual(action);
    const events: GameEvent[] = [];
    // stacking a 7 as your second-last card: the rules don't let you say it first, and the turn can come straight back
    const noChance = action.kind === 'play' && g.penalty > 0 && g.hand(id).length === 2 && !g.canCall(id);
    if (action.kind === 'play') {
      const card = g.hand(id).find((c) => c.id === action.cardId)!;
      expect(g.fits(card)).toBe(true);
      if (g.hand(id).length === 2 && g.canCall(id)) events.push(...g.call(id));
      events.push(...g.play(id, action.cardId));
      if (g.atRisk === id && g.canCall(id)) events.push(...g.call(id));
    } else if (action.kind === 'pick') {
      events.push(...g.pick(id));
    } else {
      events.push(...g.pass(id));
    }
    for (const e of events) if (e.kind === 'c7missed' && !(noChance && e.playerId === id)) missed.push(e.playerId);
    feed(events);
  }
  return { g, missed, moves };
}

describe('crazy 7 bots', () => {
  it('play whole games by the rules with every setting', () => {
    let games = 0;
    let seed = 1;
    for (const handSize of [5, 7] as const) {
      for (const maxPicks of [1, 3, 7]) {
        for (const stack7 of [true, false]) {
          for (const decks of [1, 2] as const) {
            for (const seats of [2, 3, 4, 5]) {
              for (let k = 0; k < 2; k++) {
                const config = { ...BASE, handSize, maxPicks, stack7, decks };
                const { g, missed } = playGame(config, Array(seats).fill('bot'), seed++, { budgetMs: 1, maxPlayouts: 2 });
                expect(g.over).toBe(true);
                expect(g.winners()).toHaveLength(1);
                // bots always say "last card" in time
                expect(missed).toEqual([]);
                games++;
              }
            }
          }
        }
      }
    }
    expect(games).toBe(192);
  }, 120_000);

  it('search bots beat simple players clearly', () => {
    const GAMES = 300;
    let botWins = 0;
    for (let i = 0; i < GAMES; i++) {
      // seats alternate, and who sits where swaps every game, so turn order favours nobody
      const kinds: Kind[] = i % 2 === 0 ? ['bot', 'greedy', 'bot', 'greedy'] : ['greedy', 'bot', 'greedy', 'bot'];
      const { g } = playGame(BASE, kinds, 1000 + i, { budgetMs: 1e9, maxPlayouts: 40 });
      const winner = g.winners()[0];
      if (kinds[g.order.indexOf(winner)] === 'bot') botWins++;
    }
    const rate = botWins / GAMES;
    console.log(`2 search bots vs 2 simple players: bots won ${botWins}/${GAMES} (${Math.round(rate * 100)}%, even would be 50%)`);
    expect(rate).toBeGreaterThan(0.53);
  }, 180_000);

  it('decides from its own view only: hidden cards moved around change nothing', () => {
    const rand = seededRand(7);
    const ids = ['a', 'b', 'c'];
    const g = new Crazy7Game(ids, { ...BASE, maxPicks: 3 }, (max) => Math.floor(rand() * max));
    // play a few turns so there's a pile and some reads
    const mem = new Crazy7Memory('a', g.config);
    mem.observe(g.opening);
    for (let i = 0; i < 6 && !g.over; i++) {
      const id = g.turnId!;
      const a = greedy(viewFor(g, id));
      mem.observe(a.kind === 'play' ? g.play(id, a.cardId) : a.kind === 'pick' ? g.pick(id) : g.pass(id));
    }
    while (!g.over && g.turnId !== 'a') {
      const id = g.turnId!;
      const a = greedy(viewFor(g, id));
      mem.observe(a.kind === 'play' ? g.play(id, a.cardId) : a.kind === 'pick' ? g.pick(id) : g.pass(id));
    }
    if (g.over) return;
    const me = makePersonality('counter', seededRand(3));
    const before = viewFor(g, 'a');
    mem.sync(before.c7);
    const first = think({ view: before, mem, me, rand: seededRand(42), budgetMs: 1000, maxPlayouts: 12 });

    // swap hidden cards between the other hands and the deck, keeping every count the same
    const s = g.state();
    const hidden = [...s.hands.get('b')!, ...s.hands.get('c')!, ...s.deck].reverse();
    s.hands.set('b', hidden.splice(0, s.hands.get('b')!.length));
    s.hands.set('c', hidden.splice(0, s.hands.get('c')!.length));
    s.deck = hidden;
    const other = Crazy7Game.fromState(s);
    other.last = g.last;
    other.moveSeq = g.moveSeq;
    const after = viewFor(other, 'a');
    expect(after).toEqual(before);
    const second = think({ view: after, mem, me, rand: seededRand(42), budgetMs: 1000, maxPlayouts: 12 });
    expect(second.action).toEqual(first.action);
    expect(second.scores).toEqual(first.scores);
  });

  it('remembers what an opponent cannot be holding after a forced pick', () => {
    const mem = new Crazy7Memory('me', BASE);
    mem.observe([
      { kind: 'c7pick', playerId: 'x', count: 1, forced: true, top: { id: '5H1', rank: '5', suit: 'H' } },
      { kind: 'c7penalty', playerId: 'y', count: 2, missed: false, forced: true },
    ]);
    const x = mem.read('x');
    expect([...x.voidSuits]).toEqual(['H']);
    expect([...x.voidRanks]).toEqual(['5']);
    expect(x.fresh).toBe(1);
    expect([...mem.read('y').voidRanks]).toEqual(['7']);
    // the one fresh card shows up: it's the heart they picked, and the read still stands for the rest
    mem.observe([{ kind: 'c7play', playerId: 'x', card: { id: '9H1', rank: '9', suit: 'H' }, penalty: 0 }]);
    expect(x.fresh).toBe(0);
    expect(mem.pile.map((c) => c.id)).toEqual(['9H1']);
  });
});
