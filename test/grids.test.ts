import { describe, expect, it } from 'vitest';
import { COLORWAR_MAX_WAVES } from '../src/games/colorwar/board.js';
import { decide as cwDecide } from '../src/games/colorwar/brain.js';
import { ColorWarGame } from '../src/games/colorwar/game.js';
import { decide as dotsDecide } from '../src/games/dots/brain.js';
import { DotsGame } from '../src/games/dots/game.js';
import { SpikesGame } from '../src/games/spikes/game.js';
import { dotsLineCount, gameInfo, gameOpt, SPIKES_RADIUS, type BotLevel, type GameKind } from '../src/types.js';
import { parseConfig } from '../src/validate.js';

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const cfg = (game: GameKind, size?: number, botLevel: BotLevel = 'hard') =>
  ({ ...parseConfig({ decks: 1, bluffRule: 'one', game, opts: size === undefined ? {} : { size } }), botLevel });

describe('bigger boards: options', () => {
  it('every old size stays a choice, 8 × 8 and 10 × 10 are added and new rooms start on 8 × 8', () => {
    const sizes = (k: GameKind) => gameInfo(k).options.find((o) => o.id === 'size')!.choices.map((c) => c.value);
    expect(sizes('dots')).toEqual([4, 5, 6, 8, 10]);
    expect(sizes('colorwar')).toEqual([5, 7, 8, 10]);
    expect(sizes('spikes')).toEqual([5, 6, 8, 10]);
    for (const k of ['dots', 'colorwar', 'spikes'] as GameKind[]) {
      expect(gameOpt(cfg(k), 'size')).toBe(8);
      // an older saved room keeps its size
      expect(gameOpt(cfg(k, 5), 'size')).toBe(5);
    }
  });

  it('each game is built at every size', () => {
    for (const size of [4, 5, 6, 8, 10]) {
      const g = new DotsGame(['A', 'B'], cfg('dots', size), () => 0);
      expect(g.size).toBe(size);
      expect(g.freeLines()).toHaveLength(dotsLineCount(size));
    }
    expect(dotsLineCount(10)).toBe(220);
    for (const size of [5, 7, 8, 10]) {
      const g = new ColorWarGame(['A', 'B'], cfg('colorwar', size), () => 0);
      expect(g.view().size).toBe(size);
      expect(g.cells).toHaveLength(size * size);
    }
    for (const size of [5, 6, 8, 10]) {
      const g = new SpikesGame(['A', 'B', 'C', 'D'], cfg('spikes', size), () => 0);
      expect(g.view()).toMatchObject({ size, pos: { A: [0.5, 0.5], B: [size - 0.5, size - 0.5] } });
    }
  });
});

describe('bigger boards: bots finish at 10 × 10, quickly', () => {
  it('Dots and Boxes: every level, the slowest move stays fast (Expert counts chains in bounded work)', () => {
    for (const level of ['normal', 'hard', 'expert'] as BotLevel[]) {
      for (let seed = 1; seed <= 3; seed++) {
        const r = rng(seed);
        const g = new DotsGame(['A', 'B', 'C'], cfg('dots', 10, level), (n) => Math.floor(r() * n));
        let worst = 0;
        let moves = 0;
        while (!g.over) {
          const t = performance.now();
          const m = dotsDecide(g, g.turnId!, level, r);
          worst = Math.max(worst, performance.now() - t);
          g.draw(g.turnId!, m.line);
          if (++moves > 300) throw new Error('runaway');
        }
        expect(moves).toBe(220);
        expect(worst).toBeLessThan(250);
      }
    }
  }, 60_000);

  it('Colour Wars: every level finishes, chains stay under the wave cap, moves stay fast', () => {
    for (const level of ['normal', 'hard', 'expert'] as BotLevel[]) {
      for (let seed = 1; seed <= 3; seed++) {
        const r = rng(seed);
        const g = new ColorWarGame(['A', 'B', 'C', 'D'], cfg('colorwar', 10, level), (n) => Math.floor(r() * n), [], r);
        let worst = 0;
        let waves = 0;
        for (let moves = 0; !g.over; moves++) {
          const id = g.turnId!;
          const t = performance.now();
          const m = cwDecide(g, id, level, r);
          worst = Math.max(worst, performance.now() - t);
          g.tap(id, m.cell);
          waves = Math.max(waves, g.view().last?.waves.length ?? 0);
          if (moves > 2_000) throw new Error('runaway');
        }
        expect(waves).toBeLessThan(COLORWAR_MAX_WAVES);
        expect(worst).toBeLessThan(400);
      }
    }
  }, 60_000);

  it('Spike Attack: bot games end, nobody is ever inside a crate, even across crate shifts', () => {
    for (const size of [8, 10]) {
      for (let seed = 1; seed <= 3; seed++) {
        const r = rng(seed);
        let t = 1_000_000;
        const ids = ['A', 'B', 'C', 'D'];
        const g = new SpikesGame(ids, cfg('spikes', size, 'normal'), (n) => Math.floor(r() * n), ids, () => t, r);
        let shifts = 0;
        let steps = 0;
        for (let s = g.nextStep(); s; s = g.nextStep()) {
          t = Math.max(t, s.at);
          const ev = s.run();
          shifts += ev.filter((e) => e.kind === 'spikes' && e.ev.type === 'shift' && e.ev.phase === 'land').length;
          for (const id of ids) {
            if (!g.alive(id)) continue;
            const [x, y] = g.pos.get(id)!;
            const inside = g.boxes.some(([c, rr]) => Math.hypot(x - Math.min(c + 1, Math.max(c, x)), y - Math.min(rr + 1, Math.max(rr, y))) < SPIKES_RADIUS - 1e-6);
            expect(inside).toBe(false);
          }
          if (++steps > 400_000) throw new Error('runaway');
        }
        expect(g.over).toBe(true);
        if (t - g.startsAt > 45_000) expect(shifts).toBeGreaterThan(0);
      }
    }
  }, 60_000);
});
