import { describe, expect, it } from 'vitest';
import { FRUIT_COUNTDOWN_MS, FruitGame, onScreen, peakMsOf } from '../src/games/fruit/game.js';
import { fruitModule, parseFruitMove } from '../src/games/fruit/module.js';
import { FRUIT_POINTS, FRUIT_SLICE_SLACK_MS, fruitWave, type BotLevel, type FruitSpawn } from '../src/types.js';
import { parseConfig } from '../src/validate.js';

const config = (time?: number, botLevel: BotLevel = 'hard') => ({ ...parseConfig({ decks: 1, bluffRule: 'one', game: 'fruit', opts: time ? { time } : {} }), botLevel });

/** a game on a clock the test moves */
function game(ids = ['A', 'B'], bots: string[] = [], time = 45, level: BotLevel = 'hard', seed = 7, jitter: () => number = Math.random) {
  let t = 1_000_000;
  const clock = { now: () => t, set: (ms: number) => (t = ms) };
  const g = new FruitGame(ids, config(time, level), () => seed - 1, bots, clock.now, jitter);
  return { g, clock, at: (ms: number) => clock.set(g.startsAt + ms) };
}

const fruitOnly = (g: FruitGame) => g.wave.filter((f) => f.kind !== 'bomb');

/** n fruit (no bombs) all on screen at one moment, and that moment */
function together(g: FruitGame, n: number): { ids: number[]; at: number } {
  for (let ms = 0; ms < g.seconds * 1000; ms += 20) {
    const up = fruitOnly(g).filter((f) => onScreen(f, ms));
    if (up.length >= n) return { ids: up.slice(0, n).map((f) => f.id), at: ms };
  }
  throw new Error(`no ${n} fruit together`);
}

