import { describe, expect, it } from 'vitest';
import { SnakesGame, showMsOf } from '../src/games/snakes/game.js';
import { snakesModule } from '../src/games/snakes/module.js';
import type { GameEvent } from '../src/models.js';
import { LADDERS, SNAKES, SNAKES_GOAL, snakesCellOf } from '../src/types.js';
import { parseConfig } from '../src/validate.js';

/** dice that roll what the test says; the first player is always the 1st seat */
function dice() {
  const next: number[] = [];
  const rand = (max: number) => {
    if (max !== 6) return 0;
    const v = next.shift();
    if (v === undefined) throw new Error('no roll queued');
    return v - 1;
  };
  return { next, rand };
}

type Rules = { exact?: boolean; six?: boolean; bonus?: boolean; bite?: boolean };

function game(n: number, rules: Rules = {}, bots: string[] = []) {
  const d = dice();
  const ids = ['A', 'B', 'C', 'D'].slice(0, n);
  const config = parseConfig({ decks: 1, bluffRule: 'one', game: 'snakes', opts: { exact: true, six: true, bonus: true, bite: true, ...rules } });
  const g = new SnakesGame(ids, config, d.rand, bots, () => 0);
  return { g, d, ids };
}

/** rolls this number for whoever is on turn */
function roll(g: SnakesGame, d: ReturnType<typeof dice>, n: number): GameEvent[] {
  d.next.push(n);
  return g.roll(g.turnId!);
}

const kinds = (events: GameEvent[]) => events.map((e) => (e.kind === 'snakes' ? `snakes:${e.ev.type}` : e.kind));

describe('Saanp Seedhi board', () => {
  it('snakes go down, ladders go up, no square is both, and nothing sits on 1 or 100', () => {
    for (const [head, tail] of Object.entries(SNAKES)) expect(Number(head)).toBeGreaterThan(tail);
    for (const [foot, top] of Object.entries(LADDERS)) expect(Number(foot)).toBeLessThan(top);
    const starts = [...Object.keys(SNAKES), ...Object.keys(LADDERS)].map(Number);
    expect(new Set(starts).size).toBe(starts.length);
    expect(starts).not.toContain(1);
    expect(starts).not.toContain(SNAKES_GOAL);
    expect(snakesCellOf(1)).toEqual([0, 9]);
    expect(snakesCellOf(11)).toEqual([9, 8]);
    expect(snakesCellOf(100)).toEqual([0, 0]);
    expect(snakesCellOf(0)).toBeNull();
  });
});

