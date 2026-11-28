import { describe, expect, it } from 'vitest';
import { boxSpots, fairBoxes, freeCells, hitBy, makeBoxes, reachesOf, shieldedSpot, SPIKE_DIRS, SPIKES_HIT_SHARE, walk, type Cell, type Point } from '../src/games/spikes/arena.js';
import { SPIKES_SHIFT_CALM_MS, SPIKES_SHIFT_MS, SPIKES_SHIFT_TRIES, SPIKES_SHIFT_WARN_MS, SpikesGame } from '../src/games/spikes/game.js';
import { SPIKES_RADIUS, type BotLevel } from '../src/types.js';
import { parseConfig } from '../src/validate.js';

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const randInt = (seed: number) => {
  const r = rng(seed);
  return (n: number) => Math.floor(r() * n);
};
const config = (size: number, botLevel: BotLevel = 'hard') => ({ ...parseConfig({ decks: 1, bluffRule: 'one', game: 'spikes', opts: { size } }), botLevel });
const gap = (boxes: readonly Cell[], [x, y]: Point) => Math.min(Infinity, ...boxes.map(([c, r]) => Math.hypot(x - Math.min(c + 1, Math.max(c, x)), y - Math.min(r + 1, Math.max(r, y)))));

/** every spot a body fits (a fine grid, plus a ring hugging each crate), none hidden from all four walls */
function hiding(size: number, boxes: Cell[]): Point | null {
  const reaches = reachesOf(size, boxes);
  const R = SPIKES_RADIUS;
  const spots: Point[] = [];
  for (let x = R; x <= size - R + 1e-9; x += 0.02) for (let y = R; y <= size - R + 1e-9; y += 0.02) spots.push([x, y]);
  for (const [c, r] of boxes) {
    for (let k = 0; k < 360; k++) {
      // round each crate's corners and along its faces, just clear of it
      const a = (k / 360) * Math.PI * 2;
      const qx = c + 0.5 + Math.max(-0.5, Math.min(0.5, Math.cos(a) * 0.75));
      const qy = r + 0.5 + Math.max(-0.5, Math.min(0.5, Math.sin(a) * 0.75));
      spots.push([qx + Math.cos(a) * (R + 1e-6), qy + Math.sin(a) * (R + 1e-6)]);
    }
  }
  for (const p of spots) {
    if (p[0] < R || p[1] < R || p[0] > size - R || p[1] > size - R || gap(boxes, p) < R) continue;
    if (!SPIKE_DIRS.some((d) => hitBy(size, reaches[d], d, p))) return p;
  }
  return null;
}

describe('Spike Attack layouts on every arena', () => {
  it('4, 6, 10 and 14 crates; never on or by a start corner; every square reachable; the same for the same seed', () => {
    for (const [size, count] of [[5, 4], [6, 6], [8, 10], [10, 14]]) {
      const spots = new Set(boxSpots(size).map((c) => c.join()));
      for (let seed = 1; seed <= 25; seed++) {
        const boxes = makeBoxes(size, randInt(seed));
        expect(boxes).toHaveLength(count);
        expect(boxes.every((c) => spots.has(c.join()))).toBe(true);
        expect(fairBoxes(size, boxes)).toBe(true);
        expect(walk(size, boxes, [0, 0]).size).toBe(freeCells(size, boxes).length);
        expect(makeBoxes(size, randInt(seed))).toEqual(boxes);
      }
    }
  }, 60_000);

  it('the old camping spot: a crate on each arm of the middle hides the centre from all four walls, so it is refused', () => {
    const cross: Cell[] = [[2, 0], [0, 2], [4, 2], [2, 4]];
    expect(hiding(5, cross)).not.toBeNull();
    expect(shieldedSpot(5, cross, SPIKES_RADIUS * SPIKES_HIT_SHARE)).not.toBeNull();
    expect(fairBoxes(5, cross)).toBe(false);
  });

  it('no spot anywhere is hidden from all four walls (fine grid and crate corners, many seeds and sizes)', () => {
    for (const [size, seeds] of [[5, 12], [6, 20], [8, 14], [10, 8]]) {
      for (let seed = 100; seed < 100 + seeds; seed++) expect(hiding(size, makeBoxes(size, randInt(seed)))).toBeNull();
    }
  }, 60_000);
});

/** a game on a test clock, started */
function started(size: number, ids = ['A', 'B'], seed = 3, jitter = () => 0.9) {
  let t = 1_000_000;
  const clock = { now: () => t, set: (ms: number) => (t = ms) };
  const g = new SpikesGame(ids, config(size), randInt(seed), [], clock.now, jitter);
  clock.set(g.startsAt);
  g.go();
  return { g, clock };
}

