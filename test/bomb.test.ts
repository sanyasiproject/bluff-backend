import { describe, expect, it } from 'vitest';
import { BombGame, BOMB_COUNTDOWN_MS, BOMB_FUSE } from '../src/games/bomb/game.js';
import { bombModule, parseBombMove } from '../src/games/bomb/module.js';
import { makeTask, nextKind, seeded } from '../src/games/bomb/tasks.js';
import { BOMB_ARROWS, BOMB_INKS, BOMB_TASK_KINDS, type BotLevel, type GameConfig } from '../src/types.js';

const rng = (seed: number) => () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

function setup(ids: string[], opts: Record<string, unknown> = {}, bots: string[] = [], level: BotLevel = 'hard', seed = 1) {
  let t = 1e12;
  const r = rng(seed);
  const config = { game: 'bomb', botLevel: level, opts } as unknown as GameConfig;
  const g = new BombGame(ids, config, (n) => Math.floor(r() * n), bots, r, () => t);
  /** runs timed steps up to `until` (or the next one) */
  const step = () => {
    const s = g.nextStep()!;
    t = Math.max(t, s.at);
    return s.run();
  };
  const at = (ms: number) => (t = ms);
  return { g, step, at, now: () => t };
}

const answerOf = (g: BombGame) => g.task!.answer;

describe('Bomb Pass tasks', () => {
  it('every kind: 2 to 4 choices, the answer among them, never the same kind twice in a row', () => {
    const r = seeded(9);
    let prev = null;
    for (let i = 0; i < 600; i++) {
      const kind = nextKind(r, prev);
      expect(kind).not.toBe(prev);
      prev = kind;
      const { task, answer } = makeTask(r, i, kind, i % 4);
      expect(task.choices.length).toBeGreaterThanOrEqual(2);
      expect(task.choices.length).toBeLessThanOrEqual(4);
      expect(new Set(task.choices).size).toBe(task.choices.length);
      expect(answer).toBeGreaterThanOrEqual(0);
      expect(answer).toBeLessThan(task.choices.length);
      if (kind === 'sum') {
        const [a, op, b] = task.prompt.split(' ');
        expect(Number(task.choices[answer])).toBe(op === '+' ? Number(a) + Number(b) : Number(a) - Number(b));
      }
      if (kind === 'bigger') expect(Number(task.choices[answer])).toBe(Math.max(...task.choices.map(Number)));
      if (kind === 'colour') {
        expect(task.choices[answer]).toBe(task.ink);
        expect(task.word).not.toBe(task.ink!.toUpperCase());
        expect([...task.choices].sort()).toEqual([...BOMB_INKS].sort());
      }
      if (kind === 'count') expect(Number(task.choices[answer])).toBe(task.dots!.length);
      if (kind === 'arrow') expect(BOMB_ARROWS[answer]).toBe(task.arrow);
    }
    expect(BOMB_TASK_KINDS).toHaveLength(6);
  });
});

