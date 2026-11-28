import { describe, expect, it } from 'vitest';
import { aimAt, DART_AIM_NOISE, targetFor } from '../src/games/darts/brain.js';
import { DartsGame } from '../src/games/darts/game.js';
import { dartsModule, parseDartsMove } from '../src/games/darts/module.js';
import { DART_RINGS, dartScore, type BotLevel } from '../src/types.js';
import { parseConfig } from '../src/validate.js';

function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const cfg = (start = 301, botLevel: BotLevel = 'expert') => ({ ...parseConfig({ decks: 1, bluffRule: 'one', game: 'darts', opts: { start } }), botLevel });
const T20 = aimAt(20, (DART_RINGS.trebleIn + DART_RINGS.trebleOut) / 2);
const name = (id: string | null) => id ?? '?';

/** a game where A goes first and darts land exactly where aimed */
function table(start = 301, n = 2) {
  const ids = ['A', 'B', 'C', 'D'].slice(0, n);
  const g = new DartsGame(ids, cfg(start), () => 0, [], seeded(1));
  const at = (id: string, x: number, y: number) => g.throw(id, x, y, 0);
  return { g, at };
}

describe('Darts rules', () => {
  it('scores the board: bull, outer bull, trebles, doubles, singles, miss', () => {
    expect(dartScore(0, 0)).toEqual({ ring: 'bull', number: 25, score: 50 });
    expect(dartScore(0, (DART_RINGS.bull + DART_RINGS.outerBull) / 2).score).toBe(25);
    expect(dartScore(T20.x, T20.y)).toEqual({ ring: 'treble', number: 20, score: 60 });
    const d16 = aimAt(16, (DART_RINGS.doubleIn + DART_RINGS.doubleOut) / 2);
    expect(dartScore(d16.x, d16.y)).toEqual({ ring: 'double', number: 16, score: 32 });
    const s3 = aimAt(3, 0.34);
    expect(dartScore(s3.x, s3.y)).toEqual({ ring: 'single', number: 3, score: 3 });
    expect(dartScore(1.1, 0).score).toBe(0);
  });

  it('three darts a turn, then the board shows them and the next player steps up', () => {
    const { g, at } = table();
    expect(g.turnId).toBe('A');
    expect(() => at('B', 0, 0)).toThrow('Not your turn');
    at('A', T20.x, T20.y);
    at('A', T20.x, T20.y);
    const ev = at('A', T20.x, T20.y);
    expect(g.left.get('A')).toBe(121);
    expect(ev.map((e) => (e.kind === 'darts' ? e.ev.type : e.kind))).toEqual(['throw', 'turnEnd']);
    expect(ev[1]).toMatchObject({ ev: { t180: true, total: 180, bust: false } });
    expect((g.stats.get('A')!.tallies as { t180: number }).t180).toBe(1);
    expect(dartsModule.describe(g, ev[1], name)).toEqual(['play', 'ONE HUNDRED AND EIGHTY! 🎯 A']);
    // the turn is done but still A's until the pause passes
    expect(g.turnDone).toBe(true);
    expect(g.view().thrown).toHaveLength(3);
    expect(() => at('A', 0, 0)).toThrow('Wait for the next turn');
    const step = dartsModule.auto(g)!;
    expect(step.delayMs).toBe(1600);
    step.run();
    expect(g.turnId).toBe('B');
    expect(g.view()).toMatchObject({ thrown: [], turnStart: 301, last: { seq: 3, playerId: 'A' } });
  });

  it('a bust undoes the turn and ends it', () => {
    const { g, at } = table();
    g.left.set('A', 70);
    g.turnStart = 70;
    at('A', T20.x, T20.y);
    expect(g.left.get('A')).toBe(10);
    const ev = at('A', T20.x, T20.y);
    expect(g.left.get('A')).toBe(70);
    expect(g.last).toMatchObject({ bust: true, score: 60, dart: 2 });
    expect(g.turnDone).toBe(true);
    expect(dartsModule.describe(g, ev[1], name)).toEqual(['pass', 'Bust! A stays on 70']);
  });

  it('exactly 0 checks out; play goes on until one player is left', () => {
    const { g, at } = table(301, 3);
    g.left.set('A', 50);
    g.turnStart = 50;
    const ev = at('A', 0, 0);
    expect(ev.map((e) => e.kind)).toEqual(['darts', 'darts', 'finish']);
    expect(g.view().places).toEqual({ A: 1 });
    expect(g.over).toBe(false);
    dartsModule.auto(g)!.run();
    expect(g.turnId).toBe('B');
    g.left.set('B', 3);
    g.turnStart = 3;
    const s3 = aimAt(3, 0.34);
    const end = at('B', s3.x, s3.y);
    expect(end.map((e) => e.kind)).toEqual(['darts', 'darts', 'finish', 'finish', 'gameOver']);
    expect(g.winners()).toEqual(['A']);
    expect(g.losers()).toEqual(['B', 'C']);
    expect([g.placeOf('A'), g.placeOf('B'), g.placeOf('C')]).toEqual([1, 2, 3]);
    expect(dartsModule.describe(g, end[4], name)).toEqual(['over', 'Game over. A wins 🎉']);
    expect(dartsModule.tallies(g, 'A')).toEqual({ t180: 0, bulls: 1, checkouts: 1 });
  });

  it("a person's dart lands exactly where the sweep locked it", () => {
    const g = new DartsGame(['A', 'B'], cfg(), () => 0, [], seeded(9));
    g.throw('A', 0.3, 0.3);
    expect(g.last!.x).toBe(0.3);
    expect(g.last!.y).toBe(0.3);
  });

  it('parses throws and rejects bad ones', () => {
    expect(parseDartsMove({ type: 'throw', x: 0.1, y: -5 })).toEqual({ type: 'throw', x: 0.1, y: -2 });
    expect(() => parseDartsMove({ type: 'throw', x: 'a', y: 0 })).toThrow('Aim at the board');
    expect(() => parseDartsMove({ type: 'throw', x: NaN, y: 0 })).toThrow('Aim at the board');
    expect(() => parseDartsMove({ type: 'roll' })).toThrow('Invalid move');
  });

  it('a walk-out mid-turn hands the turn on; the last one left wins', () => {
    const { g, at } = table();
    at('A', T20.x, T20.y);
    expect(g.leave('A').map((e) => e.kind)).toEqual(['finish', 'gameOver']);
    expect(g.left.get('A')).toBe(301);
    expect(g.winners()).toEqual(['B']);
    expect(g.losers()).toEqual(['A']);
  });

  it('bots aim at an exact finish when one dart can do it', () => {
    for (let left = 1; left <= 60; left++) {
      const t = targetFor(left);
      const hit = dartScore(t.x, t.y).score;
      const one = left <= 20 || (left <= 60 && left % 3 === 0) || (left <= 40 && left % 2 === 0) || left === 25 || left === 50;
      if (one) expect(hit, `left ${left}`).toBe(left);
      else expect(hit, `left ${left}`).toBeLessThan(left);
    }
    expect(dartScore(targetFor(301).x, targetFor(301).y).score).toBe(60);
  });
});