describe('Spike Attack crate shifts', () => {
  it('only on 8 × 8 and up; walls get a little more warning there', () => {
    expect(started(5).g.nextShiftAt).toBe(Infinity);
    expect(started(6).g.nextShiftAt).toBe(Infinity);
    const g8 = started(8).g;
    expect(g8.nextShiftAt).toBe(g8.startsAt + SPIKES_SHIFT_MS);
    expect(g8.pace(g8.startsAt).warn).toBe(3250);
    expect(started(10).g.pace(g8.startsAt).warn).toBe(3500);
    expect(started(6).g.pace(g8.startsAt).warn).toBe(3000);
  });

  it('ghosts show 2 s ahead between walls, the crates land fair and never on a player; walls wait for the landing', () => {
    for (const size of [8, 10]) {
      for (let seed = 1; seed <= 12; seed++) {
        const { g, clock } = started(size, ['A', 'B', 'C', 'D'], seed);
        g.nextWarnAt = g.nextShiftAt + 100;
        clock.set(g.nextShiftAt);
        const step = g.nextStep()!;
        expect(step.at).toBe(g.nextShiftAt);
        expect(step.run()).toEqual([{ kind: 'spikes', ev: { type: 'shift', phase: 'warn' } }]);
        const v = g.view();
        expect(v.boxesAt).toBe(clock.now() + SPIKES_SHIFT_WARN_MS);
        expect(v.boxesNext).toHaveLength(v.boxes.length);
        expect(fairBoxes(size, g.boxesNext!)).toBe(true);
        expect(g.warn()).toEqual([]);
        expect(g.nextWarnAt).toBe(g.boxesAt + SPIKES_SHIFT_CALM_MS);
        // a player wanders right onto a target square: that layout is dropped for another, warned again
        const target = g.boxesNext![0];
        g.pos.set('B', [target[0] + 0.5, target[1] + 0.5]);
        clock.set(g.boxesAt);
        expect(g.nextStep()!.run()).toEqual([{ kind: 'spikes', ev: { type: 'shift', phase: 'warn' } }]);
        expect(g.boxesNext!.some(([c, r]) => c === target[0] && r === target[1])).toBe(false);
        const next = g.boxesNext!.map((c) => [...c]);
        clock.set(g.boxesAt);
        expect(g.nextStep()!.run()).toEqual([{ kind: 'spikes', ev: { type: 'shift', phase: 'land' } }]);
        expect(g.boxes).toEqual(next);
        expect(g.view().boxesNext).toBeUndefined();
        expect(fairBoxes(size, g.boxes)).toBe(true);
        for (const id of g.order) expect(gap(g.boxes, g.pos.get(id)!)).toBeGreaterThanOrEqual(SPIKES_RADIUS);
        expect(g.reaches).toEqual(reachesOf(size, g.boxes));
        expect(g.nextShiftAt).toBe(clock.now() + SPIKES_SHIFT_MS);
      }
    }
  }, 60_000);

  it('a shift blocked again and again is called off until the next one', () => {
    const { g, clock } = started(8);
    g.nextWarnAt = Infinity;
    clock.set(g.nextShiftAt);
    g.shiftWarn();
    const before = g.boxes.map((c) => [...c]);
    let last: unknown[] = [];
    for (let k = 0; k < SPIKES_SHIFT_TRIES; k++) {
      const [c, r] = g.boxesNext![0];
      g.pos.set('A', [c + 0.5, r + 0.5]);
      clock.set(g.boxesAt);
      last = g.shiftLand();
    }
    expect(last).toEqual([{ kind: 'spikes', ev: { type: 'shift', phase: 'cancel' } }]);
    expect(g.boxesNext).toBeNull();
    expect(g.boxes).toEqual(before);
    expect(g.nextShiftAt).toBe(clock.now() + SPIKES_SHIFT_MS);
  });

  it('walls are often aimed at players standing still, never certainly', () => {
    // A stands where only the left wall reaches on a hand-made layout; B in an open corner
    const aimed = (roll: number) => {
      const { g } = started(5, ['A', 'B'], 9, () => roll);
      g.boxes.splice(0, g.boxes.length, [2, 0], [2, 2], [2, 4]);
      Object.assign(g.reaches, reachesOf(5, g.boxes));
      g.pos.set('A', [1.5, 0.5]).set('B', [4.5, 4.5]);
      const dirs = new Set<string>();
      for (let k = 0; k < 30; k++) {
        (g as unknown as { lastDirs: string[] }).lastDirs = [];
        g.warnings = [];
        g.warn();
        dirs.add(g.warnings[0].dir);
      }
      return dirs;
    };
    // a low roll: only the sides that hit both A and B (left hits A at x 1.5 behind nothing, and B's row)
    const low = aimed(0.3);
    const { g } = started(5, ['A', 'B'], 9);
    g.boxes.splice(0, g.boxes.length, [2, 0], [2, 2], [2, 4]);
    Object.assign(g.reaches, reachesOf(5, g.boxes));
    const both = SPIKE_DIRS.filter((d) => g.hits(d, [1.5, 0.5]) && g.hits(d, [4.5, 4.5]));
    expect(both.length).toBeGreaterThan(0);
    expect([...low].every((d) => both.includes(d))).toBe(true);
    // a high roll: any side
    expect(aimed(0.9).size).toBeGreaterThan(both.length);
  });
});
