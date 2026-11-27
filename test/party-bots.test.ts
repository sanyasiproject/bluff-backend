import { describe, expect, it } from 'vitest';
import { RmcsGame } from '../src/games/rmcs/game.js';
import { rmcsModule } from '../src/games/rmcs/module.js';
import { SnakesGame } from '../src/games/snakes/game.js';
import { snakesModule } from '../src/games/snakes/module.js';
import { RMCS_POINTS } from '../src/types.js';
import { parseConfig } from '../src/validate.js';

/** a seeded random number in [0, 1) */
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

const ROUND_POINTS = Object.values(RMCS_POINTS).reduce((a, b) => a + b, 0);

describe('Saanp Seedhi bots', () => {
  it('finish hundreds of games with every rule mix and player count without getting stuck', () => {
    let games = 0;
    const flags = [true, false];
    for (const exact of flags) for (const six of flags) for (const bonus of flags) for (const bite of flags) {
      for (const n of [2, 3, 4]) {
        for (let i = 0; i < 6; i++) {
          const r = seeded(games * 7919 + 17);
          const ids = Array.from({ length: n }, (_, k) => `b${k}`);
          const config = parseConfig({ decks: 1, bluffRule: 'one', game: 'snakes', opts: { exact, six, bonus, bite } });
          const g = new SnakesGame(ids, config, (max) => Math.floor(r() * max), ids, r);
          let steps = 0;
          while (!g.over) {
            if (++steps > 20_000) throw new Error(`stuck: ${JSON.stringify(g.rules)} ${n} game ${games}`);
            const step = snakesModule.auto(g)!;
            expect(step.delayMs).toBeGreaterThan(0);
            step.run();
          }
          expect(g.winners()).toHaveLength(1);
          expect(g.places).toHaveLength(n - 1);
          expect(g.seats.filter((s) => s.place === null)).toHaveLength(1);
          games++;
        }
      }
    }
    expect(games).toBe(288);
  });
});

describe('Raja Mantri bots', () => {
  it('finish hundreds of games: every round deals all four chits, points always add to the same total, guesses are about 50/50', () => {
    let right = 0;
    let guesses = 0;
    for (let i = 0; i < 300; i++) {
      const r = seeded(i + 1);
      const ids = ['p0', 'p1', 'p2', 'p3'];
      const rounds = i % 2 ? 10 : 5;
      const config = parseConfig({ decks: 1, bluffRule: 'one', game: 'rmcs', opts: { rounds } });
      const g = new RmcsGame(ids, config, (max) => Math.floor(r() * max), ids, () => 0, r);
      let steps = 0;
      while (!g.over) {
        if (++steps > 1_000) throw new Error(`stuck: game ${i}`);
        rmcsModule.auto(g)!.run();
      }
      expect(g.history).toHaveLength(rounds);
      for (const h of g.history) expect(new Set(Object.values(h.roles)).size).toBe(4);
      const total = [...g.scores.values()].reduce((a, b) => a + b, 0);
      expect(total).toBe(rounds * ROUND_POINTS);
      expect(g.winners().length).toBeGreaterThan(0);
      right += g.history.filter((h) => h.correct).length;
      guesses += g.history.length;
    }
    expect(right / guesses).toBeGreaterThan(0.45);
    expect(right / guesses).toBeLessThan(0.55);
  });
});
