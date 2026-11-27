import { describe, expect, it } from 'vitest';
import { FRUIT_BOT, FRUIT_CLOCK_SLACK_MS, FRUIT_COUNTDOWN_MS, FRUIT_GAP_MS, FRUIT_RESULT_MS, FruitGame } from '../src/games/fruit/game.js';
import { fruitModule, parseFruitMove } from '../src/games/fruit/module.js';
import type { GameEvent } from '../src/models.js';
import { FRUIT_COLLECT_MS, FRUIT_ITEM_MS, FRUIT_ITEM_POINTS, FRUIT_MAGNET_ROUNDS, FRUIT_MIN_REACTION_MS, FRUIT_SLOW_MS, type BotLevel, type FruitItemKind } from '../src/types.js';
import { parseConfig } from '../src/validate.js';

const config = (rounds = 15, botLevel: BotLevel = 'hard') => ({ ...parseConfig({ decks: 1, bluffRule: 'one', game: 'fruit', opts: { rounds } }), botLevel });

/** a game on a clock the test moves */
function game(ids = ['A', 'B'], opts: { rounds?: number; bots?: string[]; level?: BotLevel; jitter?: () => number } = {}) {
  let t = 1_000_000;
  const clock = { now: () => t, set: (ms: number) => (t = ms), add: (ms: number) => (t += ms) };
  const g = new FruitGame(ids, config(opts.rounds, opts.level), () => 0, opts.bots ?? [], clock.now, opts.jitter ?? (() => 0.5));
  return { g, clock };
}

/** a started game with this item up now */
function withItem(kind: FruitItemKind = 'melon', ids = ['A', 'B'], opts: Parameters<typeof game>[1] = {}) {
  const r = game(ids, opts);
  r.clock.set(r.g.startsAt);
  r.g.go();
  r.clock.set(r.g.nextItemAt);
  r.g.showItem();
  r.g.item!.kind = kind;
  return r;
}

const kinds = (events: GameEvent[]) => events.map((e) => (e.kind === 'fruit' ? `fruit:${e.ev.type}` : e.kind));

