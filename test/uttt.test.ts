import { describe, expect, it } from 'vitest';
import { decide, searchBest } from '../src/games/uttt/brain.js';
import { UtttGame } from '../src/games/uttt/game.js';
import { parseUtttMove, utttModule } from '../src/games/uttt/module.js';
import { utttSendAfter, type BotLevel } from '../src/types.js';
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

const cfg = () => parseConfig({ decks: 1, bluffRule: 'one', game: 'uttt' });
const name = (id: string | null) => id ?? '?';
/** X is A, O is B */
const fresh = () => new UtttGame(['A', 'B'], cfg(), () => 0);
/** plays [board, cell] pairs in turn */
function play(g: UtttGame, moves: [number, number][]): void {
  for (const [b, c] of moves) g.place(g.turnId!, b, c);
}

describe('Ultimate Tic-Tac-Toe rules', () => {
  it('X moves first anywhere; the cell played sends the other player to that board', () => {
    const g = fresh();
    expect(g.x).toBe('A');
    expect(g.turnId).toBe('A');
    expect(g.view().active).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(() => g.place('B', 0, 0)).toThrow('Not your turn');
    const ev = g.place('A', 4, 2);
    expect(ev).toEqual([{ kind: 'uttt', ev: { type: 'mark', playerId: 'A', board: 4, cell: 2, won: false, free: false } }]);
    expect(g.view()).toMatchObject({ active: [2], turnId: 'B', moves: 1, last: { seq: 1, playerId: 'A', board: 4, cell: 2, mark: 'X', won: false } });
    expect(g.view().cells[4 * 9 + 2]).toBe('X');
    expect(() => g.place('B', 3, 0)).toThrow('You must play in the glowing board');
    expect(() => g.place('B', 9, 0)).toThrow('Pick a cell on the board');
    g.place('B', 2, 4);
    expect(g.view().active).toEqual([4]);
    expect(() => g.place('A', 4, 2)).toThrow('That cell is taken');
    expect(() => parseUtttMove({ type: 'place', board: 1 })).toThrow('Pick a cell on the board');
  });

  it('a line of 3 wins a small board; being sent to a decided board is a free move', () => {
    const g = fresh();
    // O takes board 0 with cells 3, 4, 5 (the middle row)
    play(g, [[1, 0], [0, 3], [3, 0], [0, 4], [4, 0]]);
    expect(g.view().active).toEqual([0]);
    const won = g.place('B', 0, 5);
    expect(won[0]).toMatchObject({ ev: { won: true, free: false } });
    expect(g.view().boards[0]).toBe('O');
    expect(utttModule.tallies(g, 'B')).toEqual({ boardsWon: 1 });
    // X's cell 0 sends O to the won board 0: a free move
    const ev = g.place('A', 5, 0);
    expect(ev[0]).toMatchObject({ ev: { free: true } });
    expect(g.view().active).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(() => g.place('B', 0, 0)).toThrow('That small board is already decided');
  });

  it('small board won, then the free move; a full board with no line counts for nobody', () => {
    const g = fresh();
    play(g, [[4, 0], [0, 4], [4, 1], [1, 4], [4, 2]]);
    expect(g.view().boards[4]).toBe('X');
    expect(g.last).toMatchObject({ won: true });
    expect(utttModule.tallies(g, 'A')).toEqual({ boardsWon: 1 });
    // O was sent to board 2; X is then sent to board 4 (won): a free move
    const ev = g.place('B', 2, 4);
    expect(ev[0]).toMatchObject({ ev: { free: true } });
    expect(g.view().active).toEqual([0, 1, 2, 3, 5, 6, 7, 8]);
    expect(() => g.place('A', 4, 5)).toThrow('That small board is already decided');
    // a drawn small board
    const d = fresh();
    for (const [k, c] of [0, 1, 2, 4, 3, 5, 7, 6, 8].entries()) d.core.cells[c] = k % 2 === 0 ? 1 : 2;
    d.core.cells[8] = 0;
    d.core.toMove = 1;
    d.place('A', 0, 8);
    expect(d.view().boards[0]).toBe('draw');
    expect(utttSendAfter(d.view().cells, d.view().boards, 1, 0, 'O')).toBe(null);
    expect(utttSendAfter(d.view().cells, d.view().boards, 1, 3, 'O')).toBe(3);
  });

  it('three won boards in a line win the game', () => {
    const g = fresh();
    for (const b of [0, 1]) g.core.boards[b] = 1;
    g.core.cells[2 * 9 + 0] = 1;
    g.core.cells[2 * 9 + 1] = 1;
    g.core.forced = 2;
    const ev = g.place('A', 2, 2);
    expect(ev.at(-1)).toEqual({ kind: 'gameOver', loserId: null });
    expect(g.winners()).toEqual(['A']);
    expect(g.losers()).toEqual(['B']);
    expect(g.view()).toMatchObject({ line: [0, 1, 2], winner: 'A', active: [], turnId: null });
    expect(utttModule.describe(g, ev.at(-1)!, name)).toEqual(['over', 'A wins three boards in a row 🎉']);
  });

  it('every board decided with no big line is a draw', () => {
    const g = fresh();
    // X O X / O O X / X X (open) — the last board, once drawn, leaves no line
    const states = [1, 2, 1, 2, 2, 1, 1, 1, 0];
    states.forEach((s, b) => (g.core.boards[b] = s));
    for (const [k, c] of [0, 1, 2, 4, 3, 5, 7, 6].entries()) g.core.cells[8 * 9 + c] = k % 2 === 0 ? 1 : 2;
    g.core.forced = 8;
    g.core.toMove = 1;
    const ev = g.place('A', 8, 8);
    expect(g.view().boards[8]).toBe('draw');
    expect(ev.at(-1)).toEqual({ kind: 'gameOver', loserId: null });
    expect(g.draw).toBe(true);
    expect(g.winners()).toEqual([]);
    expect(g.placeOf('A')).toBe(1);
    expect(g.placeOf('B')).toBe(1);
  });

  it('a walk-out hands the game to the other player', () => {
    const g = fresh();
    g.leave('A');
    expect(g.winners()).toEqual(['B']);
    expect(g.losers()).toEqual(['A']);
  });
});

