import { describe, expect, it } from 'vitest';
import { covers, inBand, SPIKES_COUNTDOWN_MS, SPIKES_MAX_MS, SPIKES_SAFE_MS, SPIKES_SLACK, SpikesGame, type LiveWarning } from '../src/games/spikes/game.js';
import { parseSpikesMove, SPIKES_PUSH_MS, spikesModule } from '../src/games/spikes/module.js';
import type { GameEvent } from '../src/models.js';
import { SPIKES_LIVES, SPIKES_RADIUS, SPIKES_SPEED, type BotLevel, type SpikeDir } from '../src/types.js';
import { parseConfig } from '../src/validate.js';

const config = (size = 5, speed = 'normal', botLevel: BotLevel = 'hard') => ({ ...parseConfig({ decks: 1, bluffRule: 'one', game: 'spikes', opts: { size, speed } }), botLevel });

/** a game on a clock the test moves; rand picks warnings */
function game(ids = ['A', 'B'], opts: { size?: number; speed?: string; bots?: string[]; level?: BotLevel; rand?: (n: number) => number; jitter?: () => number } = {}) {
  let t = 1_000_000;
  const clock = { now: () => t, set: (ms: number) => (t = ms), add: (ms: number) => (t += ms) };
  const g = new SpikesGame(ids, config(opts.size, opts.speed, opts.level), opts.rand ?? (() => 0), opts.bots ?? [], clock.now, opts.jitter ?? (() => 0.5));
  return { g, clock };
}

/** a started game with no warnings of its own */
function playing(ids = ['A', 'B'], opts: Parameters<typeof game>[1] = {}) {
  const r = game(ids, opts);
  r.clock.set(r.g.startsAt);
  r.g.go();
  r.g.nextWarnAt = Infinity;
  return r;
}

/** a warning placed by hand, striking after `ms` */
function warnOn(g: SpikesGame, now: number, dir: SpikeDir, line: number, ms = 1000): LiveWarning {
  const w: LiveWarning = { id: 900 + g.warnings.length, dir, line, warnAt: now, strikeAt: now + ms, onLine: new Set(), notice: new Map() };
  for (const id of g.order) if (g.alive(id) && covers(w, g.pos.get(id)!)) w.onLine.add(id);
  g.warnings.push(w);
  return w;
}

const kinds = (events: GameEvent[]) => events.map((e) => (e.kind === 'spikes' ? `spikes:${e.ev.type}` : e.kind));
const near = (a: number[], b: number[], d = 1e-9) => a.every((v, i) => Math.abs(v - b[i]) <= d);

