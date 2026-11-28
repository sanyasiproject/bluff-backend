import { describe, expect, it } from 'vitest';
import { decide } from '../src/games/gomoku/brain.js';
import { GomokuGame } from '../src/games/gomoku/game.js';
import { gomokuModule, parseGomokuMove } from '../src/games/gomoku/module.js';
import { gomokuCentre, type BotLevel } from '../src/types.js';
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

const cfg = () => parseConfig({ decks: 1, bluffRule: 'one', game: 'gomoku' });
const name = (id: string | null) => id ?? '?';
const LEVELS: BotLevel[] = ['normal', 'hard', 'expert'];

/** a game with stones already set (seat per [x, y]) and A to move, past the centre rule */
function setUp(stones: [number, number, number][], players = 2): GomokuGame {
  const g = new GomokuGame(['A', 'B', 'C', 'D'].slice(0, players), cfg(), () => 0);
  for (const [x, y, s] of stones) g.cells[y * g.size + x] = s;
  g.moves = stones.length;
  return g;
}

describe('Five in a Row rules', () => {
  it('the first stone goes on the centre; turns go round; taken points and other turns are refused', () => {
    const g = new GomokuGame(['A', 'B'], cfg(), () => 0);
    expect(g.size).toBe(15);
    expect(g.turnId).toBe('A');
    expect(() => g.place('A', 0)).toThrow('The first stone goes on the centre point');
    const c = gomokuCentre(15);
    expect(c).toBe(7 * 15 + 7);
    expect(g.place('A', c)).toEqual([{ kind: 'gomoku', ev: { type: 'stone', playerId: 'A', at: c, blocked: false } }]);
    expect(() => g.place('A', 0)).toThrow('Not your turn');
    expect(() => g.place('B', c)).toThrow('That point is taken');
    expect(() => g.place('B', 225)).toThrow('Pick a point on the board');
    g.place('B', 0);
    expect(g.view()).toMatchObject({ moves: 2, turnId: 'A', seats: ['A', 'B'], last: { seq: 2, playerId: 'B', at: 0 } });
    expect(g.view().cells[c]).toBe(0);
    expect(g.view().cells[0]).toBe(1);
    expect(() => parseGomokuMove({ type: 'place', at: 'x' })).toThrow('Pick a point on the board');
    expect(() => parseGomokuMove({ type: 'drop' })).toThrow('Invalid move');
  });

  it.each([
    ['row', [1, 0]],
    ['column', [0, 1]],
    ['diagonal', [1, 1]],
    ['anti-diagonal', [-1, 1]],
  ] as const)('five in a %s wins at once and the line is shown', (_label, [dx, dy]) => {
    const x0 = dx < 0 ? 10 : 3;
    const stones: [number, number, number][] = [0, 1, 3, 4].map((k) => [x0 + dx * k, 3 + dy * k, 0]);
    stones.push([14, 14, 1], [13, 14, 1], [12, 14, 1], [14, 12, 1]);
    const g = setUp(stones);
    const at = (3 + dy * 2) * 15 + x0 + dx * 2;
    const ev = g.place('A', at);
    expect(ev.at(-1)).toEqual({ kind: 'gameOver', loserId: null });
    expect(g.winners()).toEqual(['A']);
    expect(g.losers()).toEqual(['B']);
    expect(g.view().line).toHaveLength(5);
    expect(g.view().line).toContain(at);
    expect(gomokuModule.tallies(g, 'A')).toEqual({ fives: 1, blocks: 0 });
    expect(gomokuModule.describe(g, ev.at(-1)!, name)).toEqual(['over', 'A makes 5 in a row and wins 🎉']);
  });

  it('six or more in a row also wins', () => {
    const g = setUp([[2, 5, 0], [3, 5, 0], [4, 5, 0], [6, 5, 0], [7, 5, 0], [0, 0, 1], [0, 2, 1], [0, 4, 1], [0, 6, 1], [0, 8, 1]]);
    g.place('A', 5 * 15 + 5);
    expect(g.winner).toBe('A');
    expect(g.view().line).toHaveLength(6);
  });

  it('a full board with no five is a draw: nobody wins and everyone shares first', () => {
    const g = setUp([]);
    // a pattern with no line longer than 2, the last point left empty
    for (let i = 0; i < 225; i++) g.cells[i] = Math.floor(((i % 15) + 2 * Math.floor(i / 15)) / 2) % 2;
    const last = 224;
    const seat = g.cells[last];
    g.cells[last] = -1;
    g.moves = 224;
    g.turnId = seat === 0 ? 'A' : 'B';
    const ev = g.place(g.turnId, last);
    expect(ev.at(-1)).toEqual({ kind: 'gameOver', loserId: null });
    expect(g.draw).toBe(true);
    expect(g.winners()).toEqual([]);
    expect(g.losers()).toEqual([]);
    expect(g.placeOf('A')).toBe(1);
    expect(g.placeOf('B')).toBe(1);
    expect(gomokuModule.describe(g, ev.at(-1)!, name)).toEqual(['over', 'The board is full. It’s a draw 🤝']);
  });

  it('3 and 4 players use 19 × 19, take turns in seat order, and the rest are placed by their longest line', () => {
    for (const n of [3, 4]) {
      const ids = ['A', 'B', 'C', 'D'].slice(0, n);
      const g = new GomokuGame(ids, cfg(), () => 0);
      expect(g.size).toBe(19);
      expect(g.view().cells).toHaveLength(361);
      g.place('A', gomokuCentre(19));
      const seen = ['A'];
      for (let k = 0; k < n; k++) {
        seen.push(g.turnId!);
        g.place(g.turnId!, k * 2);
      }
      expect(seen).toEqual([...ids, 'A']);
    }
    // C finishes a five; B (a line of 3) places above D (a line of 2), A (a line of 1) last
    const g = setUp([[0, 0, 0], [5, 5, 1], [6, 5, 1], [7, 5, 1], [10, 10, 2], [11, 10, 2], [12, 10, 2], [13, 10, 2], [15, 15, 3], [16, 15, 3]], 4);
    for (const [id, len] of [['A', 1], ['B', 3], ['C', 4], ['D', 2]] as const) g.best.set(id, len);
    g.turnId = 'C';
    g.place('C', 10 * 19 + 14);
    expect(g.winners()).toEqual(['C']);
    expect(['A', 'B', 'C', 'D'].map((id) => g.placeOf(id))).toEqual([4, 2, 1, 3]);
    expect(g.view().places).toEqual({ C: 1, B: 2, D: 3, A: 4 });
  });

  it('a stone that stops a four or an open three counts as a block', () => {
    const g = setUp([[3, 3, 1], [4, 3, 1], [5, 3, 1], [0, 0, 0], [0, 2, 0]]);
    g.place('A', 3 * 15 + 6);
    expect(gomokuModule.tallies(g, 'A')).toEqual({ fives: 0, blocks: 1 });
  });

  it('a walk-out hands a 2-player game to the other; a kick stops it', () => {
    const g = new GomokuGame(['A', 'B'], cfg(), () => 0);
    g.leave('B');
    expect(g.over).toBe(true);
    expect(g.winners()).toEqual(['A']);
    expect(g.losers()).toEqual(['B']);
    const k = new GomokuGame(['A', 'B'], cfg(), () => 0);
    k.removePlayer('B');
    expect(k.aborted).toBe(true);
    expect(k.winners()).toEqual([]);
  });
});

