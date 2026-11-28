import { describe, expect, it } from 'vitest';
import { CHESS_VARIANTS, ChessGame, Position, botMove, type BotLevel } from '../src/chess/index.js';

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

describe('bot-vs-bot simulation', () => {
  for (const { id } of CHESS_VARIANTS) {
    it(`fast bot games all finish in ${id}`, () => {
      const reasons: Record<string, number> = {};
      for (let n = 0; n < 24; n++) {
        const rand = seeded(n * 97 + id.length);
        const g = new ChessGame(id, id === 'chess960' ? Position.start(id, Math.floor(rand() * 960)).fen() : undefined);
        const levels: [BotLevel, BotLevel] = [((n % 2) + 1) as BotLevel, (((n >> 1) % 2) + 1) as BotLevel];
        while (!g.outcome() && g.ply < 1500) {
          const side = g.position().turn === 'w' ? 0 : 1;
          const m = botMove(g.position(), g.keys(), levels[side], rand, { maxNodes: 256 });
          expect(g.position().isLegal(m)).toBe(true);
          g.play(m);
        }
        const o = g.outcome();
        expect(o, `${id} game ${n} did not finish`).not.toBeNull();
        reasons[o?.reason ?? 'none'] = (reasons[o?.reason ?? 'none'] ?? 0) + 1;
      }
      expect(Object.values(reasons).reduce((a, b) => a + b, 0)).toBe(24);
    }, 120000);
  }
});