describe('Saanp Seedhi rules', () => {
  it('seats colours in order; the options default to on', () => {
    const { g } = game(3);
    expect(g.seats.map((s) => s.color)).toEqual(['red', 'blue', 'green']);
    const plain = new SnakesGame(['A', 'B'], parseConfig({ decks: 1, bluffRule: 'one', game: 'snakes' }), () => 0);
    expect(plain.rules).toEqual({ exact: true, six: true, bonus: true, bite: true });
    expect(() => new SnakesGame(['A'], plain.config)).toThrow('Saanp Seedhi needs 2 to 4 players');
  });

  it('needs a 6 to step onto square 1; a roll with no move bumps rollSeq but not last', () => {
    const { g, d } = game(2);
    const e = roll(g, d, 3);
    expect(kinds(e)).toEqual(['snakes:roll']);
    expect(e[0]).toMatchObject({ ev: { moved: false, lost: false, roll: 3 } });
    expect(g.seatOf('A').pos).toBe(0);
    expect(g.turnId).toBe('B');
    expect(g.view()).toMatchObject({ dice: 3, rollSeq: 1, last: null });
    roll(g, d, 2);
    // A enters on a 6 (square 1, no steps) and rolls again
    const six = roll(g, d, 6);
    expect(kinds(six)).toEqual(['snakes:roll', 'snakes:move']);
    expect(g.last).toMatchObject({ seq: 1, from: 0, landed: 1, to: 1, bonus: true, via: null });
    expect(g.turnId).toBe('A');
    expect(g.sixes).toBe(1);
    // 1 + 1 = 2: the ladder to 38
    roll(g, d, 1);
    expect(g.last).toMatchObject({ seq: 2, from: 1, landed: 2, to: 38, via: { kind: 'ladder', from: 2, to: 38 }, bonus: false });
    expect(g.seatOf('A')).toMatchObject({ pos: 38, ladders: 1 });
    expect(g.turnId).toBe('B');
  });

  it('without the 6 rule the first roll moves straight from 0', () => {
    const { g, d } = game(2, { six: false });
    roll(g, d, 4);
    expect(g.last).toMatchObject({ from: 0, landed: 4, to: 14, via: { kind: 'ladder' } });
  });

  it('exact finish bounces back off 100, then a snake still bites', () => {
    const { g, d } = game(2);
    g.seatOf('A').pos = 99;
    roll(g, d, 3);
    expect(g.last).toMatchObject({ from: 99, landed: 98, to: 79, bounced: true, via: { kind: 'snake', from: 98, to: 79 } });
    expect(g.seatOf('A').snakes).toBe(1);
    expect(showMsOf(g.last, true)).toBe(800 + 3 * 170 + 900);
  });

  it('without exact, 100 or more finishes; two players: the game ends with a winner', () => {
    const { g, d } = game(2, { exact: false });
    g.seatOf('A').pos = 97;
    const e = roll(g, d, 5);
    expect(kinds(e)).toEqual(['snakes:roll', 'snakes:move', 'finish', 'gameOver']);
    expect(g.last).toMatchObject({ landed: 100, to: 100, bounced: false });
    expect(g.winners()).toEqual(['A']);
    expect(g.losers()).toEqual(['B']);
    expect(g.placeOf('B')).toBe(2);
    expect(() => g.roll('B')).toThrow('The game is over');
  });

  it('three players play on after the first finish until one is left', () => {
    const { g, d } = game(3);
    g.seatOf('A').pos = 97;
    roll(g, d, 3);
    expect(g.over).toBe(false);
    expect(g.seatOf('A').place).toBe(1);
    expect(g.turnId).toBe('B');
    g.seatOf('B').pos = 96;
    roll(g, d, 4);
    expect(g.over).toBe(true);
    expect(g.winners()).toEqual(['A']);
    expect([g.placeOf('A'), g.placeOf('B'), g.placeOf('C')]).toEqual([1, 2, 3]);
  });

  it('bite: others on the final square go back 5 (at least to 1), with no chain', () => {
    const { g, d } = game(3, { six: false });
    g.seatOf('A').pos = 10;
    g.seatOf('B').pos = 15;
    g.seatOf('C').pos = 15;
    roll(g, d, 5);
    expect(g.last!.bitten).toEqual([
      { playerId: 'B', from: 15, to: 10 },
      { playerId: 'C', from: 15, to: 10 },
    ]);
    expect(g.seatOf('B').pos).toBe(10);
    expect(g.seatOf('A').bites).toBe(2);
    expect(snakesModule.tallies(g, 'A')).toEqual({ ladders: 0, snakes: 0, bites: 2 });
    // near the start: back to square 1
    const b = game(2, { six: false });
    b.g.seatOf('B').pos = 3;
    roll(b.g, b.d, 3);
    expect(b.g.seatOf('B').pos).toBe(1);
  });

  it('with bite off players share a square', () => {
    const { g, d } = game(2, { bite: false });
    g.seatOf('A').pos = 10;
    g.seatOf('B').pos = 15;
    roll(g, d, 5);
    expect(g.last!.bitten).toEqual([]);
    expect(g.seatOf('B').pos).toBe(15);
  });

  it('bonus: a 6 rolls again; a third 6 in a row loses the turn with no move', () => {
    const { g, d } = game(2);
    g.seatOf('A').pos = 10;
    roll(g, d, 6);
    roll(g, d, 6);
    expect(g.seatOf('A').pos).toBe(22);
    const e = roll(g, d, 6);
    expect(e).toEqual([{ kind: 'snakes', ev: { type: 'roll', playerId: 'A', roll: 6, sixes: 3, moved: false, lost: true } }]);
    expect(g.seatOf('A').pos).toBe(22);
    expect(g.view()).toMatchObject({ turnId: 'B', dice: 6, sixes: 3, rollSeq: 3, last: { seq: 2 } });
    // the next turn counts its own sixes
    roll(g, d, 6);
    expect(g.sixes).toBe(1);
  });

  it('without bonus a 6 is one roll like any other', () => {
    const { g, d } = game(2, { bonus: false });
    g.seatOf('A').pos = 10;
    roll(g, d, 6);
    expect(g.last!.bonus).toBe(false);
    expect(g.turnId).toBe('B');
  });

  it('checks turns and moves', () => {
    const { g } = game(2);
    expect(() => snakesModule.move(g, 'B', { type: 'roll' })).toThrow('Not your turn');
    expect(() => snakesModule.move(g, 'Z', { type: 'roll' })).toThrow("You're not playing this game");
    expect(() => snakesModule.move(g, 'A', { type: 'move' })).toThrow('Invalid move');
    expect(() => snakesModule.move(g, 'A', null)).toThrow('Invalid move');
  });

  it('leaving is a forfeit: the token leaves the board and the last one in wins', () => {
    const { g, d } = game(3);
    g.seatOf('B').pos = 40;
    roll(g, d, 1);
    expect(g.turnId).toBe('B');
    expect(g.leave('B')).toEqual([]);
    expect(g.seatOf('B').pos).toBe(0);
    expect(g.turnId).toBe('C');
    expect(kinds(g.leave('C'))).toEqual(['finish', 'gameOver']);
    expect(g.winners()).toEqual(['A']);
    expect(g.losers().sort()).toEqual(['B', 'C']);
  });

  it('a kick that leaves one player stops the game with no winner', () => {
    const { g } = game(2);
    g.removePlayer('B');
    expect(g.over).toBe(true);
    expect(g.aborted).toBe(true);
    expect(g.winners()).toEqual([]);
  });

  it('bots roll by themselves after the last roll has shown; people get no automatic step', () => {
    const { g, d } = game(2, {}, ['B']);
    expect(snakesModule.auto(g)).toBeNull();
    g.seatOf('A').pos = 10;
    roll(g, d, 5);
    const step = snakesModule.auto(g)!;
    expect(step.delayMs).toBe(800 + 5 * 170);
    d.next.push(3);
    step.run();
    expect(g.turnId).toBe('A');
    expect(snakesModule.turnKey(g)).toBe(`${g.stepSeq}|A`);
    expect(snakesModule.botMove(g, 'B', 'hard', Math.random)).toEqual({ type: 'roll' });
  });
});
