import { describe, expect, it } from 'vitest';
import { SPIKES_COUNTDOWN_MS, SPIKES_MAX_MS, SPIKES_SAFE_MS, SPIKES_STEP_MS, SpikesGame, type LiveWarning } from '../src/games/spikes/game.js';
import { parseSpikesMove, spikesModule } from '../src/games/spikes/module.js';
import type { GameEvent } from '../src/models.js';
import { SPIKES_LIVES, type BotLevel, type SpikeDir } from '../src/types.js';
import { parseConfig } from '../src/validate.js';

const config = (size = 5, speed = 'normal', botLevel: BotLevel = 'hard') => ({ ...parseConfig({ decks: 1, bluffRule: 'one', game: 'spikes', opts: { size, speed } }), botLevel });

/** a game on a clock the test moves; rand picks warnings */
function game(ids = ['A', 'B'], opts: { size?: number; speed?: string; bots?: string[]; level?: BotLevel; rand?: (n: number) => number; jitter?: () => number } = {}) {
  let t = 1_000_000;
  const clock = { now: () => t, set: (ms: number) => (t = ms), add: (ms: number) => (t += ms) };
  const g = new SpikesGame(ids, config(opts.size, opts.speed, opts.level), opts.rand ?? ((n) => 0), opts.bots ?? [], clock.now, opts.jitter ?? (() => 0.5));
  return { g, clock };
}

/** a warning placed by hand, striking after `ms` */
function warnOn(g: SpikesGame, now: number, dir: SpikeDir, line: number, ms = 1000): LiveWarning {
  const w: LiveWarning = { id: 900 + g.warnings.length, dir, line, warnAt: now, strikeAt: now + ms, onLine: new Set(), notice: new Map() };
  for (const id of g.order) if (g.alive(id) && (dir === 'left' || dir === 'right' ? g.pos.get(id)![1] === line : g.pos.get(id)![0] === line)) w.onLine.add(id);
  g.warnings.push(w);
  return w;
}

const kinds = (events: GameEvent[]) => events.map((e) => (e.kind === 'spikes' ? `spikes:${e.ev.type}` : e.kind));

