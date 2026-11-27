import { describe, expect, it } from 'vitest';
import { LudoGame } from '../src/games/ludo/game.js';
import { ludoModule } from '../src/games/ludo/module.js';
import type { GameEvent } from '../src/models.js';
import { LUDO_BASE, LUDO_HOME, ludoRingOf, type GameConfig, type LudoMode } from '../src/types.js';
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

const cfg = (mode: LudoMode = 'classic', extra: Partial<GameConfig> = {}): GameConfig =>
  ({ ...parseConfig({ decks: 1, bluffRule: 'one', game: 'ludo', opts: { mode, time: 5 } }), ...extra });

function game(n: number, mode: LudoMode = 'classic', extra: Partial<GameConfig> = {}) {
  const d = dice();
  const ids = ['A', 'B', 'C', 'D'].slice(0, n);
  const g = new LudoGame(ids, cfg(mode, extra), d.rand, 1_000_000);
  return { g, d, ids };
}

/** rolls this number for whoever is on turn */
function roll(g: LudoGame, d: ReturnType<typeof dice>, n: number): GameEvent[] {
  d.next.push(n);
  return g.roll(g.turnId!);
}

const kinds = (events: GameEvent[]) => events.map((e) => (e.kind === 'ludo' ? `ludo:${e.ev.type}` : e.kind));