describe('Bomb Pass game', () => {
  it('counts down, then a random holder gets a task; the fuse is never in the view', () => {
    const { g, step } = setup(['a', 'b', 'c']);
    expect(g.view().phase).toBe('countdown');
    expect(g.view().startsAt - g.now()).toBe(BOMB_COUNTDOWN_MS);
    step();
    const v = g.view();
    expect(v.phase).toBe('play');
    expect(v.holder).not.toBeNull();
    expect(v.task).not.toBeNull();
    expect(g.fuseMs).toBeGreaterThanOrEqual(BOMB_FUSE.normal[0]);
    expect(g.fuseMs).toBeLessThanOrEqual(BOMB_FUSE.normal[1]);
    const text = JSON.stringify(bombModule.view(g, 'a', true));
    expect(text).not.toContain(String(g.fuseMs));
    expect(text).not.toContain('answer');
    expect(text).not.toContain('roundAt');
  });

  it('a right answer passes clockwise with a fresh task; a wrong one shakes, then a new task', () => {
    const { g, step, at, now } = setup(['a', 'b', 'c']);
    step();
    const h = g.holder!;
    const next = g.order[(g.order.indexOf(h) + 1) % 3];
    const task = g.task!.task.id;
    expect(() => g.answer(next, g.task!.task.id, 0)).toThrow("You don't have the bomb");
    g.answer(h, task, answerOf(g));
    expect(g.holder).toBe(next);
    expect(g.task!.task.id).not.toBe(task);
    expect(bombModule.tallies(g, h)).toMatchObject({ passes: 1, fastest: 1 });
    // a stale tap does nothing
    expect(g.answer(next, task, 0)).toEqual([]);
    const wrong = (answerOf(g) + 1) % g.task!.task.choices.length;
    const id = g.task!.task.id;
    expect(g.answer(next, id, wrong)[0]).toMatchObject({ kind: 'bomb', ev: { type: 'wrong' } });
    expect(g.holder).toBe(next);
    expect(g.view().shakeUntil).toBe(now() + 800);
    // while it shakes, taps do nothing
    expect(g.answer(next, id, answerOf(g))).toEqual([]);
    at(now() + 800);
    step();
    expect(g.task!.task.id).not.toBe(id);
    expect(g.holder).toBe(next);
  });

  it('heat rises in the last 30%, then BOOM: a heart lost, a break, the next round from the next player', () => {
    const { g, step, now } = setup(['a', 'b'], { hearts: 2, speed: 'fast' });
    step();
    const start = now();
    const fuse = g.fuseMs;
    expect(fuse).toBeLessThanOrEqual(BOMB_FUSE.fast[1]);
    const heats: number[] = [];
    for (let i = 0; i < 3; i++) {
      step();
      heats.push(g.view().heat);
      expect(now() - start).toBeGreaterThanOrEqual(fuse * 0.7 - 1);
    }
    expect(heats).toEqual([1, 2, 3]);
    const h = g.holder!;
    const ev = step();
    expect(ev[0]).toMatchObject({ kind: 'bomb', ev: { type: 'boom', playerId: h, out: false } });
    expect(now() - start).toBe(fuse);
    const v = g.view();
    expect(v).toMatchObject({ phase: 'boom', holder: null, task: null });
    expect(v.hearts[h]).toBe(1);
    expect(v.nextAt).toBe(now() + 3000);
    step();
    expect(g.phase).toBe('play');
    expect(g.round).toBe(2);
    expect(g.holder).toBe(g.order.find((p) => p !== h));
  });

  it('0 hearts is out; the last one alive wins', () => {
    const { g, step } = setup(['a', 'b', 'c'], { hearts: 2 });
    let n = 0;
    while (!g.over && n++ < 200) step();
    expect(g.over).toBe(true);
    const won = g.winners();
    expect(won).toHaveLength(1);
    expect(g.hearts.get(won[0])).toBeGreaterThan(0);
    const v = g.view();
    expect(v.places[won[0]]).toBe(1);
    expect(Object.values(v.places).sort()).toEqual([1, 2, 3]);
    expect(g.outOrder).toHaveLength(2);
    expect(g.losers()).toHaveLength(2);
  });

  it('the holder walking out passes the bomb on; a kick with nobody out stops the game', () => {
    const { g, step } = setup(['a', 'b', 'c']);
    step();
    const h = g.holder!;
    g.leave(h);
    expect(g.holder).not.toBe(h);
    expect(g.holder).not.toBeNull();
    const k = setup(['a', 'b']);
    k.step();
    k.g.removePlayer('b');
    expect(k.g.over && k.g.aborted).toBe(true);
  });

  it('moves are parsed strictly', () => {
    expect(parseBombMove({ type: 'answer', task: 3, choice: 1 })).toEqual({ type: 'answer', task: 3, choice: 1 });
    expect(() => parseBombMove({ type: 'answer', task: '3', choice: 1 })).toThrow('Invalid move');
    const { g, step } = setup(['a', 'b']);
    step();
    expect(() => g.answer(g.holder!, g.task!.task.id, 7)).toThrow('Pick one of the answers');
  });

  it('bots answer at their level pace and finish hundreds of games', () => {
    for (const level of ['normal', 'hard', 'expert'] as BotLevel[]) {
      for (let i = 0; i < 100; i++) {
        const ids = ['a', 'b', 'c', 'd'].slice(0, 2 + (i % 3));
        const { g, step } = setup(ids, { hearts: i % 2 ? 2 : 3, speed: i % 2 ? 'fast' : 'normal' }, ids, level, i + 1);
        let n = 0;
        let passes = 0;
        while (!g.over && n++ < 5000) {
          const ev = step();
          for (const e of ev) {
            if (e.kind === 'bomb' && e.ev.type === 'pass') {
              passes++;
              const [lo, hi] = { normal: [1600, 3200], hard: [1100, 2200], expert: [700, 1400] }[level];
              expect(e.ev.ms).toBeGreaterThanOrEqual(lo);
              expect(e.ev.ms).toBeLessThanOrEqual(hi);
            }
          }
        }
        expect(g.over).toBe(true);
        expect(g.winners()).toHaveLength(1);
        expect(passes).toBeGreaterThan(0);
      }
    }
  }, 120_000);
});