describe('Fruit Slice Duel rules', () => {
  it('starts with a 3 s countdown; everyone gets the same seeded wave; nobody has a turn', () => {
    const { g, clock } = game();
    expect(g.turnId).toBeNull();
    expect(g.startsAt).toBe(clock.now() + FRUIT_COUNTDOWN_MS);
    expect(g.endsAt).toBe(g.startsAt + 45_000);
    expect(g.wave).toEqual(fruitWave(g.seed, 45));
    const v = fruitModule.view(g, 'A', true);
    expect(v).toEqual({ kind: 'fruit', fruit: expect.objectContaining({ phase: 'countdown', seed: 7, seconds: 45, scores: { A: 0, B: 0 }, sliced: { A: [], B: [] }, now: clock.now() }) });
    expect(game(['A', 'B'], [], 60).g.seconds).toBe(60);
    expect(() => new FruitGame(['A'], config())).toThrow('Fruit Slice Duel needs 2 to 4 players');
  });

  it('timed steps: the countdown ends at startsAt, then time runs out at endsAt', () => {
    const { g } = game();
    expect(g.nextStep()!.at).toBe(g.startsAt);
    expect(g.nextStep()!.run()).toEqual([{ kind: 'fruit', ev: { type: 'go', seconds: 45 } }]);
    expect(g.phase).toBe('play');
    expect(g.nextStep()!.at).toBe(g.endsAt);
    expect(g.nextStep()!.run()).toEqual([{ kind: 'gameOver', loserId: null }]);
    expect(g.over).toBe(true);
    expect(g.phase).toBe('over');
    expect(g.nextStep()).toBeNull();
  });

  it('a slice scores each fruit once per player, only while it is on screen', () => {
    const { g, at } = game();
    g.go();
    const f = fruitOnly(g)[0];
    const peak = Math.round(peakMsOf(f));
    at(peak + 100);
    expect(g.slice('A', [f.id], peak)).toEqual([{ kind: 'fruit', ev: { type: 'slice', playerId: 'A', ids: [f.id], points: FRUIT_POINTS[f.kind], combo: 1, bomb: false } }]);
    expect(g.scores.get('A')).toBe(FRUIT_POINTS[f.kind]);
    // duplicate by the same player: refused; another player may cut it too
    expect(() => g.slice('A', [f.id], peak + 50)).toThrow('Already sliced');
    expect(g.slice('B', [f.id], peak + 50)[0]).toMatchObject({ ev: { playerId: 'B', points: FRUIT_POINTS[f.kind] } });
    // never on screen at that moment: before it's thrown, or long after it fell
    expect(() => g.slice('A', [fruitOnly(g)[5].id], peak)).toThrow('Nothing to slice there');
    // unknown ids and repeats in one swipe don't count
    const f2 = fruitOnly(g).find((x) => x.id !== f.id && onScreen(x, peak))!;
    if (f2) expect(g.slice('A', [f2.id, f2.id, 99_999], peak)[0]).toMatchObject({ ev: { ids: [f2.id], combo: 1 } });
    expect(g.view().sliced.A).toContain(f.id);
  });

  it('refuses late and early swipes beyond the slack, and swipes during the countdown', () => {
    const { g, at } = game();
    const f = fruitOnly(g)[0];
    const peak = Math.round(peakMsOf(f));
    at(-500);
    expect(() => g.slice('A', [f.id], 0)).toThrow('Wait for the countdown');
    at(peak + FRUIT_SLICE_SLACK_MS + 1);
    expect(() => g.slice('A', [f.id], peak)).toThrow('Too late, that swipe did not count');
    at(peak - FRUIT_SLICE_SLACK_MS - 1);
    expect(() => g.slice('A', [f.id], peak)).toThrow('That swipe is ahead of the clock');
    at(peak + FRUIT_SLICE_SLACK_MS);
    expect(g.slice('A', [f.id], peak)).toHaveLength(1);
    expect(() => g.slice('C', [f.id], peak)).toThrow("You're not playing this game");
    g.finish();
    expect(() => g.slice('B', [f.id], peak)).toThrow("Time's up");
  });

  it('3+ fruit in one swipe add a combo bonus; a bomb costs 10', () => {
    const { g, at } = game();
    g.go();
    const c = together(g, 4);
    at(c.at);
    const fruitPts = c.ids.reduce((n, id) => n + FRUIT_POINTS[g.wave.find((f) => f.id === id)!.kind], 0);
    expect(g.slice('A', c.ids, c.at)[0]).toMatchObject({ ev: { combo: 4, points: fruitPts + 2, bomb: false } });
    expect(g.view().combo.A).toBe(4);
    const bomb = g.wave.find((f) => f.kind === 'bomb')!;
    const t = Math.round(peakMsOf(bomb));
    at(t);
    expect(g.slice('B', [bomb.id], t)[0]).toMatchObject({ ev: { points: -10, combo: 0, bomb: true } });
    expect(g.scores.get('B')).toBe(-10);
    expect(g.view().bombs).toEqual({ A: 0, B: 1 });
    expect(fruitModule.tallies(g, 'A')).toEqual({ sliced: 4, bombs: 0, bestCombo: 4 });
    expect(fruitModule.tallies(g, 'B')).toEqual({ sliced: 0, bombs: 1, bestCombo: 0 });
  });

  it('highest score wins when time runs out; ties share', () => {
    const { g } = game(['A', 'B', 'C']);
    g.scores.set('A', 5).set('B', 5).set('C', 2);
    g.finish();
    expect(g.winners()).toEqual(['A', 'B']);
    expect(g.losers()).toEqual(['C']);
    expect([g.placeOf('A'), g.placeOf('B'), g.placeOf('C')]).toEqual([1, 1, 3]);
    const n = (id: string | null) => `P${id}`;
    expect(fruitModule.describe(g, { kind: 'gameOver', loserId: null }, n)).toEqual(['over', "Time's up! PA and PB share first with 5 points 🎉"]);
  });

  it('a walk-out leaving one player hands them the game; a kick stops it', () => {
    const a = game().g;
    a.leave('B');
    expect(a.over).toBe(true);
    expect(a.winners()).toEqual(['A']);
    expect(a.losers()).toEqual(['A', 'B'].filter((id) => id !== 'A'));
    const b = game().g;
    b.removePlayer('B');
    expect(b.aborted).toBe(true);
    expect(b.winners()).toEqual([]);
    const c = game(['A', 'B', 'C']).g;
    expect(c.leave('C')).toEqual([]);
    expect(c.over).toBe(false);
    expect(c.inPlay('C')).toBe(false);
  });

  it('parses moves and keeps announcements sparse', () => {
    expect(parseFruitMove({ type: 'slice', ids: [1, 2], at: 1234.5 })).toEqual({ type: 'slice', ids: [1, 2], at: 1234.5 });
    for (const bad of [{ type: 'cut', ids: [1], at: 0 }, { type: 'slice', ids: [], at: 0 }, { type: 'slice', ids: [1.5], at: 0 }, { type: 'slice', ids: Array(13).fill(1), at: 0 }, { type: 'slice', ids: [1], at: 'x' }, { type: 'slice', ids: [1], at: NaN }, null]) {
      expect(() => parseFruitMove(bad)).toThrow('Invalid move');
    }
    const { g } = game();
    const n = (id: string | null) => `P${id}`;
    const slice = (combo: number) => ({ kind: 'fruit' as const, ev: { type: 'slice' as const, playerId: 'A', ids: [1], points: 1, combo, bomb: false } });
    expect(fruitModule.describe(g, slice(1), n)).toBeNull();
    expect(fruitModule.describe(g, slice(4), n)).toBeNull();
    expect(fruitModule.describe(g, slice(5), n)).toEqual(['play', 'PA sliced 5 in one swipe! 🔥']);
    expect(fruitModule.describe(g, { kind: 'fruit', ev: { type: 'go', seconds: 45 } }, n)).toEqual(['round', 'Slice! 45 seconds on the clock 🍉']);
    expect(fruitModule.moveRate).toBeGreaterThanOrEqual(100);
    expect(fruitModule.turnKey(g)).toBe(fruitModule.turnKey(g));
  });

  it("people's swipes don't move the timed steps' key; bot swipes and the countdown do", () => {
    const { g, at } = game();
    const k0 = fruitModule.turnKey(g);
    g.go();
    const k1 = fruitModule.turnKey(g);
    expect(k1).not.toBe(k0);
    const f = fruitOnly(g)[0];
    const t = Math.round(peakMsOf(f));
    at(t);
    g.slice('A', [f.id], t);
    expect(fruitModule.turnKey(g)).toBe(k1);
  });
});