describe('Spike Attack rules: free movement', () => {
  it('players start at the corner boxes\' centres with 3 lives; a 3 s countdown; nobody has a turn', () => {
    const { g, clock } = game(['A', 'B', 'C', 'D']);
    expect(g.turnId).toBeNull();
    expect(g.startsAt).toBe(clock.now() + SPIKES_COUNTDOWN_MS);
    const v = g.view();
    expect(v).toMatchObject({ size: 5, phase: 'countdown', pos: { A: [0.5, 0.5], B: [4.5, 4.5], C: [4.5, 0.5], D: [0.5, 4.5] }, lives: { A: SPIKES_LIVES, B: 3, C: 3, D: 3 }, warnings: [], strikes: [], places: {}, now: clock.now() });
    expect(game(['A', 'B'], { size: 6 }).g.view().pos).toEqual({ A: [0.5, 0.5], B: [5.5, 5.5] });
    expect(() => new SpikesGame(['A'], config())).toThrow('Spike Attack needs 2 to 4 players');
  });

  it('a move within SPIKES_SPEED is taken as sent; not before the countdown; not once out', () => {
    const { g, clock } = game();
    expect(() => g.moveTo('A', 0.6, 0.5)).toThrow('Wait for the countdown');
    clock.set(g.startsAt);
    g.go();
    clock.add(100);
    // 0.32 units in 100 ms, plus the starting slack
    expect(g.moveTo('A', 0.5 + 0.3, 0.5)).toEqual([{ kind: 'spikes', ev: { type: 'step', playerId: 'A', to: [0.8, 0.5] } }]);
    expect(g.view().pos.A).toEqual([0.8, 0.5]);
    expect(() => g.moveTo('Z', 1, 1)).toThrow("You're not playing this game");
    g.placeMap.set('B', 2);
    expect(() => g.moveTo('B', 4, 4)).toThrow("You're out");
  });

  it('too far is cut back along the line to speed × time + slack, never refused', () => {
    const { g, clock } = playing();
    // after the first move the slack is used up
    clock.add(1000);
    g.moveTo('A', 0.5 + 0.1, 0.5);
    clock.add(250);
    const allowed = (SPIKES_SPEED * 250) / 1000 + SPIKES_SLACK;
    const [e] = g.moveTo('A', 4.6, 3.5);
    const to = (e as Extract<GameEvent, { kind: 'spikes' }>).ev as { to: [number, number] };
    const from = [0.6, 0.5];
    expect(Math.hypot(to.to[0] - from[0], to.to[1] - from[1])).toBeCloseTo(allowed, 9);
    // along the line towards the asked point
    const dir = [4.6 - 0.6, 3.5 - 0.5];
    expect((to.to[0] - from[0]) / dir[0]).toBeCloseTo((to.to[1] - from[1]) / dir[1], 9);
  });

  it('the slack never adds up: 12 moves a second at double speed still only go SPIKES_SPEED', () => {
    const { g, clock } = playing();
    let target: [number, number] = [0.5, 0.5];
    for (let i = 0; i < 12; i++) {
      clock.add(83);
      target = [Math.min(4.6, target[0] + (2 * SPIKES_SPEED * 83) / 1000), 0.5];
      g.moveTo('A', target[0], 0.5);
    }
    const ran = g.pos.get('A')![0] - 0.5;
    // 1 s of moves: speed × time plus one slack at most
    expect(ran).toBeLessThanOrEqual((SPIKES_SPEED * 12 * 83) / 1000 + SPIKES_SLACK + 1e-9);
    expect(ran).toBeGreaterThan((SPIKES_SPEED * 12 * 83) / 1000 - 0.01);
  });

  it('bunched moves after a late packet use the saved slack', () => {
    const { g, clock } = playing();
    clock.add(160);
    g.moveTo('A', 0.5 + 0.25, 0.5);
    // two packets arrive 10 ms apart, each 83 ms of running (0.266)
    clock.add(10);
    g.moveTo('A', 0.75 + 0.266, 0.5);
    expect(g.pos.get('A')![0]).toBeCloseTo(1.016, 9);
  });

  it('positions stay inside the arena, by the body radius', () => {
    const { g, clock } = playing();
    clock.add(5000);
    g.moveTo('A', -3, -3);
    expect(g.pos.get('A')).toEqual([SPIKES_RADIUS, SPIKES_RADIUS]);
    clock.add(5000);
    g.moveTo('A', 99, 2);
    expect(g.pos.get('A')![0]).toBe(5 - SPIKES_RADIUS);
  });

  it('hit bands: a body overlapping the row or column (a little forgiving) is on it', () => {
    const edge = 0.5 + SPIKES_RADIUS * 0.85;
    expect(inBand(2.5, 2)).toBe(true);
    expect(inBand(2.5 + edge - 0.001, 2)).toBe(true);
    expect(inBand(2.5 - edge + 0.001, 2)).toBe(true);
    expect(inBand(2.5 + edge + 0.001, 2)).toBe(false);
    expect(inBand(2.5 - edge - 0.001, 2)).toBe(false);
    // a body centred on the line between two lanes is on both
    expect(inBand(3, 2) && inBand(3, 3)).toBe(true);
    // rows test y, columns x
    expect(covers({ dir: 'left', line: 1 }, [4.5, 1.5])).toBe(true);
    expect(covers({ dir: 'left', line: 1 }, [1.5, 4.5])).toBe(false);
    expect(covers({ dir: 'top', line: 1 }, [1.5, 4.5])).toBe(true);
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
    expect(w.strikeAt - w.warnAt).toBeGreaterThan(2950);
    expect(g.pace(g.startsAt).warn).toBe(3000);
    clock.set(g.nextWarnAt);
    expect(g.warn()).toEqual([]);
    expect(g.pace(g.startsAt + 40_000)).toMatchObject({ most: 3 });
    expect(g.pace(g.startsAt + 75_000).warn).toBe(1000);
    const fast = game(['A', 'B'], { speed: 'fast' }).g;
    expect(fast.pace(fast.startsAt).warn).toBe(2000);
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

  it('the strike hits every body overlapping its band at strikeAt; 1 s of safety after a hit', () => {
    const { g, clock } = playing(['A', 'B', 'C']);
    // row 0: A at the corner, C half a box into row 1 but still overlapping row 0
    g.pos.set('C', [3, 1.2]);
    g.pos.set('B', [3, 1.3]);
    const w = warnOn(g, clock.now(), 'left', 0, 1500);
    expect(g.nextStep()!.at).toBe(w.strikeAt);
    clock.set(w.strikeAt);
    expect(g.strike()).toEqual([{ kind: 'spikes', ev: { type: 'strike', id: w.id, dir: 'left', line: 0, hit: ['A', 'C'] } }]);
    expect(g.view().lives).toEqual({ A: 2, B: 3, C: 2 });
    expect(g.view().safeUntil.A).toBe(clock.now() + SPIKES_SAFE_MS);
    const w2 = warnOn(g, clock.now(), 'top', 0, SPIKES_SAFE_MS - 1);
    clock.set(w2.strikeAt);
    expect(g.strike()[0]).toMatchObject({ ev: { hit: [] } });
    const w3 = warnOn(g, clock.now(), 'top', 0, 1);
    clock.set(w3.strikeAt);
    expect(g.strike()[0]).toMatchObject({ ev: { hit: ['A'] } });
    expect(spikesModule.tallies(g, 'A')).toEqual({ dodges: 0, hits: 2 });
  });

  it('running out of the band before the strike is a dodge', () => {
    const { g, clock } = playing();
    const w = warnOn(g, clock.now(), 'top', 0, 1000);
    clock.add(400);
    g.moveTo('A', 1.5, 0.5);
    clock.set(w.strikeAt);
    expect(g.strike()[0]).toMatchObject({ ev: { hit: [] } });
    expect(spikesModule.tallies(g, 'A')).toEqual({ dodges: 1, hits: 0 });
    expect(spikesModule.tallies(g, 'B')).toEqual({ dodges: 0, hits: 0 });
  });

  it('out at 0 lives with a place; the last one standing wins', () => {
    const { g, clock } = playing(['A', 'B', 'C']);
    g.lives.set('A', 1).set('C', 1);
    // column 4: B [4.5,4.5] and C [4.5,0.5]
    let w = warnOn(g, clock.now(), 'bottom', 4, 1000);
    clock.set(w.strikeAt);
    expect(kinds(g.strike())).toEqual(['spikes:strike', 'spikes:out']);
    expect(g.view().places).toEqual({ C: 3 });
    expect(g.inPlay('C')).toBe(false);
    clock.add(SPIKES_SAFE_MS);
    w = warnOn(g, clock.now(), 'left', 0, 1000);
    clock.set(w.strikeAt);
    const ev = g.strike();
    expect(kinds(ev)).toEqual(['spikes:strike', 'spikes:out', 'finish', 'gameOver']);
    expect(g.winners()).toEqual(['B']);
    expect(g.losers()).toEqual(['A', 'C']);
    expect([g.placeOf('A'), g.placeOf('B'), g.placeOf('C')]).toEqual([2, 1, 3]);
    const n = (id: string | null) => `P${id}`;
    expect(spikesModule.describe(g, ev[1], n)).toEqual(['play', 'PA is out 💀 (2nd)']);
    expect(spikesModule.describe(g, ev[2], n)).toEqual(['finish', 'PB is the last one standing! 🏆']);
    expect(spikesModule.describe(g, ev[3], n)).toEqual(['over', 'Game over. PB wins 🎉']);
  });

  it('the last players out on the same strike share the win', () => {
    const { g, clock } = playing();
    g.lives.set('A', 1).set('B', 1);
    g.pos.set('B', [3.5, 0.5]);
    const w = warnOn(g, clock.now(), 'right', 0, 1000);
    clock.set(w.strikeAt);
    expect(kinds(g.strike())).toEqual(['spikes:strike', 'spikes:out', 'spikes:out', 'gameOver']);
    expect(g.winners()).toEqual(['A', 'B']);
  });

  it('after the time limit, most lives left wins; a walk-out hands over the game, a kick stops it', () => {
    const { g, clock } = playing(['A', 'B', 'C']);
    g.lives.set('A', 2);
    expect(g.nextStep()!.at).toBe(g.startsAt + SPIKES_MAX_MS);
    clock.set(g.startsAt + SPIKES_MAX_MS);
    expect(kinds(g.nextStep()!.run())).toEqual(['spikes:timeUp', 'gameOver']);
    expect(g.winners()).toEqual(['B', 'C']);
    const a = game().g;
    expect(kinds(a.leave('B'))).toEqual(['finish', 'gameOver']);
    expect(a.winners()).toEqual(['A']);
    const b = game().g;
    b.removePlayer('B');
    expect(b.aborted).toBe(true);
  });

  it('people\'s moves are live: no key change, coalesced into views every 80 ms', () => {
    const { g, clock } = playing(['A', 'X'], { bots: ['X'] });
    const k = spikesModule.turnKey(g);
    clock.add(100);
    const moved = spikesModule.move(g, 'A', { type: 'move', x: 0.7, y: 0.5 });
    expect(spikesModule.turnKey(g)).toBe(k);
    expect(moved.every((e) => spikesModule.live!.is(e))).toBe(true);
    expect(spikesModule.live!.ms).toBe(SPIKES_PUSH_MS);
    expect(SPIKES_PUSH_MS).toBeLessThanOrEqual(80);
    expect(spikesModule.live!.is({ kind: 'spikes', ev: { type: 'warn', id: 1, dir: 'left', line: 0 } })).toBe(false);
    expect(spikesModule.live!.is({ kind: 'gameOver', loserId: null })).toBe(false);
    const w = warnOn(g, clock.now(), 'left', 3, 100);
    expect(g.nextStep()!.at).toBeLessThanOrEqual(w.strikeAt);
    expect(spikesModule.auto(g)).toMatchObject({ quiet: true });
    // ~12 moves a second fit the move allowance
    expect(spikesModule.moveRate).toBeGreaterThanOrEqual(150);
  });

  it('parses moves and keeps announcements sparse', () => {
    expect(parseSpikesMove({ type: 'move', x: 1.25, y: 3 })).toEqual({ type: 'move', x: 1.25, y: 3 });
    for (const bad of [{ type: 'step', dir: 'up' }, { type: 'move', x: 'a', y: 1 }, { type: 'move', x: NaN, y: 1 }, { type: 'move', x: 1, y: 1e9 }, null, 'move']) expect(() => parseSpikesMove(bad)).toThrow('Invalid move');
    const { g } = game();
    const n = (id: string | null) => `P${id}`;
    expect(spikesModule.describe(g, { kind: 'spikes', ev: { type: 'step', playerId: 'A', to: [1, 0] } }, n)).toBeNull();
    expect(spikesModule.describe(g, { kind: 'spikes', ev: { type: 'strike', id: 1, dir: 'left', line: 0, hit: ['A'] } }, n)).toBeNull();
    expect(spikesModule.describe(g, { kind: 'spikes', ev: { type: 'go' } }, n)).toEqual(['round', 'Dodge the spikes! 🔺']);
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
  let maxSpeed = 0;
  for (let s = g.nextStep(); s; s = g.nextStep()) {
    clock.set(Math.max(clock.now(), s.at));
    const before = new Map([...g.botRun].map(([id, run]) => [id, { at: run.movedAt, p: [...g.pos.get(id)!] }]));
    s.run();
    // bots never run faster than the speed limit
    for (const [id, b] of before) {
      const run = g.botRun.get(id);
      if (!run || run.movedAt === b.at) continue;
      const p = g.pos.get(id)!;
      maxSpeed = Math.max(maxSpeed, (Math.hypot(p[0] - b.p[0], p[1] - b.p[1]) * 1000) / (run.movedAt - b.at));
    }
    if (++steps > 400_000) throw new Error('runaway');
  }
  return { g, ms: clock.now() - g.startsAt, maxSpeed };
}

describe('Spike Attack bots', () => {
  it('bots move continuously, finish many games; better levels last longer and get hit less', () => {
    const out: Record<string, { ms: number; hitsPerMin: number; dodges: number }> = {};
    for (const level of ['normal', 'hard', 'expert'] as BotLevel[]) {
      let ms = 0;
      let hits = 0;
      let dodges = 0;
      const games = 60;
      for (let i = 0; i < games; i++) {
        const { g, ms: t, maxSpeed } = simulate(level, 50 + i, i % 2 ? 5 : 6, i % 3 ? 'normal' : 'fast');
        expect(g.over).toBe(true);
        expect(g.winners().length).toBeGreaterThan(0);
        expect(maxSpeed).toBeLessThanOrEqual(SPIKES_SPEED + 1e-6);
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
    expect(out.expert.dodges).toBeGreaterThan(1);
  }, 120_000);

  it('a bot on a warned row runs off it in time, off the box grid', () => {
    const { g, clock } = playing(['A', 'X'], { bots: ['X'], level: 'expert' });
    const w = warnOn(g, clock.now(), 'left', 4, 2000);
    w.notice.set('X', clock.now() + 200);
    const seen: number[][] = [];
    for (let s = g.nextStep(); s && s.at <= w.strikeAt; s = g.nextStep()) {
      clock.set(Math.max(clock.now(), s.at));
      s.run();
      seen.push([...g.pos.get('X')!]);
    }
    expect(g.lives.get('X')).toBe(3);
    expect(spikesModule.tallies(g, 'X').dodges).toBe(1);
    // moved in small steps, not box jumps
    expect(seen.some((p) => !near(p.map((v) => (v - 0.5) % 1), [0, 0], 0.001))).toBe(true);
  });
});