describe('Five in a Row bots', () => {
  it.each(LEVELS)('%s always wins when it can, even with its own four to stop', (level) => {
    for (let seed = 1; seed <= 20; seed++) {
      // A has four in a row (one end open); B has four too
      const g = setUp([[3, 3, 0], [4, 3, 0], [5, 3, 0], [6, 3, 0], [2, 3, 1], [3, 8, 1], [4, 8, 1], [5, 8, 1], [6, 8, 1]]);
      expect(decide(g, 'A', level, seeded(seed))).toEqual({ type: 'place', at: 3 * 15 + 7 });
    }
  });

  it.each(LEVELS)('%s always blocks a four and an open three', (level) => {
    for (let seed = 1; seed <= 20; seed++) {
      // B's four is closed at the left: the only stop is its right end
      const four = setUp([[2, 6, 0], [3, 6, 1], [4, 6, 1], [5, 6, 1], [6, 6, 1], [10, 10, 0]]);
      expect(decide(four, 'A', level, seeded(seed))).toEqual({ type: 'place', at: 6 * 15 + 7 });
      if (level === 'normal') continue;
      // B's open three: a stop is at one of its ends (or the gap ends next to them)
      const three = setUp([[5, 9, 1], [6, 9, 1], [7, 9, 1], [0, 0, 0], [14, 0, 0]]);
      expect([9 * 15 + 4, 9 * 15 + 8, 9 * 15 + 3, 9 * 15 + 9]).toContain(decide(three, 'A', level, seeded(seed)).at);
    }
  });

  it('with 3 players a bot stops a four of the player right after it', () => {
    const g = setUp([[0, 0, 0], [3, 3, 1], [4, 3, 1], [5, 3, 1], [6, 3, 1], [2, 3, 2], [18, 18, 2]], 3);
    expect(decide(g, 'A', 'hard', seeded(1))).toEqual({ type: 'place', at: 3 * 19 + 7 });
  });

  it.each([
    [2, ['hard', 'normal']],
    [2, ['expert', 'normal']],
    [3, ['hard', 'normal', 'expert']],
    [4, ['normal', 'hard', 'normal', 'hard']],
  ] as const)('%i players (%j) play whole games to an end', (n, levels) => {
    for (let seed = 1; seed <= 4; seed++) {
      const r = seeded(seed);
      const ids = ['A', 'B', 'C', 'D'].slice(0, n);
      const g = new GomokuGame(ids, cfg(), (m) => Math.floor(r() * m));
      let moves = 0;
      while (!g.over) {
        const id = g.turnId!;
        const m = gomokuModule.botMove(g, id, levels[ids.indexOf(id)], r);
        gomokuModule.move(g, id, m);
        moves++;
        expect(moves).toBeLessThanOrEqual(g.size * g.size);
      }
      expect(g.winner !== null || g.draw).toBe(true);
      if (g.winner) expect(g.view().line!.length).toBeGreaterThanOrEqual(5);
    }
  }, 60_000);

  it('Expert beats Normal more often than not', () => {
    let expert = 0;
    let normal = 0;
    for (let seed = 1; seed <= 12; seed++) {
      const r = seeded(seed + 50);
      const g = new GomokuGame(['E', 'N'], cfg(), () => seed % 2);
      while (!g.over) g.place(g.turnId!, decide(g, g.turnId!, g.turnId === 'E' ? 'expert' : 'normal', r).at);
      if (g.winner === 'E') expert++;
      if (g.winner === 'N') normal++;
    }
    expect(expert).toBeGreaterThan(normal);
  }, 60_000);
});