/** plays a whole game through its timed steps only, the clock jumping to each one */
function simulate(level: BotLevel, seed: number, jitter: () => number) {
  const ids = ['A', 'B', 'C', 'D'];
  const { g, clock } = game(ids, ids, 45, level, seed, jitter);
  let steps = 0;
  for (let s = g.nextStep(); s; s = g.nextStep()) {
    clock.set(Math.max(clock.now(), s.at));
    s.run();
    if (++steps > 5000) throw new Error('runaway');
  }
  return { g, steps };
}

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

describe('Fruit Slice Duel bots', () => {
  it('bots finish hundreds of games; better levels score more and hit fewer bombs', () => {
    const avg: Record<BotLevel, { score: number; bombs: number; slicedShare: number }> = {} as never;
    for (const level of ['normal', 'hard', 'expert'] as BotLevel[]) {
      let score = 0;
      let bombs = 0;
      let share = 0;
      const games = 120;
      for (let i = 0; i < games; i++) {
        const { g, steps } = simulate(level, 1000 + i, rng(i * 7 + level.length));
        expect(g.over).toBe(true);
        expect(steps).toBeGreaterThan(2);
        expect(g.winners().length).toBeGreaterThan(0);
        const fruit = g.wave.filter((f: FruitSpawn) => f.kind !== 'bomb').length;
        for (const id of g.order) {
          score += g.scores.get(id)!;
          bombs += g.bombs.get(id)!;
          share += (g.stats.get(id)!.tallies as { sliced: number }).sliced / fruit / 4;
        }
      }
      avg[level] = { score: score / games / 4, bombs: bombs / games / 4, slicedShare: share / games };
    }
    expect(avg.normal.score).toBeLessThan(avg.hard.score);
    expect(avg.hard.score).toBeLessThan(avg.expert.score);
    expect(avg.normal.bombs).toBeGreaterThan(avg.expert.bombs);
    // close to the chances by level (55 / 72 / 85 %)
    expect(avg.normal.slicedShare).toBeGreaterThan(0.45);
    expect(avg.normal.slicedShare).toBeLessThan(0.62);
    expect(avg.expert.slicedShare).toBeGreaterThan(0.75);
  });

  it('bot swipes go out in batches, so a game is a few hundred steps at most', () => {
    const { steps } = simulate('expert', 99, rng(5));
    expect(steps).toBeLessThan(400);
  });
});