describe('Ludo rules', () => {
  it('seats colours by player count and partners sit opposite in 2v2', () => {
    expect(game(2).g.seats.map((s) => s.color)).toEqual(['red', 'yellow']);
    expect(game(3).g.seats.map((s) => s.color)).toEqual(['red', 'green', 'yellow']);
    const t = game(4, 'classic', { teams: true }).g;
    expect(t.seats.map((s) => s.color)).toEqual(['red', 'green', 'yellow', 'blue']);
    expect(t.teams).toEqual([['A', 'C'], ['B', 'D']]);
    expect(game(4).g.teams).toBeNull();
  });

  it('a goti leaves base only on a 6, and a 6 earns another roll', () => {
    const { g, d } = game(2);
    roll(g, d, 3);
    expect(g.movable()).toEqual([]);
    expect(g.autoDue).toBe(true);
    expect(kinds(g.stepAuto())).toEqual(['ludo:pass']);
    expect(g.turnId).toBe('B');
    expect(g.dice).toBeNull();
    roll(g, d, 6);
    expect(g.movable()).toEqual([0, 1, 2, 3]);
    // all four in base are one choice: the room moves one by itself
    expect(g.autoDue).toBe(true);
    g.stepAuto();
    expect(g.seatOf('B').tokens).toEqual([0, LUDO_BASE, LUDO_BASE, LUDO_BASE]);
    expect(g.turnId).toBe('B');
    expect(g.rolled).toBe(false);
    expect(g.last).toMatchObject({ seq: 1, playerId: 'B', color: 'yellow', from: -1, to: 0, roll: 6, bonus: true });
  });

  it('a 6 with no goti to move still rolls again', () => {
    const { g, d } = game(2);
    g.seatOf('A').tokens = [LUDO_HOME, LUDO_HOME, LUDO_HOME, 54];
    roll(g, d, 6);
    expect(g.movable()).toEqual([]);
    g.stepAuto();
    expect(g.turnId).toBe('A');
    expect(g.rolled).toBe(false);
  });

  it('needs the exact roll to reach home', () => {
    const { g, d } = game(2);
    g.seatOf('A').tokens = [54, 10, LUDO_BASE, LUDO_BASE];
    roll(g, d, 3);
    expect(g.movable()).toEqual([1]);
    expect(() => g.move('A', 0)).toThrow("That goti can't move 3");
    g.stepAuto();
    expect(g.turnId).toBe('B');
    g.seatOf('B').tokens = [LUDO_HOME, LUDO_HOME, LUDO_HOME, LUDO_HOME - 1];
    // B is placed below; give the turn back to A
    g.turnId = 'A';
    roll(g, d, 2);
    const ev = g.move('A', 0);
    expect(g.seatOf('A').home).toBe(1);
    expect(ev[0]).toMatchObject({ kind: 'ludo', ev: { type: 'move', home: true, bonus: true } });
    expect(g.turnId).toBe('A');
  });

  it('knocks opponents off a plain square, never off a safe one', () => {
    const { g, d } = game(3);
    // green's goti on ring square 5
    const greenAt = (ring: number) => (ring - 13 + 52) % 52;
    g.seatOf('B').tokens = [greenAt(5), greenAt(8), LUDO_BASE, LUDO_BASE];
    expect(ludoRingOf('green', g.seatOf('B').tokens[0])).toBe(5);
    g.seatOf('A').tokens = [3, 6, LUDO_BASE, LUDO_BASE];
    roll(g, d, 2);
    const ev = g.move('A', 0);
    expect(g.seatOf('B').tokens[0]).toBe(LUDO_BASE);
    expect(g.seatOf('A').kills).toBe(1);
    expect(g.kills).toEqual([{ by: 'A', victim: 'B', at: expect.any(Number) }]);
    expect(ev[0]).toMatchObject({ ev: { captured: [{ playerId: 'B', token: 0, from: greenAt(5) }], bonus: true } });
    expect(ludoModule.describe(g, ev[0], (id) => ({ A: 'Asha', B: 'Ravi' })[id ?? ''] ?? '?')).toEqual(['play', "Asha knocked Ravi's goti home! 💥"]);
    // a kill earns another roll; square 8 is a safe star
    expect(g.turnId).toBe('A');
    roll(g, d, 2);
    g.move('A', 1);
    expect(g.seatOf('B').tokens[1]).toBe(greenAt(8));
    expect(g.stats.get('A')!.tallies).toMatchObject({ kills: 1 });
    expect(g.stats.get('B')!.tallies).toMatchObject({ killed: 1 });
  });

  it('three 6s in a row lose the turn', () => {
    const { g, d } = game(2);
    g.seatOf('A').tokens = [10, 20, LUDO_BASE, LUDO_BASE];
    roll(g, d, 6);
    g.move('A', 0);
    roll(g, d, 6);
    g.move('A', 0);
    roll(g, d, 6);
    expect(g.sixes).toBe(3);
    expect(g.movable()).toEqual([]);
    const ev = g.stepAuto();
    expect(ev[0]).toMatchObject({ ev: { type: 'pass', threeSixes: true } });
    expect(ludoModule.describe(g, ev[0], () => 'Asha')).toEqual(['pass', 'Three 6s for Asha, turn lost 😵']);
    expect(g.turnId).toBe('B');
    expect(g.stats.get('A')!.tallies).toMatchObject({ sixes: 3 });
  });

  it('Master: no way home before the first kill', () => {
    const { g, d } = game(2, 'master');
    g.seatOf('A').tokens = [48, 30, LUDO_BASE, LUDO_BASE];
    roll(g, d, 4);
    expect(g.movable()).toEqual([1]);
    g.stepAuto();
    g.turnId = 'A';
    g.seatOf('A').unlocked = true;
    roll(g, d, 4);
    expect(g.movable()).toEqual([0, 1]);
  });

  it('Master: gates open when only the lock keeps everyone still', () => {
    const { g, d } = game(2, 'master');
    g.seatOf('A').tokens = [50, 50, 50, 50];
    g.seatOf('B').tokens = [50, 50, 50, 50];
    const events: GameEvent[] = [];
    for (let i = 0; i < 6; i++) {
      roll(g, d, 3);
      events.push(...g.stepAuto());
    }
    expect(events.some((e) => e.kind === 'ludo' && e.ev.type === 'unlock')).toBe(true);
    expect(g.seats.every((s) => s.unlocked)).toBe(true);
  });

  it('Quick: gotis start open, and two home wins at once', () => {
    const { g, d } = game(3, 'quick');
    expect(g.seatOf('A').tokens).toEqual([0, 0, 0, 0]);
    g.seatOf('A').tokens = [LUDO_HOME, 53, 0, 0];
    g.seatOf('A').home = 1;
    roll(g, d, 3);
    const ev = g.move('A', 1);
    expect(kinds(ev)).toEqual(['ludo:move', 'finish', 'gameOver']);
    expect(g.over).toBe(true);
    expect(g.winners()).toEqual(['A']);
    expect(g.losers().sort()).toEqual(['B', 'C']);
  });

  it('Classic plays on until one is left', () => {
    const { g, d } = game(3);
    g.seatOf('A').tokens = [LUDO_HOME, LUDO_HOME, LUDO_HOME, 55];
    g.seatOf('A').home = 3;
    roll(g, d, 1);
    expect(kinds(g.move('A', 3))).toEqual(['ludo:move', 'finish']);
    expect(g.over).toBe(false);
    expect(g.turnId).toBe('B');
    g.seatOf('B').tokens = [LUDO_HOME, LUDO_HOME, LUDO_HOME, 55];
    g.seatOf('B').home = 3;
    g.seatOf('C').tokens = [10, LUDO_BASE, LUDO_BASE, LUDO_BASE];
    roll(g, d, 1);
    expect(kinds(g.move('B', 3))).toEqual(['ludo:move', 'finish', 'gameOver']);
    expect(g.winners()).toEqual(['A']);
    expect(g.placeOf('B')).toBe(2);
    expect(g.placeOf('C')).toBe(3);
    expect(g.losers().sort()).toEqual(['B', 'C']);
  });

  it('Timed: points for squares, kills and home; a knocked goti loses its squares; time up ranks by points', () => {
    const { g, d } = game(2, 'timed');
    expect(g.endsAt).toBe(1_000_000 + 5 * 60_000);
    g.seatOf('A').tokens = [3, LUDO_BASE, LUDO_BASE, LUDO_BASE];
    const yellowAt = (ring: number) => (ring - 26 + 52) % 52;
    g.seatOf('B').tokens = [yellowAt(5), LUDO_BASE, LUDO_BASE, LUDO_BASE];
    g.seatOf('B').score = 40;
    roll(g, d, 2);
    g.move('A', 0);
    expect(g.seatOf('A').score).toBe(2 + 20);
    expect(g.seatOf('B').score).toBe(40 - yellowAt(5));
    expect(kinds(g.timeUp())).toEqual(['gameOver']);
    expect(g.timedOut).toBe(true);
    expect(g.winners()).toEqual([g.seatOf('A').score >= g.seatOf('B').score ? 'A' : 'B']);
    expect(ludoModule.describe(g, { kind: 'gameOver', loserId: null }, (id) => id ?? '')![1]).toMatch(/^Time's up! /);
  });

  it('2v2: a player all home moves the partner\'s gotis; the team wins when both are home', () => {
    const { g, d } = game(4, 'classic', { teams: true });
    g.seatOf('A').tokens = [LUDO_HOME, LUDO_HOME, LUDO_HOME, 55];
    g.seatOf('A').home = 3;
    g.seatOf('C').tokens = [LUDO_HOME, LUDO_HOME, LUDO_HOME, 50];
    g.seatOf('C').home = 3;
    roll(g, d, 1);
    expect(kinds(g.move('A', 3))).toEqual(['ludo:move', 'finish']);
    // home earns a roll, now for the partner (yellow)
    expect(g.turnId).toBe('A');
    expect(g.movesFor).toBe('C');
    roll(g, d, 6);
    const ev = g.move('A', 3);
    expect(ev[0]).toMatchObject({ ev: { playerId: 'A', owner: 'C', to: LUDO_HOME } });
    expect(g.over).toBe(true);
    expect(g.winners().sort()).toEqual(['A', 'C']);
    expect(g.losers().sort()).toEqual(['B', 'D']);
    expect(g.placeOf('A')).toBe(1);
    expect(g.placeOf('B')).toBeNull();
  });

  it('2v2: partners never knock each other off', () => {
    const { g, d } = game(4, 'classic', { teams: true });
    const yellowAt = (ring: number) => (ring - 26 + 52) % 52;
    g.seatOf('C').tokens = [yellowAt(5), LUDO_BASE, LUDO_BASE, LUDO_BASE];
    g.seatOf('A').tokens = [3, 20, LUDO_BASE, LUDO_BASE];
    roll(g, d, 2);
    g.move('A', 0);
    expect(g.seatOf('C').tokens[0]).toBe(yellowAt(5));
  });

  it('leaving is a forfeit: gotis leave the board, the walk-out loses, the last one left wins', () => {
    const { g } = game(3);
    g.seatOf('B').tokens = [12, 3, LUDO_BASE, LUDO_BASE];
    expect(g.leave('B')).toEqual([]);
    expect(g.seatOf('B').tokens).toEqual([LUDO_BASE, LUDO_BASE, LUDO_BASE, LUDO_BASE]);
    expect(g.inPlay('B')).toBe(false);
    const ev = g.leave('C');
    expect(kinds(ev)).toEqual(['finish', 'gameOver']);
    expect(g.winners()).toEqual(['A']);
    expect(g.losers().sort()).toEqual(['B', 'C']);
  });

  it('a kick leaving one player stops the game with no winner', () => {
    const { g } = game(2);
    expect(kinds(g.removePlayer('B'))).toEqual(['gameOver']);
    expect(g.aborted).toBe(true);
    expect(g.winners()).toEqual([]);
    expect(g.losers()).toEqual([]);
  });

  it('2v2: a walk-out hands the game to the other team', () => {
    const { g } = game(4, 'classic', { teams: true });
    g.leave('B');
    expect(g.over).toBe(true);
    expect(g.winners().sort()).toEqual(['A', 'C']);
    expect(g.losers().sort()).toEqual(['B', 'D']);
  });

  it('refuses moves out of turn, before rolling, and bad payloads', () => {
    const { g, d } = game(2);
    expect(() => g.roll('B')).toThrow('Not your turn');
    expect(() => g.move('A', 0)).toThrow('Roll the dice first');
    roll(g, d, 6);
    expect(() => g.roll('A')).toThrow('Move a goti first');
    expect(() => ludoModule.move(g, 'A', { type: 'move', token: 7 })).toThrow('Pick one of your gotis');
    expect(() => ludoModule.move(g, 'A', { type: 'jump' })).toThrow('Invalid move');
    expect(() => ludoModule.move(g, 'A', 'roll')).toThrow('Invalid move');
  });

  it('parseConfig keeps only known Ludo options and defaults the rest', () => {
    const c = parseConfig({ decks: 1, bluffRule: 'one', game: 'ludo', opts: { mode: 'timed', time: 99, evil: 'x' } });
    expect(c.game).toBe('ludo');
    expect(c.opts).toEqual({ mode: 'timed' });
    expect(new LudoGame(['A', 'B'], c, () => 0, 0).endsAt).toBe(5 * 60_000);
    // older apps: no opts, Classic
    expect(new LudoGame(['A', 'B'], parseConfig({ decks: 1, bluffRule: 'one', game: 'ludo' }), () => 0).mode).toBe('classic');
  });
});