describe('Ultimate Tic-Tac-Toe bots', () => {
  it('the search takes a winning move and blocks a big line', () => {
    const g = fresh();
    for (const b of [0, 1]) g.core.boards[b] = 1;
    g.core.cells[2 * 9 + 0] = 1;
    g.core.cells[2 * 9 + 1] = 1;
    g.core.forced = -1;
    expect(searchBest(g.core, 4, 200).move).toBe(2 * 9 + 2);
  });

  it.each(['normal', 'hard', 'expert'] as BotLevel[])('%s plays only legal moves to the end', (level) => {
    for (let seed = 1; seed <= 3; seed++) {
      const r = seeded(seed);
      const g = new UtttGame(['A', 'B'], cfg(), (m) => Math.floor(r() * m));
      while (!g.over) {
        const id = g.turnId!;
        const m = id === 'A' ? decide(g, id, level, r, 15) : decide(g, id, 'normal', r);
        utttModule.move(g, id, m);
      }
      expect(g.winner !== null || g.draw).toBe(true);
    }
  }, 60_000);

  it('Expert beats Normal', () => {
    let expert = 0;
    let normal = 0;
    for (let seed = 1; seed <= 8; seed++) {
      const r = seeded(seed + 10);
      const g = new UtttGame(['E', 'N'], cfg(), () => seed % 2);
      while (!g.over) {
        const id = g.turnId!;
        const m = decide(g, id, id === 'E' ? 'expert' : 'normal', r, id === 'E' ? 40 : undefined);
        g.place(id, m.board, m.cell);
      }
      if (g.winner === 'E') expert++;
      if (g.winner === 'N') normal++;
    }
    expect(expert).toBeGreaterThanOrEqual(6);
    expect(expert).toBeGreaterThan(normal);
  }, 60_000);
});
