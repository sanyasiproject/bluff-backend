import { describe, expect, it } from 'vitest';
import { decide } from '../src/games/dots/brain.js';
import { DotsGame } from '../src/games/dots/game.js';
import { dotsModule, parseDotsMove } from '../src/games/dots/module.js';
import { dotsBoxLines, dotsLineCount, type BotLevel } from '../src/types.js';
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

const cfg = (size = 4) => parseConfig({ decks: 1, bluffRule: 'one', game: 'dots', opts: { size } });
const name = (id: string | null) => id ?? '?';

describe('Dots and Boxes rules', () => {
  it('a line that closes a box scores it and the same player goes again; otherwise the turn passes', () => {
    const g = new DotsGame(['A', 'B'], cfg(4), () => 0);
    expect(g.size).toBe(4);
    const [top, bottom, left, right] = dotsBoxLines(4, 0, 0);
    g.draw('A', top);
    expect(g.turnId).toBe('B');
    expect(() => g.draw('A', bottom)).toThrow('Not your turn');
    expect(() => g.draw('B', top)).toThrow('That line is already drawn');
    expect(() => g.draw('B', 999)).toThrow('Pick a line between two dots');
    g.draw('B', bottom);
    g.draw('A', left);
    const ev = g.draw('B', right);
    expect(ev).toEqual([{ kind: 'dots', ev: { type: 'line', playerId: 'B', line: right, closed: [0] } }]);
    expect(g.turnId).toBe('B');
    expect(g.view()).toMatchObject({ boxes: { 0: 'B' }, scores: { A: 0, B: 1 }, last: { seq: 4, playerId: 'B', line: right, closed: [0] } });
    expect(dotsModule.tallies(g, 'B')).toEqual({ boxes: 1 });
  });

  it('one line can close two boxes', () => {
    const g = new DotsGame(['A', 'B'], cfg(4), () => 0);
    const a = dotsBoxLines(4, 0, 0);
    const b = dotsBoxLines(4, 0, 1);
    // the shared side (a's right = b's left) last
    for (const l of [a[0], a[1], a[2], b[0], b[1], b[3]]) g.draw(g.turnId!, l);
    const who = g.turnId!;
    const ev = g.draw(who, a[3]);
    expect((ev[0] as { ev: { closed: number[] } }).ev.closed).toEqual([0, 1]);
    expect(dotsModule.describe(g, ev[0], name)).toEqual(['round', `Double! ${who} closed two boxes with one line ✌️`]);
  });

  it('ends when every box is closed; most boxes wins and ties share', () => {
    for (let seed = 1; seed < 40; seed++) {
      const r = seeded(seed);
      const g = new DotsGame(['A', 'B', 'C'], cfg(4), (m) => Math.floor(r() * m));
      while (!g.over) g.draw(g.turnId!, g.freeLines()[Math.floor(r() * g.freeLines().length)]);
      expect(g.lines.size).toBe(dotsLineCount(4));
      expect([...g.scores.values()].reduce((a, b) => a + b, 0)).toBe(16);
      const best = Math.max(...g.scores.values());
      expect(g.winners()).toEqual(['A', 'B', 'C'].filter((p) => g.scores.get(p) === best));
      for (const w of g.winners()) expect(g.placeOf(w)).toBe(1);
    }
  });

  it('a walk-out keeps their boxes on the board; the last one left wins', () => {
    const g = new DotsGame(['A', 'B'], cfg(5), () => 0);
    g.draw('A', 0);
    expect(g.leave('B').map((e) => e.kind)).toEqual(['gameOver']);
    expect(g.winners()).toEqual(['A']);
    expect(g.losers()).toEqual(['B']);
  });

  it('parses lines', () => {
    expect(parseDotsMove({ type: 'line', line: 3 })).toEqual({ type: 'line', line: 3 });
    expect(() => parseDotsMove({ type: 'line', line: 1.5 })).toThrow('Pick a line between two dots');
    expect(() => parseDotsMove({ type: 'tap' })).toThrow('Invalid move');
  });

  it('bots take a box when they can and never hand one over while a safe line is left (Hard, Expert)', () => {
    const g = new DotsGame(['A', 'B'], cfg(4), () => 0);
    const [top, bottom, left, right] = dotsBoxLines(4, 0, 0);
    g.draw('A', top);
    g.draw('B', bottom);
    g.draw('A', left);
    expect(decide(g, 'B', 'hard', seeded(1))).toEqual({ type: 'line', line: right });
    const h = new DotsGame(['A', 'B'], cfg(4), () => 0);
    h.draw('A', top);
    h.draw('B', bottom);
    for (let i = 0; i < 30; i++) {
      const { line } = decide(h, 'A', 'expert', seeded(i));
      expect([left, right]).not.toContain(line);
    }
  });
});

function botGame(levels: BotLevel[], size: number, seed: number) {
  const ids = levels.map((_, i) => `b${i}`);
  const r = seeded(seed);
  const g = new DotsGame(ids, cfg(size), (m) => Math.floor(r() * m), ids);
  let steps = 0;
  while (!g.over) {
    if (++steps > 500) throw new Error('stuck');
    const id = g.turnId!;
    dotsModule.move(g, id, dotsModule.botMove(g, id, levels[ids.indexOf(id)], r));
  }
  return g;
}

describe('Dots and Boxes bots', () => {
  it('finish hundreds of games on every board with 2 to 4 players', () => {
    let games = 0;
    for (const size of [4, 5, 6]) {
      for (const n of [2, 3, 4]) {
        for (const lv of ['normal', 'hard', 'expert'] as BotLevel[]) {
          for (let i = 0; i < 12; i++) {
            const g = botGame(Array(n).fill(lv), size, ++games * 13);
            expect(g.boxes.size).toBe(size * size);
            expect(g.winners().length).toBeGreaterThan(0);
          }
        }
      }
    }
    expect(games).toBe(324);
  }, 60_000);

  it('levels are ordered: Expert beats Hard beats Normal most of the time', () => {
    const share = (a: BotLevel, b: BotLevel) => {
      let mine = 0;
      for (let i = 0; i < 100; i++) mine += botGame([a, b], 4, 900 + i).scores.get('b0')! + 0;
      for (let i = 0; i < 100; i++) mine += 16 - botGame([b, a], 4, 2900 + i).scores.get('b0')!;
      return mine / (200 * 16);
    };
    expect(share('hard', 'normal')).toBeGreaterThan(0.6);
    expect(share('expert', 'hard')).toBeGreaterThan(0.52);
  }, 60_000);
});
