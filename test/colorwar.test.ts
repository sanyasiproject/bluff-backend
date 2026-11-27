import { describe, expect, it } from 'vitest';
import { applyTap } from '../src/games/colorwar/board.js';
import { decide } from '../src/games/colorwar/brain.js';
import { ColorWarGame } from '../src/games/colorwar/game.js';
import { colorwarModule, parseColorWarMove } from '../src/games/colorwar/module.js';
import { COLORWAR_FIRST, type BotLevel, type ColorWarCell } from '../src/types.js';
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

const cfg = (size = 5) => parseConfig({ decks: 1, bluffRule: 'one', game: 'colorwar', opts: { size } });
const name = (id: string | null) => id ?? '?';
const empty = (n: number): ColorWarCell[] => Array.from({ length: n }, () => ({ owner: null, dots: 0 }));

describe('Colour Wars rules', () => {
  it('first move places 3 dots on an empty cell; then only your own cells, +1 each', () => {
    const g = new ColorWarGame(['A', 'B'], cfg(), () => 0);
    expect(g.view()).toMatchObject({ size: 5, firstMove: ['A', 'B'], alive: ['A', 'B'], turnId: 'A' });
    expect(() => g.tap('B', 0)).toThrow('Not your turn');
    g.tap('A', 0);
    expect(g.cells[0]).toEqual({ owner: 'A', dots: COLORWAR_FIRST });
    expect(() => g.tap('B', 0)).toThrow('Pick an empty cell to start');
    g.tap('B', 24);
    expect(() => g.tap('A', 24)).toThrow('Tap one of your own cells');
    expect(() => g.tap('A', 25)).toThrow('Tap a cell on the board');
    expect(g.view().firstMove).toEqual([]);
    expect(g.view().last).toEqual({ seq: 2, playerId: 'B', cell: 24, waves: [] });
  });

  it('4 dots burst: the cell empties, each neighbour gets a dot and the colour, chains run wave by wave', () => {
    const cells = empty(9);
    cells[4] = { owner: 'A', dots: 3 };
    cells[1] = { owner: 'B', dots: 3 };
    cells[5] = { owner: 'B', dots: 1 };
    // a third colour far away keeps the chain going
    cells[8] = { owner: 'C', dots: 1 };
    const { waves, captured } = applyTap(3, cells, 'A', 4, false, false);
    // wave 1: the centre; wave 2: the top middle (now 4, A's)
    expect(waves).toEqual([[4], [1]]);
    expect(cells[4]).toEqual({ owner: 'A', dots: 1 });
    expect(cells[1]).toEqual({ owner: null, dots: 0 });
    expect(cells[0]).toEqual({ owner: 'A', dots: 1 });
    expect(cells[5]).toEqual({ owner: 'A', dots: 2 });
    expect(captured.get('B')).toBe(2);
  });

  it('a chain stops as soon as no rival colour is left (unless a rival still has to place)', () => {
    const board = () => {
      const cells = empty(9);
      cells[4] = { owner: 'A', dots: 3 };
      cells[1] = { owner: 'B', dots: 3 };
      return cells;
    };
    expect(applyTap(3, board(), 'A', 4, false, false).waves).toEqual([[4]]);
    expect(applyTap(3, board(), 'A', 4, false, true).waves).toEqual([[4], [1]]);
  });

  it('a player left with no cells is out', () => {
    const g = new ColorWarGame(['A', 'B', 'C'], cfg(), () => 0);
    g.tap('A', 12);
    g.tap('B', 7);
    g.tap('C', 0);
    // A's 12 bursts into B's 7 (now 4, A's), which bursts in the next wave: B holds nothing
    const ev = g.tap('A', 12);
    expect(g.last!.waves).toEqual([[12], [7]]);
    expect(g.cells[7]).toEqual({ owner: null, dots: 0 });
    expect(g.cells[12]).toEqual({ owner: 'A', dots: 1 });
    expect(g.view().alive).toEqual(['A', 'C']);
    expect(g.turnId).toBe('C');
    const out = ev.find((e) => e.kind === 'colorwar' && e.ev.type === 'out')!;
    expect(out).toEqual({ kind: 'colorwar', ev: { type: 'out', playerId: 'B', place: 3 } });
    expect(colorwarModule.describe(g, out, name)).toEqual(['play', 'B is wiped out, 3rd place 💥']);
    expect(g.view().places).toEqual({ B: 3 });
    expect(colorwarModule.tallies(g, 'A')).toEqual({ captures: 1, bursts: 2 });
  });

  it('last colour standing wins; places run from the winner to the first out', () => {
    for (let seed = 1; seed < 30; seed++) {
      const r = seeded(seed);
      const g = new ColorWarGame(['A', 'B', 'C', 'D'], cfg(5), (m) => Math.floor(r() * m), []);
      let steps = 0;
      while (!g.over) {
        if (++steps > 5000) throw new Error('stuck');
        const legal = g.legal(g.turnId!);
        g.tap(g.turnId!, legal[Math.floor(r() * legal.length)]);
      }
      const won = g.winners();
      expect(won).toHaveLength(1);
      expect(g.cells.every((c) => c.owner === null || c.owner === won[0])).toBe(true);
      expect(g.places).toHaveLength(4);
      expect(g.places.map((p) => g.placeOf(p))).toEqual([1, 2, 3, 4]);
      expect(g.view().places[won[0]]).toBe(1);
    }
  });

  it('a walk-out empties their cells; the last one left wins', () => {
    const g = new ColorWarGame(['A', 'B'], cfg(7), () => 0);
    expect(g.size).toBe(7);
    g.tap('A', 0);
    g.tap('B', 48);
    expect(g.leave('A').map((e) => e.kind)).toEqual(['finish', 'gameOver']);
    expect(g.cells[0]).toEqual({ owner: null, dots: 0 });
    expect(g.winners()).toEqual(['B']);
    expect(g.losers()).toEqual(['A']);
  });

  it('parses taps', () => {
    expect(parseColorWarMove({ type: 'tap', cell: 4 })).toEqual({ type: 'tap', cell: 4 });
    expect(() => parseColorWarMove({ type: 'tap', cell: '4' })).toThrow('Tap a cell on the board');
    expect(() => parseColorWarMove({ type: 'line' })).toThrow('Invalid move');
  });

  it('bots take a rival cell when a burst can, and avoid starting next to a ripe rival', () => {
    const g = new ColorWarGame(['A', 'B'], cfg(), () => 0);
    g.tap('A', 12);
    for (let i = 0; i < 10; i++) expect([7, 11, 13, 17]).not.toContain(decide(g, 'B', 'hard', seeded(i)).cell);
    g.tap('B', 13);
    // A's 12 has 3: tapping it bursts into B's 13
    expect(decide(g, 'A', 'hard', seeded(1)).cell).toBe(12);
  });
});