describe('Fruit Slice Duel rules: reaction duel', () => {
  it('3 s countdown, a random wait, then one item at a time; nobody has a turn', () => {
    const { g, clock } = game(['A', 'B', 'C'], { jitter: () => 0 });
    expect(g.turnId).toBeNull();
    expect(g.startsAt).toBe(clock.now() + FRUIT_COUNTDOWN_MS);
    expect(g.view()).toEqual({ phase: 'countdown', round: 0, rounds: 15, item: null, result: null, scores: { A: 0, B: 0, C: 0 }, slow: { A: 0, B: 0, C: 0 }, startsAt: g.startsAt, now: clock.now() });
    expect(g.nextStep()!.at).toBe(g.startsAt);
    clock.set(g.startsAt);
    expect(kinds(g.nextStep()!.run())).toEqual(['fruit:go']);
    expect(g.nextItemAt - clock.now()).toBe(FRUIT_GAP_MS[0]);
    clock.set(g.nextItemAt);
    const [e] = g.nextStep()!.run();
    // jitter 0: a magnet first
    expect(e).toEqual({ kind: 'fruit', ev: { type: 'item', round: 1, kind: 'magnet' } });
    expect(g.view()).toMatchObject({ phase: 'play', round: 1, item: { round: 1, kind: 'magnet', shownAt: clock.now() } });
    expect(game(['A', 'B'], { rounds: 25 }).g.rounds).toBe(25);
    expect(() => new FruitGame(['A'], config())).toThrow('Fruit Slice Duel needs 2 to 4 players');
  });

  it('refuses strikes before the countdown, between items, for another item, twice, or after it closed', () => {
    const { g, clock } = game();
    expect(() => g.strike('A', 1, 300)).toThrow('Wait for the countdown');
    clock.set(g.startsAt);
    g.go();
    expect(() => g.strike('A', 1, 300)).toThrow('Wait for the item to show');
    clock.set(g.nextItemAt);
    g.showItem();
    clock.add(400);
    expect(() => g.strike('A', 2, 300)).toThrow('Wait for the item to show');
    expect(kinds(g.strike('A', 1, 300))).toEqual(['fruit:strike']);
    expect(() => g.strike('A', 1, 300)).toThrow('You already struck this one');
    clock.add(FRUIT_COLLECT_MS + 1);
    expect(() => g.strike('B', 1, 300)).toThrow('Too late, that item is over');
    g.resolve();
    expect(() => g.strike('B', 1, 300)).toThrow('Too late, that item is over');
    expect(() => g.strike('Z', 1, 300)).toThrow("You're not playing this game");
  });

  it('a faked-too-fast reaction (under 110 ms) is refused', () => {
    const { g, clock } = withItem();
    clock.add(500);
    expect(() => g.strike('A', 1, FRUIT_MIN_REACTION_MS - 1)).toThrow('Too fast to be real, that strike did not count');
    expect(kinds(g.strike('A', 1, FRUIT_MIN_REACTION_MS))).toEqual(['fruit:strike']);
  });

  it('a reaction longer than the time since the item showed (a strike before it could be seen) is refused', () => {
    const { g, clock } = withItem();
    clock.add(300);
    expect(() => g.strike('A', 1, 300 + FRUIT_CLOCK_SLACK_MS + 1)).toThrow("That strike doesn't match the clock, it did not count");
    expect(kinds(g.strike('A', 1, 300 + FRUIT_CLOCK_SLACK_MS))).toEqual(['fruit:strike']);
  });

  it('collects for 700 ms after the first strike; the smallest reaction wins even if it arrived later', () => {
    const { g, clock } = withItem('melon', ['A', 'B', 'C']);
    const shown = g.item!.shownAt;
    clock.add(350);
    g.strike('A', 1, 330);
    expect(g.deadline()).toBe(clock.now() + FRUIT_COLLECT_MS);
    expect(g.nextStep()!.at).toBe(g.deadline());
    // B's phone is slower: its strike lands later but its reaction was quicker
    clock.add(500);
    g.strike('B', 1, 290);
    clock.set(g.deadline());
    const ev = g.nextStep()!.run();
    expect(ev).toEqual([{ kind: 'fruit', ev: { type: 'result', round: 1, kind: 'melon', winner: 'B', points: FRUIT_ITEM_POINTS.melon, slowed: [] } }]);
    expect(g.view()).toMatchObject({ item: null, result: { round: 1, kind: 'melon', winner: 'B', reactions: { A: 330, B: 290, C: null }, slowed: [] }, scores: { A: 0, B: 3, C: 0 } });
    // the result shows, then the next wait
    expect(g.nextItemAt - clock.now()).toBe(FRUIT_RESULT_MS + FRUIT_GAP_MS[0] + 0.5 * (FRUIT_GAP_MS[1] - FRUIT_GAP_MS[0]));
    expect(shown).toBeLessThan(clock.now());
  });

  it('closes at once when everyone has struck; nobody strikes = nobody scores after 2.5 s', () => {
    const a = withItem('apple');
    a.clock.add(300);
    a.g.strike('A', 1, 280);
    a.clock.add(20);
    expect(kinds(a.g.strike('B', 1, 260))).toEqual(['fruit:strike', 'fruit:result']);
    expect(a.g.view().result!.winner).toBe('B');
    const b = withItem('apple');
    expect(b.g.nextStep()!.at).toBe(b.g.item!.shownAt + FRUIT_ITEM_MS);
    b.clock.add(FRUIT_ITEM_MS);
    expect(b.g.nextStep()!.run()).toEqual([{ kind: 'fruit', ev: { type: 'result', round: 1, kind: 'apple', winner: null, points: 0, slowed: [] } }]);
    expect(b.g.view().scores).toEqual({ A: 0, B: 0 });
  });

  it('a dead heat goes to the strike the server got first', () => {
    const { g, clock } = withItem('grapes');
    clock.add(400);
    g.strike('B', 1, 300);
    clock.add(10);
    g.strike('A', 1, 300);
    expect(g.view().result).toMatchObject({ winner: 'B' });
  });

  it('a magnet gives no points and slows whoever struck it for the next 2 items (+350 ms each)', () => {
    const { g, clock } = withItem('magnet');
    clock.add(400);
    g.strike('A', 1, 250);
    clock.set(g.deadline());
    expect(g.nextStep()!.run()).toEqual([{ kind: 'fruit', ev: { type: 'result', round: 1, kind: 'magnet', winner: null, points: 0, slowed: ['A'] } }]);
    expect(g.view()).toMatchObject({ scores: { A: 0, B: 0 }, slow: { A: FRUIT_MAGNET_ROUNDS, B: 0 } });
    // item 2: A is quicker by 200 ms but slowed by 350
    const next = (kind: FruitItemKind, a: number, b: number) => {
      clock.set(g.nextItemAt);
      g.showItem();
      g.item!.kind = kind;
      clock.add(900);
      g.strike('A', g.round, a);
      return g.strike('B', g.round, b);
    };
    next('apple', 300, 500);
    expect(g.view().result).toMatchObject({ winner: 'B', reactions: { A: 300 + FRUIT_SLOW_MS, B: 500 } });
    expect(g.view().slow).toEqual({ A: 1, B: 0 });
    next('apple', 300, 500);
    expect(g.view().result).toMatchObject({ winner: 'B' });
    expect(g.view().slow).toEqual({ A: 0, B: 0 });
    // back to full speed
    next('apple', 300, 500);
    expect(g.view().result).toMatchObject({ winner: 'A', reactions: { A: 300, B: 500 } });
    expect(fruitModule.tallies(g, 'A')).toEqual({ won: 1, magnets: 1, bestReflex: 700 });
    expect(fruitModule.tallies(g, 'B')).toEqual({ won: 2, magnets: 0, bestReflex: 500 });
  });

  it('never two magnets in a row; about 1 in 4 items is a magnet; waits are 1.0 to 2.6 s', () => {
    let s = 7;
    const r = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    const { g, clock } = game(['A', 'B'], { rounds: 25, jitter: r });
    // endless, for the count
    Object.assign(g, { rounds: Infinity });
    clock.set(g.startsAt);
    g.go();
    const items: FruitItemKind[] = [];
    let prev = clock.now();
    for (let i = 0; i < 2000; i++) {
      clock.set(g.nextItemAt);
      const wait = clock.now() - prev;
      expect(wait).toBeGreaterThanOrEqual(i === 0 ? FRUIT_GAP_MS[0] : FRUIT_RESULT_MS + FRUIT_GAP_MS[0]);
      expect(wait).toBeLessThanOrEqual((i === 0 ? 0 : FRUIT_RESULT_MS) + FRUIT_GAP_MS[1]);
      g.showItem();
      items.push(g.item!.kind);
      clock.add(FRUIT_ITEM_MS);
      g.resolve();
      prev = clock.now();
    }
    for (let i = 1; i < items.length; i++) expect(items[i] === 'magnet' && items[i - 1] === 'magnet').toBe(false);
    const share = items.filter((k) => k === 'magnet').length / items.length;
    expect(share).toBeGreaterThan(0.2);
    expect(share).toBeLessThan(0.3);
    expect(new Set(items.filter((k) => k !== 'magnet')).size).toBe(6);
  });

  it('over after the last item: highest score wins, ties share', () => {
    const { g, clock } = withItem('mango', ['A', 'B', 'C'], { rounds: 15 });
    g.round = 15;
    g.item!.round = 15;
    g.scores.set('A', 4).set('B', 6);
    clock.add(500);
    g.strike('A', 15, 200);
    clock.set(g.deadline());
    expect(kinds(g.resolve())).toEqual(['fruit:result', 'gameOver']);
    expect(g.view().phase).toBe('over');
    expect(g.winners()).toEqual(['A', 'B']);
    expect(g.losers()).toEqual(['C']);
    expect([g.placeOf('A'), g.placeOf('B'), g.placeOf('C')]).toEqual([1, 1, 3]);
    const n = (id: string | null) => `P${id}`;
    expect(fruitModule.describe(g, { kind: 'gameOver', loserId: null }, n)).toEqual(['over', 'Game over! PA and PB share first with 6 points 🎉']);
    expect(() => g.strike('A', 15, 200)).toThrow('The game is over');
  });

  it('a walk-out leaving one hands them the game; a kick stops it; a walk-out may close the item', () => {
    const a = game().g;
    a.leave('B');
    expect(a.winners()).toEqual(['A']);
    const b = game().g;
    b.removePlayer('B');
    expect(b.aborted).toBe(true);
    const { g, clock } = withItem('apple', ['A', 'B', 'C']);
    clock.add(300);
    g.strike('A', 1, 250);
    g.strike('B', 1, 260);
    expect(kinds(g.leave('C'))).toEqual(['fruit:result']);
  });

  it('parses strikes; strikes bump the timer key; announcements stay sparse', () => {
    expect(parseFruitMove({ type: 'strike', round: 3, reaction: 312.6 })).toEqual({ type: 'strike', round: 3, reaction: 313 });
    for (const bad of [{ type: 'slice', ids: [1], at: 0 }, { type: 'strike', round: 0, reaction: 300 }, { type: 'strike', round: 1.5, reaction: 300 }, { type: 'strike', round: 1, reaction: -1 }, { type: 'strike', round: 1, reaction: NaN }, null]) expect(() => parseFruitMove(bad)).toThrow('Invalid move');
    const { g, clock } = withItem();
    const k = fruitModule.turnKey(g);
    clock.add(300);
    fruitModule.move(g, 'A', { type: 'strike', round: 1, reaction: 280 });
    expect(fruitModule.turnKey(g)).not.toBe(k);
    expect(fruitModule.live).toBeUndefined();
    const n = (id: string | null) => `P${id}`;
    expect(fruitModule.describe(g, { kind: 'fruit', ev: { type: 'go', rounds: 15 } }, n)).toEqual(['round', 'Swords ready! 15 items, fastest strike takes the fruit. Never cut the magnet 🧲']);
    expect(fruitModule.describe(g, { kind: 'fruit', ev: { type: 'result', round: 1, kind: 'apple', winner: 'A', points: 1, slowed: [] } }, n)).toBeNull();
  });
});

