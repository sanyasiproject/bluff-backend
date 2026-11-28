import { describe, expect, it } from 'vitest';
import { boxSpots, cellSafe, fairBoxes, freeCells, hitBy, makeBoxes, pushOut, reachesOf, safePairs, slide, walk, type Cell, type Point } from '../src/games/spikes/arena.js';
import { SPIKES_COUNTDOWN_MS, SPIKES_FIRST_WARN_MS, SPIKES_MAX_MS, SPIKES_PACE, SPIKES_SAFE_MS, SPIKES_SLACK, SpikesGame, type LiveWarning } from '../src/games/spikes/game.js';
import { parseSpikesMove, SPIKES_PUSH_MS, spikesModule } from '../src/games/spikes/module.js';
import type { GameEvent } from '../src/models.js';
import { SPIKES_LIVES, SPIKES_RADIUS, SPIKES_SPEED, spikeReach, type BotLevel, type SpikeDir } from '../src/types.js';
import { parseConfig } from '../src/validate.js';

const config = (size = 5, speed = 'normal', botLevel: BotLevel = 'hard') => ({ ...parseConfig({ decks: 1, bluffRule: 'one', game: 'spikes', opts: { size, speed } }), botLevel });

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
const randInt = (seed: number) => {
  const r = rng(seed);
  return (n: number) => Math.floor(r() * n);
};

/** swaps a game's boxes for a hand-made layout */
function setBoxes(g: SpikesGame, boxes: Cell[]) {
  g.boxes.splice(0, g.boxes.length, ...boxes);
  Object.assign(g.reaches, reachesOf(g.size, boxes));
  g.pairs.splice(0, g.pairs.length, ...safePairs(g.size, boxes));
}

/** the 5 × 5 test layout: one box on each side of the middle */
const CROSS: Cell[] = [[2, 0], [0, 2], [4, 2], [2, 4]];