describe('Spike Attack rules', () => {
  it('players start in the corners with 3 lives; a 3 s countdown; nobody has a turn', () => {
    const { g, clock } = game(['A', 'B', 'C', 'D']);
    expect(g.turnId).toBeNull();
    expect(g.startsAt).toBe(clock.now() + SPIKES_COUNTDOWN_MS);
    const v = g.view();
    expect(v).toMatchObject({ size: 5, phase: 'countdown', pos: { A: [0, 0], B: [4, 4], C: [4, 0], D: [0, 4] }, lives: { A: SPIKES_LIVES, B: 3, C: 3, D: 3 }, warnings: [], strikes: [], places: {}, now: clock.now() });
    expect(game(['A', 'B'], { size: 6 }).g.view().pos).toEqual({ A: [0, 0], B: [5, 5] });
    expect(() => new SpikesGame(['A'], config())).toThrow('Spike Attack needs 2 to 4 players');
  });

  it('steps one square; walls stop you; one step per 140 ms; not before the countdown ends', () => {
    const { g, clock } = game();
    expect(() => g.step('A', 'right')).toThrow('Wait for the countdown');
    clock.set(g.startsAt);
    g.go();
    expect(() => g.step('A', 'up')).toThrow("Can't go that way");
    expect(() => g.step('A', 'left')).toThrow("Can't go that way");
    expect(g.step('A', 'right')).toEqual([{ kind: 'spikes', ev: { type: 'step', playerId: 'A', to: [1, 0] } }]);
    clock.add(SPIKES_STEP_MS - 1);
    expect(() => g.step('A', 'down')).toThrow('Too quick, one step at a time');
    clock.add(1);
    g.step('A', 'down');
    expect(g.view().pos.A).toEqual([1, 1]);
    // players may share a square
    g.pos.set('B', [1, 2]);
    clock.add(SPIKES_STEP_MS);
    g.step('A', 'down');
    expect(g.view().pos).toEqual({ A: [1, 2], B: [1, 2] });
    expect(() => g.step('Z', 'down')).toThrow("You're not playing this game");
  });

  it('warnings show 3 s at first (fast: 2 s), shrinking towards 1 s; more overlap later', () => {
    const { g, clock } = game();
    clock.set(g.startsAt);
    g.go();
    expect(g.nextStep()!.at).toBe(g.startsAt + 600);
    clock.set(g.nextWarnAt);
    const [e] = g.warn();
    expect(e).toMatchObject({ kind: 'spikes', ev: { type: 'warn', id: 1, dir: 'left', line: 0 } });
    const w = g.view().warnings[0];
    // 3 s at the start, a touch less 0.6 s in
    expect(w.strikeAt - w.warnAt).toBeGreaterThan(2950);
    expect(g.pace(g.startsAt).warn).toBe(3000);
    // only one at a time early on
    clock.set(g.nextWarnAt);
    expect(g.warn()).toEqual([]);
    expect(g.pace(g.startsAt).most).toBe(1);
    expect(g.pace(g.startsAt + 40_000)).toMatchObject({ most: 3 });
    expect(g.pace(g.startsAt + 75_000).warn).toBe(1000);
    expect(g.pace(g.startsAt + 200_000)).toMatchObject({ warn: 1000, most: 4 });
    expect(g.pace(g.startsAt + 30_000).warn).toBeGreaterThan(1000);
    const fast = game(['A', 'B'], { speed: 'fast' }).g;
    expect(fast.pace(fast.startsAt).warn).toBe(2000);
    expect(fast.pace(fast.startsAt + 50_000).warn).toBe(1000);
    // never as many as the lines: a safe square is always left
    expect(game(['A', 'B'], { size: 5 }).g.pace(Infinity).most).toBe(4);
  });

  it('a warning never repeats a row or column already warned', () => {
    const { g, clock } = game(['A', 'B'], { rand: (n) => n - 1 });
    clock.set(g.startsAt + 60_000);
    g.go();
    const lines = new Set<string>();
    for (let i = 0; i < 4; i++) {
      g.warn();
      const w = g.warnings[g.warnings.length - 1];
      const k = `${w.dir === 'left' || w.dir === 'right' ? 'row' : 'col'}${w.line}`;
      expect(lines.has(k)).toBe(false);
      lines.add(k);
    }
  });

  it('the strike comes at strikeAt and hits everyone on its line; 1 s of safety after a hit', () => {
    const { g, clock } = game(['A', 'B', 'C']);
    clock.set(g.startsAt);
    g.go();
    g.nextWarnAt = Infinity;
    // row 0: A at [0,0] and C at [4,0]
    const w = warnOn(g, clock.now(), 'left', 0, 1500);
    expect(g.nextStep()!.at).toBe(w.strikeAt);
    clock.set(w.strikeAt);
    const ev = g.strike();
    expect(ev).toEqual([{ kind: 'spikes', ev: { type: 'strike', id: w.id, dir: 'left', line: 0, hit: ['A', 'C'] } }]);
    expect(g.view().lives).toEqual({ A: 2, B: 3, C: 2 });
    expect(g.view().safeUntil.A).toBe(clock.now() + SPIKES_SAFE_MS);
    expect(g.view().strikes).toEqual([{ id: w.id, dir: 'left', line: 0, at: clock.now(), hit: ['A', 'C'] }]);
    // inside the safe second: not hit again
    const w2 = warnOn(g, clock.now(), 'top', 0, SPIKES_SAFE_MS - 1);
    clock.set(w2.strikeAt);
    expect(g.strike()[0]).toMatchObject({ ev: { hit: [] } });
    const w3 = warnOn(g, clock.now(), 'top', 0, 1);
    clock.set(w3.strikeAt);
    expect(g.strike()[0]).toMatchObject({ ev: { hit: ['A'] } });
    expect(spikesModule.tallies(g, 'A')).toEqual({ dodges: 0, hits: 2 });
  });

  it('stepping off the line in time is a dodge', () => {
    const { g, clock } = game();
    clock.set(g.startsAt);
    g.go();
    const w = warnOn(g, clock.now(), 'top', 0, 1000);
    g.step('A', 'right');
    clock.set(w.strikeAt);
    expect(g.strike()[0]).toMatchObject({ ev: { hit: [] } });
    expect(spikesModule.tallies(g, 'A')).toEqual({ dodges: 1, hits: 0 });
    expect(spikesModule.tallies(g, 'B')).toEqual({ dodges: 0, hits: 0 });
  });

  it('out at 0 lives with a place; the last one standing wins', () => {
    const { g, clock } = game(['A', 'B', 'C']);
    clock.set(g.startsAt);
    g.go();
    g.lives.set('A', 1).set('C', 1);
    // column 4: B [4,4] and C [4,0]; B has lives left
    let w = warnOn(g, clock.now(), 'bottom', 4, 1000);
    clock.set(w.strikeAt);
    expect(kinds(g.strike())).toEqual(['spikes:strike', 'spikes:out']);
    expect(g.view().places).toEqual({ C: 3 });
    expect(g.inPlay('C')).toBe(false);
    expect(() => g.step('C', 'left')).toThrow("You're out");
    clock.add(SPIKES_SAFE_MS);
    w = warnOn(g, clock.now(), 'left', 0, 1000);
    clock.set(w.strikeAt);
    const ev = g.strike();
    expect(kinds(ev)).toEqual(['spikes:strike', 'spikes:out', 'finish', 'gameOver']);
    expect(g.over).toBe(true);
    expect(g.winners()).toEqual(['B']);
    expect(g.losers()).toEqual(['A', 'C']);
    expect([g.placeOf('A'), g.placeOf('B'), g.placeOf('C')]).toEqual([2, 1, 3]);
    const n = (id: string | null) => `P${id}`;
    expect(spikesModule.describe(g, ev[1], n)).toEqual(['play', 'PA is out 💀 (2nd)']);
    expect(spikesModule.describe(g, ev[2], n)).toEqual(['finish', 'PB is the last one standing! 🏆']);
    expect(spikesModule.describe(g, ev[3], n)).toEqual(['over', 'Game over. PB wins 🎉']);
  });

  it('the last players out on the same strike share the win', () => {
    const { g, clock } = game(['A', 'B']);
    clock.set(g.startsAt);
    g.go();
    g.lives.set('A', 1).set('B', 1);
    g.pos.set('B', [3, 0]);
    const w = warnOn(g, clock.now(), 'right', 0, 1000);
    clock.set(w.strikeAt);
    expect(kinds(g.strike())).toEqual(['spikes:strike', 'spikes:out', 'spikes:out', 'gameOver']);
    expect(g.winners()).toEqual(['A', 'B']);
    expect(g.losers()).toEqual([]);
    expect(g.view().places).toEqual({ A: 1, B: 1 });
  });

  it('after the time limit, most lives left wins', () => {
    const { g, clock } = game(['A', 'B', 'C']);
    clock.set(g.startsAt);
    g.go();
    g.lives.set('A', 2).set('B', 3).set('C', 3);
    g.nextWarnAt = Infinity;
    expect(g.nextStep()!.at).toBe(g.startsAt + SPIKES_MAX_MS);
    clock.set(g.startsAt + SPIKES_MAX_MS);
    expect(kinds(g.nextStep()!.run())).toEqual(['spikes:timeUp', 'gameOver']);
    expect(g.winners()).toEqual(['B', 'C']);
    expect(g.placeOf('A')).toBe(3);
  });

  it('when no person is left standing, the bots still up are ranked by lives', () => {
    const { g, clock } = game(['P', 'X', 'Y'], { bots: ['X', 'Y'] });
    clock.set(g.startsAt);
    g.go();
    g.lives.set('P', 1).set('X', 2);
    const w = warnOn(g, clock.now(), 'top', 0, 500);
    clock.set(w.strikeAt);
    g.strike();
    expect(g.inPlay('P')).toBe(false);
    g.close();
    expect(g.winners()).toEqual(['Y']);
    expect(g.losers()).toEqual(['P', 'X']);
  });

  it('a walk-out leaving one hands them the game; a kick stops it', () => {
    const a = game().g;
    expect(kinds(a.leave('B'))).toEqual(['finish', 'gameOver']);
    expect(a.winners()).toEqual(['A']);
    expect(a.losers()).toEqual(['B']);
    const b = game().g;
    b.removePlayer('B');
    expect(b.aborted).toBe(true);
    expect(b.winners()).toEqual([]);
  });

  it('timed steps go in order: countdown, then the earliest of strike, warning and bot steps', () => {
    const { g, clock } = game(['A', 'X'], { bots: ['X'] });
    expect(g.nextStep()!.at).toBe(g.startsAt);
    clock.set(g.startsAt);
    g.nextStep()!.run();
    const k = spikesModule.turnKey(g);
    // a person's step doesn't move the key
    g.step('A', 'right');
    expect(spikesModule.turnKey(g)).toBe(k);
    const w = warnOn(g, clock.now(), 'left', 3, 100);
    expect(g.nextStep()!.at).toBe(w.strikeAt);
    expect(spikesModule.auto(g)).toMatchObject({ delayMs: 100, quiet: true });
  });

  it('parses moves and keeps announcements sparse', () => {
    expect(parseSpikesMove({ type: 'step', dir: 'left' })).toEqual({ type: 'step', dir: 'left' });
    for (const bad of [{ type: 'step', dir: 'north' }, { type: 'jump' }, null, 'step']) expect(() => parseSpikesMove(bad)).toThrow('Invalid move');
    const { g } = game();
    const n = (id: string | null) => `P${id}`;
    expect(spikesModule.describe(g, { kind: 'spikes', ev: { type: 'step', playerId: 'A', to: [1, 0] } }, n)).toBeNull();
    expect(spikesModule.describe(g, { kind: 'spikes', ev: { type: 'warn', id: 1, dir: 'left', line: 0 } }, n)).toBeNull();
    expect(spikesModule.describe(g, { kind: 'spikes', ev: { type: 'strike', id: 1, dir: 'left', line: 0, hit: ['A'] } }, n)).toBeNull();
    expect(spikesModule.describe(g, { kind: 'spikes', ev: { type: 'go' } }, n)).toEqual(['round', 'Dodge the spikes! 🔺']);
    expect(spikesModule.moveRate).toBeGreaterThanOrEqual(72);
  });
});