/** a small seeded random for repeatable sims */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** a bots-only game through its timed steps */
function simulate(ids: string[], level: BotLevel, seed: number, rounds = 25) {
  const { g, clock } = game(ids, { rounds, bots: ids, level, jitter: rng(seed) });
  let steps = 0;
  for (let s = g.nextStep(); s; s = g.nextStep()) {
    clock.set(Math.max(clock.now(), s.at));
    s.run();
    if (++steps > 10_000) throw new Error('runaway');
  }
  return g;
}

describe('Fruit Slice Duel bots', () => {
  it('bots finish games and strike in their level\'s reaction range', () => {
    for (const level of ['normal', 'hard', 'expert'] as BotLevel[]) {
      let reactions: number[] = [];
      for (let i = 0; i < 40; i++) {
        const g = simulate(['X', 'Y'], level, 100 + i);
        expect(g.over).toBe(true);
        expect(g.round).toBe(25);
        expect(g.winners().length).toBeGreaterThan(0);
        reactions = reactions.concat(Object.values(g.result!.reactions).filter((r): r is number => r !== null));
      }
      // the last results' reactions (slowed swords add 350)
      const [lo, hi] = FRUIT_BOT[level].reaction;
      expect(reactions.every((r) => (r >= lo && r <= hi) || (r >= lo + FRUIT_SLOW_MS && r <= hi + FRUIT_SLOW_MS))).toBe(true);
      expect(reactions.length).toBeGreaterThan(0);
    }
  });

  it('magnet mistakes fall with level (18% / 9% / 4%); better levels react faster', () => {
    const rate: Record<string, number> = {};
    const avg: Record<string, number> = {};
    for (const level of ['normal', 'hard', 'expert'] as BotLevel[]) {
      let struck = 0;
      let chances = 0;
      let sum = 0;
      let n = 0;
      for (let i = 0; i < 80; i++) {
        const { g, clock } = game(['X', 'Y', 'Z'], { rounds: 25, bots: ['X', 'Y', 'Z'], level, jitter: rng(300 + i) });
        for (let s = g.nextStep(); s; s = g.nextStep()) {
          clock.set(Math.max(clock.now(), s.at));
          for (const e of s.run()) {
            if (e.kind !== 'fruit' || e.ev.type !== 'result') continue;
            if (e.ev.kind === 'magnet') {
              chances += 3;
              struck += e.ev.slowed.length;
            } else if (e.ev.winner) {
              sum += g.result!.reactions[e.ev.winner]!;
              n++;
            }
          }
        }
      }
      rate[level] = struck / chances;
      avg[level] = sum / n;
      if (process.env.SIM_LOG) console.log(level, { magnetRate: rate[level], winningReaction: avg[level] });
    }
    expect(rate.normal).toBeGreaterThan(rate.hard);
    expect(rate.hard).toBeGreaterThan(rate.expert);
    expect(Math.abs(rate.normal - FRUIT_BOT.normal.magnet)).toBeLessThan(0.05);
    expect(Math.abs(rate.expert - FRUIT_BOT.expert.magnet)).toBeLessThan(0.03);
    expect(avg.normal).toBeGreaterThan(avg.hard);
    expect(avg.hard).toBeGreaterThan(avg.expert);
  });
});