/** a game on a clock the test moves; rand picks sides, `boxes` (default CROSS on 5 × 5) replaces the drawn layout */
function game(ids = ['A', 'B'], opts: { size?: number; speed?: string; bots?: string[]; level?: BotLevel; rand?: (n: number) => number; jitter?: () => number; boxes?: Cell[] | null } = {}) {
  let t = 1_000_000;
  const clock = { now: () => t, set: (ms: number) => (t = ms), add: (ms: number) => (t += ms) };
  const g = new SpikesGame(ids, config(opts.size, opts.speed, opts.level), opts.rand ?? randInt(7), opts.bots ?? [], clock.now, opts.jitter ?? (() => 0.5));
  if (opts.boxes !== null) setBoxes(g, opts.boxes ?? (g.size === 5 ? CROSS : g.boxes));
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

/** a wall placed by hand, striking after `ms` */
function warnOn(g: SpikesGame, now: number, dir: SpikeDir, ms = 1000): LiveWarning {
  const w: LiveWarning = { id: 900 + g.warnings.length, dir, warnAt: now, strikeAt: now + ms, inDanger: new Set(), notice: new Map() };
  for (const id of g.order) if (g.alive(id) && g.hits(dir, g.pos.get(id)!)) w.inDanger.add(id);
  g.warnings.push(w);
  return w;
}

const kinds = (events: GameEvent[]) => events.map((e) => (e.kind === 'spikes' ? `spikes:${e.ev.type}` : e.kind));
const gapToBox = (boxes: Cell[], [x, y]: Point) => Math.min(...boxes.map(([c, r]) => Math.hypot(x - Math.min(c + 1, Math.max(c, x)), y - Math.min(r + 1, Math.max(r, y)))));

describe('Spike Attack arena: reach, hits, boxes', () => {
  it('a wall reaches each line up to its first box (spikeReach)', () => {
    const boxes: Cell[] = [[2, 1], [3, 1], [1, 3]];
    expect(spikeReach(5, boxes, 'left')).toEqual([5, 2, 5, 1, 5]);
    expect(spikeReach(5, boxes, 'right')).toEqual([5, 1, 5, 3, 5]);
    expect(spikeReach(5, boxes, 'top')).toEqual([5, 3, 1, 1, 5]);
    expect(spikeReach(5, boxes, 'bottom')).toEqual([5, 1, 3, 3, 5]);
  });

  it('hit: any part of the body (85 % of the radius) in the reach of a line it overlaps; behind a box is safe', () => {
    const reaches = reachesOf(5, [[2, 1]]);
    const left = (p: Point) => hitBy(5, reaches.left, 'left', p);
    // row 1 reaches x = 2: in front of the box hit, behind it safe, pressed against the box's far side safe
    expect(left([1.5, 1.5])).toBe(true);
    expect(left([3.5, 1.5])).toBe(false);
    expect(left([3 + SPIKES_RADIUS, 1.5])).toBe(false);
    // behind the box but leaning into row 0 (beyond the forgiving edge) is hit by row 0's spikes
    const edge = 0.5 + SPIKES_RADIUS * 0.85;
    expect(left([3.5, 0.5 + edge - 0.001])).toBe(true);
    expect(left([3.5, 0.5 + edge + 0.001])).toBe(false);
    // the right wall comes the other way: in front of the box from the right is hit
    expect(hitBy(5, reaches.right, 'right', [3.5, 1.5])).toBe(true);
    expect(hitBy(5, reaches.right, 'right', [1.5, 1.5])).toBe(false);
    // top: column 2 stops at row 1
    expect(hitBy(5, reaches.top, 'top', [2.5, 0.5])).toBe(true);
    expect(hitBy(5, reaches.top, 'top', [2.5, 3.5])).toBe(false);
    // a line with no box is hit all the way across, even touching the far wall
    expect(left([5 - SPIKES_RADIUS, 3.5])).toBe(true);
    expect(cellSafe(5, reaches, 'left', [4, 1])).toBe(true);
    expect(cellSafe(5, reaches, 'left', [1, 1])).toBe(false);
  });

  it('boxes are solid: a body is pushed out, a move into one stops at its face and slides along it', () => {
    const boxes: Cell[] = [[2, 2]];
    // straight in: stops at the face
    const p = slide(5, boxes, [1.5, 2.5], [3.5, 2.5]);
    expect(p[0]).toBeCloseTo(2 - SPIKES_RADIUS, 9);
    expect(p[1]).toBeCloseTo(2.5, 9);
    // at a slant: slides up the face and round the corner
    const q = slide(5, boxes, [1.5, 2.6], [2.6, 1.4]);
    expect(q[1]).toBeLessThan(2);
    expect(q[0]).toBeGreaterThan(2 - SPIKES_RADIUS);
    expect(gapToBox(boxes, q)).toBeGreaterThanOrEqual(SPIKES_RADIUS - 1e-9);
    // a centre inside a box goes out through the nearest face
    expect(pushOut(5, boxes, [2.1, 2.5])).toEqual([2 - SPIKES_RADIUS, 2.5]);
    // never ends inside a box or outside the arena, whatever the move
    const r = rng(3);
    const many: Cell[] = [[2, 0], [1, 2], [3, 2], [2, 4]];
    for (let i = 0; i < 2000; i++) {
      const from = pushOut(5, many, [r() * 5, r() * 5]);
      const to: Point = [r() * 7 - 1, r() * 7 - 1];
      const end = slide(5, many, from, to);
      expect(gapToBox(many, end)).toBeGreaterThanOrEqual(SPIKES_RADIUS - 1e-6);
      expect(end.every((v) => v >= SPIKES_RADIUS - 1e-9 && v <= 5 - SPIKES_RADIUS + 1e-9)).toBe(true);
    }
  });

  it('layouts: 4 boxes on 5 × 5, 6 on 6 × 6, never on or touching a start corner, fair, the same for the same seed', () => {
    for (const size of [5, 6]) {
      const spots = new Set(boxSpots(size).map((c) => c.join()));
      const seen = new Set<string>();
      for (let seed = 1; seed <= 150; seed++) {
        const boxes = makeBoxes(size, randInt(seed));
        expect(boxes.length).toBe(size === 5 ? 4 : 6);
        expect(boxes.every((c) => spots.has(c.join()))).toBe(true);
        expect(fairBoxes(size, boxes)).toBe(true);
        // every free square reachable, every side shields one
        expect(walk(size, boxes, [0, 0]).size).toBe(freeCells(size, boxes).length);
        expect(makeBoxes(size, randInt(seed))).toEqual(boxes);
        seen.add(JSON.stringify(boxes));
      }
      expect(seen.size).toBeGreaterThan(5);
    }
    // corners and their neighbours are never boxes
    expect(boxSpots(5).map((c) => c.join()).sort()).toEqual(['0,2', '1,2', '2,0', '2,1', '2,2', '2,3', '2,4', '3,2', '4,2']);
    // side by side, or closing a square in, is unfair
    expect(fairBoxes(5, [[2, 1], [2, 2], [0, 2], [4, 2]])).toBe(false);
    expect(fairBoxes(5, [[2, 1], [1, 2], [3, 2], [2, 3]])).toBe(false);
    // the fallback layouts are fair
    expect(fairBoxes(5, makeBoxes(5, () => 0))).toBe(true);
    expect(fairBoxes(6, makeBoxes(6, () => 0))).toBe(true);
  });
});

describe('Spike Attack rules: moving round boxes', () => {
  it('players start at the corner squares\' centres with 3 lives and the game\'s boxes; a 3 s countdown; nobody has a turn', () => {
    const { g, clock } = game(['A', 'B', 'C', 'D']);
    expect(g.turnId).toBeNull();
    expect(g.startsAt).toBe(clock.now() + SPIKES_COUNTDOWN_MS);
    const v = g.view();
    expect(v).toMatchObject({ size: 5, phase: 'countdown', pos: { A: [0.5, 0.5], B: [4.5, 4.5], C: [4.5, 0.5], D: [0.5, 4.5] }, lives: { A: SPIKES_LIVES, B: 3, C: 3, D: 3 }, boxes: CROSS, warnings: [], strikes: [], places: {}, now: clock.now() });
    expect(game(['A', 'B'], { size: 6 }).g.view().pos).toEqual({ A: [0.5, 0.5], B: [5.5, 5.5] });
    expect(() => new SpikesGame(['A'], config())).toThrow('Spike Attack needs 2 to 4 players');
    // drawn with the game's random: the same seed, the same boxes; fixed for the whole game
    const drawn = (seed: number, size = 6) => new SpikesGame(['A', 'B'], config(size), randInt(seed)).view().boxes;
    expect(drawn(11)).toEqual(drawn(11));
    expect(drawn(11).length).toBe(6);
    expect(drawn(12, 5).length).toBe(4);
  });

  it('a move within SPIKES_SPEED is taken as sent; not before the countdown; not once out', () => {
    const { g, clock } = game();
    expect(() => g.moveTo('A', 0.6, 0.5)).toThrow('Wait for the countdown');
    clock.set(g.startsAt);
    g.go();
    clock.add(100);
    expect(g.moveTo('A', 0.5 + 0.3, 0.5)).toEqual([{ kind: 'spikes', ev: { type: 'step', playerId: 'A', to: [0.8, 0.5] } }]);
    expect(g.view().pos.A).toEqual([0.8, 0.5]);
    expect(() => g.moveTo('Z', 1, 1)).toThrow("You're not playing this game");
    g.placeMap.set('B', 2);
    expect(() => g.moveTo('B', 4, 4)).toThrow("You're out");
  });

  it('too far is cut back along the line to speed × time + slack, never refused', () => {
    const { g, clock } = playing(['A', 'B'], { boxes: [] });
    clock.add(1000);
    g.moveTo('A', 0.6, 0.5);
    clock.add(250);
    const allowed = (SPIKES_SPEED * 250) / 1000 + SPIKES_SLACK;
    const [e] = g.moveTo('A', 4.6, 3.5);
    const to = ((e as Extract<GameEvent, { kind: 'spikes' }>).ev as { to: [number, number] }).to;
    expect(Math.hypot(to[0] - 0.6, to[1] - 0.5)).toBeCloseTo(allowed, 9);
    expect((to[0] - 0.6) / 4).toBeCloseTo((to[1] - 0.5) / 3, 9);
  });

  it('the slack never adds up: 12 moves a second at double speed still only go SPIKES_SPEED', () => {
    const { g, clock } = playing(['A', 'B'], { boxes: [] });
    let x = 0.5;
    for (let i = 0; i < 12; i++) {
      clock.add(83);
      x = Math.min(4.6, x + (2 * SPIKES_SPEED * 83) / 1000);
      g.moveTo('A', x, 0.5);
    }
    const ran = g.pos.get('A')![0] - 0.5;
    expect(ran).toBeLessThanOrEqual((SPIKES_SPEED * 12 * 83) / 1000 + SPIKES_SLACK + 1e-9);
    expect(ran).toBeGreaterThan((SPIKES_SPEED * 12 * 83) / 1000 - 0.01);
  });

  it('positions stay inside the arena, by the body radius', () => {
    const { g, clock } = playing();
    clock.add(5000);
    g.moveTo('A', -3, -3);
    expect(g.pos.get('A')).toEqual([SPIKES_RADIUS, SPIKES_RADIUS]);
    clock.add(5000);
    g.moveTo('A', 99, 0.5);
    // row 0 has a box at column 2: stopped at its face
    expect(g.pos.get('A')![0]).toBeCloseTo(2 - SPIKES_RADIUS, 9);
  });

  it('a move into a box stops at its face and slides along it; the blocked length still counts against speed', () => {
    const { g, clock } = playing(['A', 'B'], { boxes: [[2, 1]] });
    g.pos.set('A', [1.5, 1.5]);
    clock.add(1000);
    // straight at the box: stopped at x = 2 - radius
    g.moveTo('A', 2.5, 1.5);
    expect(g.pos.get('A')).toEqual([2 - SPIKES_RADIUS, 1.5]);
    // up and right along the face: slides up past the box's top, never into it
    clock.add(1000);
    g.moveTo('A', 2.6, 0.5);
    const p = g.pos.get('A')!;
    expect(p[1]).toBeLessThan(1);
    expect(gapToBox([[2, 1]], p)).toBeGreaterThanOrEqual(SPIKES_RADIUS - 1e-9);
    // pushing into the box for a while used up the time: a far move straight after is cut short
    g.pos.set('A', [1.5, 3.5]);
    clock.add(100);
    g.moveTo('A', 1.5, 3.5);
    clock.add(100);
    g.moveTo('A', 1.5, 0.5);
    expect(3.5 - g.pos.get('A')![1]).toBeLessThanOrEqual((SPIKES_SPEED * 100) / 1000 + SPIKES_SLACK + 1e-9);
  });
});

describe('Spike Attack rules: walls', () => {
  it('one side at a time at first: warned 3 s ahead (fast 2 s), the next wall only after the strike and a 1.5-3 s gap', () => {
    const { g, clock } = game();
    clock.set(g.startsAt);
    g.go();
    expect(g.nextStep()!.at).toBe(g.startsAt + SPIKES_FIRST_WARN_MS);
    clock.set(g.nextWarnAt);
    const events = g.warn();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'spikes', ev: { type: 'warn', id: 1 } });
    expect(Object.keys((events[0] as Extract<GameEvent, { kind: 'spikes' }>).ev).sort()).toEqual(['dir', 'id', 'type']);
    const w = g.view().warnings[0];
    expect(Object.keys(w).sort()).toEqual(['dir', 'id', 'strikeAt', 'warnAt']);
    // 0.8 s into a 90 s ramp: still about 3 s
    expect(w.strikeAt - w.warnAt).toBeGreaterThan(2980);
    // nothing new while a wall is warned
    expect(g.nextWarnAt).toBe(Infinity);
    expect(g.warn()).toEqual([]);
    expect(g.nextStep()!.at).toBe(w.strikeAt);
    clock.set(w.strikeAt);
    g.nextStep()!.run();
    // jitter 0.5: halfway through the gap, about 2.25 s this early
    const [lo, hi] = g.pace(w.strikeAt).gap;
    expect(g.nextWarnAt).toBe(w.strikeAt + Math.round((lo + hi) / 2));
    expect(g.nextWarnAt - w.strikeAt).toBeGreaterThan(2150);
    expect(g.pace(g.startsAt)).toEqual({ warn: 3000, gap: [1500, 3000], two: 0 });
    expect(g.pace(g.startsAt + 90_000)).toEqual({ warn: 1500, gap: [700, 1500], two: SPIKES_PACE.normal.two });
    const fast = game(['A', 'B'], { speed: 'fast' }).g;
    expect(fast.pace(fast.startsAt).warn).toBe(2000);
    expect(fast.pace(Infinity).warn).toBe(1300);
  });

  it('never the same side twice in a row; later sometimes two sides at once, only where a square is safe from both', () => {
    const { g, clock } = playing(['A', 'B'], { jitter: () => 0.9 });
    let last = '';
    for (let i = 0; i < 40; i++) {
      clock.add(100);
      const [e] = g.warn();
      const dir = (e as Extract<GameEvent, { kind: 'spikes' }>).ev as { dir: SpikeDir };
      expect(dir.dir).not.toBe(last);
      last = dir.dir;
      clock.set(g.warnings[0].strikeAt);
      g.strike();
      g.lives.set('A', 3).set('B', 3);
    }
    // late in the game with a low roll: two sides with the same strike time
    const two = playing(['A', 'B'], { jitter: () => 0.1 });
    two.clock.set(two.g.startsAt + 100_000);
    expect(two.g.warn()).toHaveLength(2);
    const [a, b] = two.g.warnings;
    expect(a.strikeAt).toBe(b.strikeAt);
    expect(two.g.pairs.some((p) => p[0] === a.dir && p[1] === b.dir)).toBe(true);
    const free = freeCells(5, CROSS);
    expect(free.some((c) => cellSafe(5, two.g.reaches, a.dir, c) && cellSafe(5, two.g.reaches, b.dir, c))).toBe(true);
    // a layout where no square hides from two sides: always one side
    const one = playing(['A', 'B'], { jitter: () => 0, boxes: [[2, 1]] });
    expect(one.g.pairs).toEqual([]);
    one.clock.set(one.g.startsAt + 100_000);
    expect(one.g.warn()).toHaveLength(1);
  });

  it('the strike hits everyone in its reach, not those behind a box; 1 s of safety after a hit', () => {
    const { g, clock } = playing(['A', 'B', 'C']);
    // left wall on CROSS: row 0 reaches x 2, row 2 reaches 0, the others go right across
    g.pos.set('B', [3.5, 0.5]);
    g.pos.set('C', [3.5, 2.5]);
    const w = warnOn(g, clock.now(), 'left', 1500);
    expect(g.nextStep()!.at).toBe(w.strikeAt);
    clock.set(w.strikeAt);
    expect(g.strike()).toEqual([{ kind: 'spikes', ev: { type: 'strike', id: w.id, dir: 'left', hit: ['A'] } }]);
    expect(g.view().strikes).toEqual([{ id: w.id, dir: 'left', at: clock.now(), hit: ['A'] }]);
    expect(g.view().lives).toEqual({ A: 2, B: 3, C: 3 });
    expect(g.view().safeUntil.A).toBe(clock.now() + SPIKES_SAFE_MS);
    const w2 = warnOn(g, clock.now(), 'top', SPIKES_SAFE_MS - 1);
    clock.set(w2.strikeAt);
    // top: column 3 goes all the way, so B and C are hit; A is still safe
    expect(g.strike()[0]).toMatchObject({ ev: { hit: ['B', 'C'] } });
    clock.add(SPIKES_SAFE_MS);
    const w3 = warnOn(g, clock.now(), 'top', 1);
    clock.set(w3.strikeAt);
    // everyone's safe time is over: A in column 0's reach, B and C in column 3's
    expect(g.strike()[0]).toMatchObject({ ev: { hit: ['A', 'B', 'C'] } });
    expect(spikesModule.tallies(g, 'A')).toEqual({ dodges: 0, hits: 2 });
  });

  it('running behind a box before the strike is a dodge', () => {
    const { g, clock } = playing();
    const w = warnOn(g, clock.now(), 'left', 1000);
    clock.add(300);
    g.moveTo('A', 1.5, 1.5);
    clock.add(300);
    g.moveTo('A', 1.5, 2.5);
    expect(g.hits('left', g.pos.get('A')!)).toBe(false);
    clock.set(w.strikeAt);
    // B in the far corner sits behind the bottom row's box
    expect(g.strike()[0]).toMatchObject({ ev: { hit: [] } });
    expect(spikesModule.tallies(g, 'A')).toEqual({ dodges: 1, hits: 0 });
  });

  it('two walls at once strike together; a player in both loses one life', () => {
    const { g, clock } = playing();
    const a = warnOn(g, clock.now(), 'left', 1000);
    const b = warnOn(g, clock.now(), 'top', 1000);
    clock.set(a.strikeAt);
    const events = g.strike();
    expect(events).toEqual([
      { kind: 'spikes', ev: { type: 'strike', id: a.id, dir: 'left', hit: ['A'] } },
      { kind: 'spikes', ev: { type: 'strike', id: b.id, dir: 'top', hit: [] } },
    ]);
    // A was in both, B (behind boxes from both sides) in neither
    expect(g.view().lives).toEqual({ A: 2, B: 3 });
    expect(g.warnings).toEqual([]);
    expect(g.nextWarnAt).toBeLessThan(Infinity);
  });
});