function botGame(levels: BotLevel[], size: number, seed: number) {
  const ids = levels.map((_, i) => `b${i}`);
  const r = seeded(seed);
  const g = new ColorWarGame(ids, cfg(size), (m) => Math.floor(r() * m), ids, r);
  let steps = 0;
  while (!g.over) {
    if (++steps > 3000) throw new Error(`stuck ${size} ${levels} ${seed}`);
    const id = g.turnId!;
    g.config.botLevel = levels[ids.indexOf(id)];
    const step = colorwarModule.auto(g)!;
    expect(step.delayMs).toBeGreaterThan(0);
    step.run();
  }
  return g;
}

describe('Colour Wars bots', () => {
  it('finish hundreds of games on both boards with 2 to 4 players', () => {
    let games = 0;
    for (const size of [5, 7]) {
      for (const n of [2, 3, 4]) {
        for (const lv of ['normal', 'hard', 'expert'] as BotLevel[]) {
          for (let i = 0; i < 12; i++) {
            const g = botGame(Array(n).fill(lv), size, ++games * 17);
            expect(g.winners()).toHaveLength(1);
          }
        }
      }
    }
    expect(games).toBe(216);
  }, 60_000);

  it('levels are ordered: Hard beats Normal, Expert holds its own against Hard', () => {
    const rate = (a: BotLevel, b: BotLevel) => {
      let w = 0;
      for (let i = 0; i < 60; i++) if (botGame([a, b], 5, 500 + i).winners()[0] === 'b0') w++;
      for (let i = 0; i < 60; i++) if (botGame([b, a], 5, 800 + i).winners()[0] === 'b1') w++;
      return w / 120;
    };
    expect(rate('hard', 'normal')).toBeGreaterThan(0.65);
    expect(rate('expert', 'hard')).toBeGreaterThan(0.5);
  }, 60_000);
});
