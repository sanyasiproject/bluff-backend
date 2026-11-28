import { afterAll, describe, expect, it } from 'vitest';
import { ChessTable, forgetRematches } from '../src/games/chess/game.js';
import { chessModule, jobOf } from '../src/games/chess/module.js';
import { ChessBotPool } from '../src/games/chess/pool.js';
import { botBudgetMs } from '../src/games/chess/budget.js';
import { CHESS_VARIANT_IDS, type ChessVariant } from '../src/types.js';
import { parseConfig } from '../src/validate.js';

const pool = new ChessBotPool(4);
afterAll(() => pool.close());

/** two bots play one game through the module, each move worked out in the worker pool */
async function botGame(variant: ChessVariant, levels: [number, number], maxMs: number, seed: number) {
  forgetRematches();
  const g = new ChessTable(['w1', 'b1'], parseConfig({ decks: 1, bluffRule: 'one', game: 'chess', opts: { variant, time: 'none', color: 'white' } }), (n) => seed % n, ['w1', 'b1']);
  g.botLevels.set('w1', levels[0]);
  g.botLevels.set('b1', levels[1]);
  for (let i = 0; i < 500 && !g.over; i++) {
    const id = g.turnId!;
    const uci = await pool.think({ ...jobOf(g, id, seed * 1000 + i), maxMs });
    chessModule.move(g, id, { type: 'move', uci, ply: g.uci.length });
  }
  return g;
}

describe('chess bots in worker threads', () => {
  it('play legal games to the end in every variant', async () => {
    const games = await Promise.all(CHESS_VARIANT_IDS.map((v, i) => botGame(v, [1, 2], 30, i + 1)));
    for (const g of games) {
      expect(g.over, `${g.variant} after ${g.uci.length} plies`).toBe(true);
      expect(g.result!.reason).not.toBe('abort');
    }
  }, 120_000);

  it('level 8 beats level 1', async () => {
    const games = await Promise.all([1, 2].map((s) => botGame('standard', s === 1 ? [8, 1] : [1, 8], 80, s)));
    expect(games[0].result!.winner).toBe('w');
    expect(games[1].result!.winner).toBe('b');
  }, 120_000);

  it('spend at most 1/30 of the clock plus most of the increment, and little when the flag is close', () => {
    expect(botBudgetMs(8, null, 0)).toBe(1600);
    expect(botBudgetMs(8, 60_000, 0)).toBe(1600);
    expect(botBudgetMs(8, 30_000, 0)).toBe(1000);
    expect(botBudgetMs(8, 9_000, 1000)).toBe(150);
    expect(botBudgetMs(8, 2_000, 0)).toBe(40);
    expect(botBudgetMs(1, 2_000, 0)).toBe(40);
  });
});