describe('Spike Attack rules: lives, places, time', () => {
  it('out at 0 lives with a place; the last one standing wins', () => {
    const { g, clock } = playing(['A', 'B', 'C']);
    g.lives.set('A', 1).set('C', 1);
    // right wall on CROSS: rows 0 and 4 reach x 3, so C [4.5, 0.5] and B [4.5, 4.5] are hit
    let w = warnOn(g, clock.now(), 'right', 1000);
    clock.set(w.strikeAt);
    expect(kinds(g.strike())).toEqual(['spikes:strike', 'spikes:out']);
    expect(g.view().places).toEqual({ C: 3 });
    expect(g.view().lives).toEqual({ A: 1, B: 2, C: 0 });
    expect(g.inPlay('C')).toBe(false);
    clock.add(SPIKES_SAFE_MS);
    // left wall: A in row 0's reach, B behind the bottom row's box
    w = warnOn(g, clock.now(), 'left', 1000);
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
    const w = warnOn(g, clock.now(), 'top', 1000);
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

  it("people's moves are live: no key change, coalesced into views every 80 ms", () => {
    const { g, clock } = playing(['A', 'X'], { bots: ['X'] });
    const k = spikesModule.turnKey(g);
    clock.add(100);
    const moved = spikesModule.move(g, 'A', { type: 'move', x: 0.7, y: 0.5 });
    expect(spikesModule.turnKey(g)).toBe(k);
    expect(moved.every((e) => spikesModule.live!.is(e))).toBe(true);
    expect(spikesModule.live!.ms).toBe(SPIKES_PUSH_MS);
    expect(SPIKES_PUSH_MS).toBeLessThanOrEqual(80);
    expect(spikesModule.live!.is({ kind: 'spikes', ev: { type: 'warn', id: 1, dir: 'left' } })).toBe(false);
    expect(spikesModule.live!.is({ kind: 'gameOver', loserId: null })).toBe(false);
    const w = warnOn(g, clock.now(), 'left', 100);
    expect(g.nextStep()!.at).toBeLessThanOrEqual(w.strikeAt);
    expect(spikesModule.auto(g)).toMatchObject({ quiet: true });
    expect(spikesModule.moveRate).toBeGreaterThanOrEqual(150);
  });

  it('parses moves and keeps announcements sparse', () => {
    expect(parseSpikesMove({ type: 'move', x: 1.25, y: 3 })).toEqual({ type: 'move', x: 1.25, y: 3 });
    for (const bad of [{ type: 'step', dir: 'up' }, { type: 'move', x: 'a', y: 1 }, { type: 'move', x: NaN, y: 1 }, { type: 'move', x: 1, y: 1e9 }, null, 'move']) expect(() => parseSpikesMove(bad)).toThrow('Invalid move');
    const { g } = game();
    const n = (id: string | null) => `P${id}`;
    expect(spikesModule.describe(g, { kind: 'spikes', ev: { type: 'step', playerId: 'A', to: [1, 0] } }, n)).toBeNull();
    expect(spikesModule.describe(g, { kind: 'spikes', ev: { type: 'strike', id: 1, dir: 'left', hit: ['A'] } }, n)).toBeNull();
    expect(spikesModule.describe(g, { kind: 'spikes', ev: { type: 'go' } }, n)).toEqual(['round', 'Dodge the spikes! 🔺']);
  });
});

/** a bots-only game through its timed steps, the clock jumping to each */
function simulate(level: BotLevel, seed: number, size = 5, speed = 'normal') {
  const r = rng(seed);
  const ids = ['A', 'B', 'C', 'D'];
  const { g, clock } = game(ids, { size, speed, bots: ids, level, rand: (n) => Math.floor(r() * n), jitter: r, boxes: null });
  let steps = 0;
  let maxSpeed = 0;
  let inBox = false;
  let walls = 0;
  for (let s = g.nextStep(); s; s = g.nextStep()) {
    clock.set(Math.max(clock.now(), s.at));
    const before = new Map([...g.botRun].map(([id, run]) => [id, { at: run.movedAt, p: [...g.pos.get(id)!] }]));
    const events = s.run();
    walls += events.filter((e) => e.kind === 'spikes' && e.ev.type === 'warn').length;
    for (const [id, b] of before) {
      const run = g.botRun.get(id);
      if (!run || run.movedAt === b.at) continue;
      const p = g.pos.get(id)!;
      maxSpeed = Math.max(maxSpeed, (Math.hypot(p[0] - b.p[0], p[1] - b.p[1]) * 1000) / (run.movedAt - b.at));
      if (gapToBox(g.boxes, p) < SPIKES_RADIUS - 1e-6) inBox = true;
    }
    if (++steps > 400_000) throw new Error('runaway');
  }
  return { g, ms: clock.now() - g.startsAt, maxSpeed, inBox, walls };
}

describe('Spike Attack bots', () => {
  it('bots finish many games round the boxes; better levels last longer and get hit less', () => {
    const out: Record<string, { ms: number; hitsPerMin: number; dodges: number }> = {};
    for (const level of ['normal', 'hard', 'expert'] as BotLevel[]) {
      let ms = 0;
      let hits = 0;
      let dodges = 0;
      const games = 60;
      for (let i = 0; i < games; i++) {
        const { g, ms: t, maxSpeed, inBox, walls } = simulate(level, 50 + i, i % 2 ? 5 : 6, i % 3 ? 'normal' : 'fast');
        expect(g.over).toBe(true);
        expect(g.winners().length).toBeGreaterThan(0);
        expect(walls).toBeGreaterThan(3);
        // a box's push-out can add a rounding hair, nothing more
        expect(maxSpeed).toBeLessThanOrEqual(SPIKES_SPEED * 1.001);
        expect(inBox).toBe(false);
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

  it('a bot in a wall\'s reach runs round the boxes to a square the wall can\'t reach, in time', () => {
    const { g, clock } = playing(['A', 'X'], { bots: ['X'], level: 'expert' });
    // right wall on CROSS: X in the far corner is in row 4's reach; row 2 behind its box is the safe spot
    const w = warnOn(g, clock.now(), 'right', 2000);
    w.notice.set('X', clock.now() + 200);
    expect(g.hits('right', g.pos.get('X')!)).toBe(true);
    const seen: Point[] = [];
    for (let s = g.nextStep(); s && s.at <= w.strikeAt; s = g.nextStep()) {
      clock.set(Math.max(clock.now(), s.at));
      s.run();
      seen.push([...g.pos.get('X')!]);
    }
    expect(g.lives.get('X')).toBe(3);
    expect(spikesModule.tallies(g, 'X').dodges).toBe(1);
    expect(g.hits('right', g.pos.get('X')!)).toBe(false);
    // moved in small steps, never through a box
    expect(seen.length).toBeGreaterThan(5);
    expect(seen.every((p) => gapToBox(CROSS, p) >= SPIKES_RADIUS - 1e-6)).toBe(true);
  });

  it('with two walls a bot picks a square safe from both', () => {
    const { g, clock } = playing(['A', 'X'], { bots: ['X'], level: 'expert' });
    const a = warnOn(g, clock.now(), 'left', 2500);
    const b = warnOn(g, clock.now(), 'top', 2500);
    a.notice.set('X', clock.now() + 200);
    b.notice.set('X', clock.now() + 200);
    for (let s = g.nextStep(); s && s.at < a.strikeAt; s = g.nextStep()) {
      clock.set(Math.max(clock.now(), s.at));
      s.run();
    }
    const p = g.pos.get('X')!;
    expect(g.hits('left', p) || g.hits('top', p)).toBe(false);
  });
});
