import { describe, expect, it } from 'vitest';
import { decide } from '../src/games/ludo/brain.js';
import { LudoGame } from '../src/games/ludo/game.js';
import { ludoModule } from '../src/games/ludo/module.js';
import { LUDO_MODES, type BotLevel, type LudoMode } from '../src/types.js';
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

/** plays one game of bots to the end the way the room does: automatic steps, else each bot's move through the module */
function play(levels: BotLevel[], mode: LudoMode, teams: boolean, seed: number) {
  const r = seeded(seed);
  const ids = levels.map((_, i) => `p${i}`);
  const config = parseConfig({ decks: 1, bluffRule: 'one', game: 'ludo', teams, opts: { mode } });
  const g = new LudoGame(ids, config, (max) => Math.floor(r() * max), 0);
  let steps = 0;
  while (!g.over) {
    if (++steps > 20_000) throw new Error(`stuck: ${mode} ${levels.length}${teams ? ' 2v2' : ''} seed ${seed}`);
    const auto = ludoModule.auto(g);
    if (auto) {
      auto.run();
      continue;
    }
    // Timed: play past the clock only until someone finishes; call time after a long while
    if (mode === 'timed' && steps > 600) {
      g.timeUp();
      break;
    }
    const id = g.turnId!;
    ludoModule.move(g, id, decide(g, id, levels[ids.indexOf(id)], r));
  }
  return { g, ids, steps };
}

describe('Ludo bots', () => {
  it('finish hundreds of games in every mode and player count without getting stuck', () => {
    let games = 0;
    for (const mode of LUDO_MODES) {
      for (const n of [2, 3, 4]) {
        for (let i = 0; i < 60; i++) {
          const levels = Array.from({ length: n }, (_, k) => (['normal', 'hard', 'expert'] as const)[(i + k) % 3]);
          const { g } = play(levels, mode, false, 1000 * n + i + mode.length * 7919);
          expect(g.over).toBe(true);
          expect(g.winners().length).toBeGreaterThan(0);
          games++;
        }
      }
      for (let i = 0; i < 60; i++) {
        const { g } = play(['expert', 'normal', 'hard', 'normal'], mode, true, 50_000 + i);
        expect(g.over).toBe(true);
        expect(g.teams).not.toBeNull();
        if (!g.timedOut) expect(g.winners()).toHaveLength(2);
        games++;
      }
    }
    expect(games).toBe(960);
  }, 60_000);

  it('Expert beats Normal clearly, and Hard beats Normal', () => {
    const rate = (a: BotLevel, b: BotLevel, n: number) => {
      let wins = 0;
      for (let i = 0; i < n; i++) {
        // swap seats every game so the first roll isn't a factor
        const levels: BotLevel[] = i % 2 === 0 ? [a, b] : [b, a];
        const { g, ids } = play(levels, 'classic', false, 7_000 + i);
        if (g.winners()[0] === ids[levels.indexOf(a)]) wins++;
      }
      return wins / n;
    };
    const expert = rate('expert', 'normal', 600);
    const hard = rate('hard', 'normal', 600);
    const expertHard = rate('expert', 'hard', 600);
    console.log(`[ludo bots] Classic 1v1 win rates: expert vs normal ${(expert * 100).toFixed(1)}%, hard vs normal ${(hard * 100).toFixed(1)}%, expert vs hard ${(expertHard * 100).toFixed(1)}%`);
    expect(expert).toBeGreaterThan(0.6);
    expect(hard).toBeGreaterThan(0.55);
    expect(expertHard).toBeGreaterThan(0.58);
  }, 60_000);

  it('Expert also leads a 4-player table of Normals', () => {
    let wins = 0;
    const n = 400;
    for (let i = 0; i < n; i++) {
      const seat = i % 4;
      const levels = Array.from({ length: 4 }, (_, k) => (k === seat ? 'expert' : 'normal')) as BotLevel[];
      const { g, ids } = play(levels, 'classic', false, 90_000 + i);
      if (g.winners()[0] === ids[seat]) wins++;
    }
    console.log(`[ludo bots] Classic 4 players: expert wins ${((wins / n) * 100).toFixed(1)}% (fair share 25%)`);
    expect(wins / n).toBeGreaterThan(0.33);
  }, 60_000);
});