/** a whole bots-only game through auto(); returns darts thrown per player and the winner */
function botGame(levels: BotLevel[], start: 301 | 501, seed: number) {
  const ids = levels.map((_, i) => `b${i}`);
  const r = seeded(seed);
  const g = new DartsGame(ids, cfg(start), (m) => Math.floor(r() * m), ids, r);
  // each bot plays at its own level
  const level = new Map(ids.map((id, i) => [id, levels[i]]));
  let steps = 0;
  while (!g.over) {
    if (++steps > 20_000) throw new Error('stuck');
    g.config.botLevel = level.get(g.turnId!)!;
    dartsModule.auto(g)!.run();
  }
  return { g, winner: g.winners()[0] };
}

describe('Darts bots', () => {
  it('finish hundreds of games with 2 to 4 players at every level', () => {
    let games = 0;
    for (const start of [301, 501] as const) {
      for (const n of [2, 3, 4]) {
        for (const lv of ['normal', 'hard', 'expert'] as BotLevel[]) {
          for (let i = 0; i < 20; i++) {
            const { g } = botGame(Array(n).fill(lv), start, ++games * 31);
            expect(g.places).toHaveLength(n);
            expect([...g.left.values()].filter((v) => v === 0)).toHaveLength(n - 1);
          }
        }
      }
    }
    expect(games).toBe(360);
  }, 60_000);

  it('levels are ordered: Expert beats Hard beats Normal most of the time', () => {
    const wins = (a: BotLevel, b: BotLevel) => {
      let w = 0;
      for (let i = 0; i < 200; i++) if (botGame([a, b], 301, 7000 + i).winner === 'b0') w++;
      return w / 200;
    };
    expect(DART_AIM_NOISE.expert).toBeLessThan(DART_AIM_NOISE.hard);
    expect(wins('expert', 'normal')).toBeGreaterThan(0.6);
    expect(wins('hard', 'normal')).toBeGreaterThan(0.55);
  }, 60_000);
});