/** a small seeded random for repeatable sims */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** a bots-only game through its timed steps, the clock jumping to each */
function simulate(level: BotLevel, seed: number, size = 5, speed = 'normal') {
  const r = rng(seed);
  const ids = ['A', 'B', 'C', 'D'];
  const { g, clock } = game(ids, { size, speed, bots: ids, level, rand: (n) => Math.floor(r() * n), jitter: r });
  let steps = 0;
  for (let s = g.nextStep(); s; s = g.nextStep()) {
    clock.set(Math.max(clock.now(), s.at));
    s.run();
    if (++steps > 200_000) throw new Error('runaway');
  }
  return { g, ms: clock.now() - g.startsAt };
}

describe('Spike Attack bots', () => {
  it('bots finish hundreds of games; better levels last longer and get hit less', () => {
    const out: Record<string, { ms: number; hitsPerMin: number; dodges: number }> = {};
    for (const level of ['normal', 'hard', 'expert'] as BotLevel[]) {
      let ms = 0;
      let hits = 0;
      let dodges = 0;
      const games = 100;
      for (let i = 0; i < games; i++) {
        const { g, ms: t } = simulate(level, 50 + i, i % 2 ? 5 : 6, i % 3 ? 'normal' : 'fast');
        expect(g.over).toBe(true);
        expect(g.winners().length).toBeGreaterThan(0);
        ms += t;
        for (const id of g.order) {
          const tl = spikesModule.tallies(g, id);
          hits += tl.hits;
          dodges += tl.dodges;
        }
      }
      out[level] = { ms: ms / games, hitsPerMin: hits / (ms / 60_000), dodges: dodges / games };
      if (process.env.SIM_LOG) console.log(level, out[level]);
    }
    expect(out.normal.hitsPerMin).toBeGreaterThan(out.hard.hitsPerMin);
    expect(out.hard.hitsPerMin).toBeGreaterThan(out.expert.hitsPerMin);
    expect(out.normal.ms).toBeLessThan(out.expert.ms);
    expect(out.expert.dodges).toBeGreaterThan(0);
  }, 60_000);

  it('a bot on a warned line steps off in time when it can', () => {
    const { g, clock } = game(['A', 'X'], { bots: ['X'], level: 'expert' });
    clock.set(g.startsAt);
    g.go();
    g.nextWarnAt = Infinity;
    const w = warnOn(g, clock.now(), 'left', 4, 2000);
    w.notice.set('X', clock.now() + 200);
    for (let s = g.nextStep(); s && s.at <= w.strikeAt; s = g.nextStep()) {
      clock.set(Math.max(clock.now(), s.at));
      s.run();
    }
    expect(g.lives.get('X')).toBe(3);
    expect(spikesModule.tallies(g, 'X').dodges).toBe(1);
  });
});
