import { describe, expect, it } from 'vitest';
import { strikerFits } from '../src/carrom/index.js';
import { candidates, decide, decideNow } from '../src/games/carrom/brain.js';
import { CarromGame } from '../src/games/carrom/game.js';
import { seatOf } from '../src/games/carrom/module.js';
import type { BotLevel, GameConfig } from '../src/types.js';

const rng = (seed: number) => () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

/** plays a game of bots to the end; levels by seat; sims caps the search so hundreds of games stay quick */
function playOut(ids: string[], mode: string, length: string, levels: BotLevel[], sims: number, seed: number) {
  let t = 1e12;
  const r = rng(seed);
  const config = { game: 'carrom', botLevel: 'hard', opts: { mode, length } } as unknown as GameConfig;
  const g = new CarromGame(ids, config, (n) => Math.floor(r() * n), ids, r, () => t);
  let shots = 0;
  while (!g.over && shots < 1500) {
    const id = g.turnId!;
    const m = decideNow(seatOf(g, id), levels[ids.indexOf(id)], r, sims);
    expect(strikerFits(g.coins, g.sideOf(id), m.x)).toBe(true);
    g.shoot(id, m.x, m.dx, m.dy, m.power);
    t = g.settleAt + 1;
    shots++;
  }
  return { g, shots };
}

describe('Carrom bots', () => {
  it('finish hundreds of games in every mode and size', () => {
    const setups: [string[], string, string][] = [
      [['a', 'b'], 'classic', 'quick'],
      [['a', 'b', 'c', 'd'], 'classic', 'quick'],
      [['a', 'b', 'c'], 'freestyle', 'quick'],
      [['a', 'b', 'c', 'd'], 'freestyle', 'quick'],
    ];
    let games = 0;
    for (let i = 0; i < 200; i++) {
      const [ids, mode, length] = setups[i % setups.length];
      const { g } = playOut(ids, mode, length, ids.map(() => 'expert'), 1, i + 1);
      expect(g.over).toBe(true);
      expect(g.winners().length).toBeGreaterThan(0);
      if (mode === 'classic' && ids.length === 4) expect([['a', 'c'], ['b', 'd']]).toContainEqual(g.winners());
      games++;
    }
    expect(games).toBe(200);
  }, 240_000);

  it('full games end: Classic at 25 or after 8 boards, Freestyle after 3 boards', () => {
    const c = playOut(['a', 'b'], 'classic', 'full', ['expert', 'expert'], 2, 7).g;
    expect(c.over).toBe(true);
    expect(Math.max(...[...c.scores.values()]) >= 25 || c.results.length >= 8).toBe(true);
    const f = playOut(['a', 'b'], 'freestyle', 'full', ['expert', 'expert'], 2, 8).g;
    expect(f.results).toHaveLength(3);
  }, 120_000);

  it('levels are ordered: Expert beats Normal', () => {
    let expert = 0;
    for (let i = 0; i < 8; i++) {
      const ids = i % 2 === 0 ? ['e', 'n'] : ['n', 'e'];
      const { g } = playOut(ids, 'classic', 'quick', ids.map((id) => (id === 'e' ? 'expert' : 'normal')), 12, 100 + i);
      if (g.winners().includes('e')) expert++;
    }
    expect(expert).toBeGreaterThanOrEqual(6);
  }, 120_000);

  it('candidates aim into the board from free spots; the sliced think returns a move', async () => {
    const g = new CarromGame(['a', 'b'], { game: 'carrom', botLevel: 'expert', opts: {} } as unknown as GameConfig, () => 0, ['a', 'b']);
    const s = seatOf(g, 'b');
    for (const m of candidates(s, 'expert', Math.random)) {
      expect(m.dy).toBeGreaterThan(0);
      expect(strikerFits(s.coins, s.side, m.x)).toBe(true);
    }
    const t0 = Date.now();
    const m = await decide(s, 'expert', Math.random, 300);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(m.type).toBe('shot');
  });
});
