import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  aimOf, CARROM, CarromSim, dirToBoard, dirToLocal, firstContact, launchOf, nearestFit, PHYS, POCKETS, simulate, startCoins, strikerFits, strikerSpot, toBoard, toLocal,
  type CarromCoin, type CarromSide,
} from '../src/carrom/index.js';
import { goldenShots } from './carrom-golden-shots.js';

const rng = (seed: number) => () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

describe('carrom board', () => {
  it('the flower: 9 white, 9 black, the queen in the middle, nothing touching', () => {
    const c = startCoins();
    expect(c.filter((k) => k.c === 'w')).toHaveLength(9);
    expect(c.filter((k) => k.c === 'b')).toHaveLength(9);
    expect(c.find((k) => k.id === 'Q')).toMatchObject({ x: 0.5, y: 0.5 });
    for (const a of c) for (const b of c) if (a !== b) expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(2 * CARROM.coinR);
  });

  it('sides: toBoard and toLocal undo each other; each side shoots into the board', () => {
    for (const side of [0, 1, 2, 3] as CarromSide[]) {
      const [x, y] = toBoard(side, 0.3, 0.2);
      const [u, f] = toLocal(side, x, y);
      expect(u).toBeCloseTo(0.3, 12);
      expect(f).toBeCloseTo(0.2, 12);
      const [dx, dy] = dirToBoard(side, 0, 1);
      // forward from my baseline heads for the middle
      const [sx, sy] = strikerSpot(side, 0.5);
      expect((0.5 - sx) * dx + (0.5 - sy) * dy).toBeGreaterThan(0);
      expect(dirToLocal(side, dx, dy)).toEqual([0, 1]);
    }
  });

  it('the striker may not sit on a coin; nearestFit finds the closest free spot', () => {
    const coin: CarromCoin = { id: 'W1', c: 'w', x: strikerSpot(0, 0.5)[0], y: strikerSpot(0, 0.5)[1] };
    expect(strikerFits([coin], 0, 0.5)).toBe(false);
    expect(strikerFits([coin], 2, 0.5)).toBe(true);
    const x = nearestFit([coin], 0, 0.5)!;
    expect(strikerFits([coin], 0, x)).toBe(true);
    expect(Math.abs(x - 0.5)).toBeLessThan(0.15);
  });

  it('no backward shots: the direction is turned into the board', () => {
    const [du, df] = aimOf(0.3, -1);
    expect(df).toBeCloseTo(PHYS.minForward, 12);
    expect(du).toBeGreaterThan(0);
    expect(aimOf(0, 0)).toEqual([0, 1]);
    const l = launchOf(0, 0.5, 0, -1, 1);
    expect(l.vy).toBeLessThan(0);
  });
});

describe('carrom physics', () => {
  it('is deterministic: 1000 random shots give bit-identical results twice', () => {
    const r = rng(42);
    const shots = Array.from({ length: 1000 }, () => [Math.floor(r() * 4) as CarromSide, r(), r() - 0.5, 0.2 + r(), r()] as const);
    const coins = startCoins();
    const run = () => shots.map(([s, x, dx, dy, p]) => JSON.stringify(simulate(coins, launchOf(s, x, dx, dy, p))));
    expect(run()).toEqual(run());
  }, 60_000);

  it('matches the golden file', () => {
    const golden = JSON.parse(readFileSync(new URL('./fixtures/carrom-golden.json', import.meta.url), 'utf8'));
    expect(JSON.parse(JSON.stringify(goldenShots()))).toEqual(golden);
  });

  it('stepping it frame by frame ends exactly where a full run does', () => {
    const l = launchOf(1, 0.4, 0.1, 1, 0.9);
    const sim = new CarromSim(startCoins(), l);
    for (let ms = 16; !sim.done; ms += 16) sim.advance(ms);
    expect(sim.result()).toEqual(simulate(startCoins(), l));
  });

  it('a head-on hit passes the speed on, with the heavier striker following through', () => {
    const coin: CarromCoin = { id: 'W1', c: 'w', x: 0.5, y: 0.5 };
    const sim = new CarromSim([coin], { x: 0.5, y: 0.7, vx: 0, vy: -1 });
    while (sim.firstHit === null) sim.step();
    expect(sim.vy[1]).toBeLessThan(0);
    // the coin is faster than the striker after the hit, both going the same way
    expect(Math.abs(sim.vy[1])).toBeGreaterThan(Math.abs(sim.vy[0]));
    expect(sim.vy[0]).toBeLessThanOrEqual(0);
  });

  it('walls bounce with less speed', () => {
    const sim = new CarromSim([], { x: 0.5, y: 0.5, vx: 2, vy: 0 });
    let before = 0;
    while (sim.vx[0] > 0) {
      before = sim.vx[0];
      sim.step();
    }
    expect(-sim.vx[0] / before).toBeCloseTo(PHYS.wallE, 1);
    expect(sim.events.some((e) => e.kind === 'wall')).toBe(true);
  });

  it('a coin sent at a pocket drops, with a pocket event', () => {
    const [px, py] = POCKETS[0];
    const coin: CarromCoin = { id: 'B1', c: 'b', x: 0.3, y: 0.3 };
    const d = Math.SQRT1_2;
    const r = simulate([coin], { x: 0.3 + 0.1 * d, y: 0.3 + 0.1 * d, vx: -2 * d, vy: -2 * d });
    expect(r.pocketed).toEqual(['B1']);
    expect(r.firstHit).toBe('B1');
    expect(r.events.find((e) => e.kind === 'pocket')).toMatchObject({ id: 'B1', pocket: 0 });
    expect(px).toBeLessThan(0.1);
    expect(py).toBeLessThan(0.1);
  });

  it('the striker can drop too, and a shot that touches nothing has no first hit', () => {
    const d = Math.SQRT1_2;
    const r = simulate([], { x: 0.3, y: 0.3, vx: -2 * d, vy: -2 * d });
    expect(r.striker.pocketed).toBe(true);
    expect(r.firstHit).toBeNull();
    expect(r.pocketed).toEqual([]);
  });

  it('everything stops: friction brings it to rest well before the cap', () => {
    const r = simulate(startCoins(), launchOf(0, 0.5, 0, 1, 1));
    expect(r.ms).toBeLessThan(PHYS.maxMs);
    expect(r.events.some((e) => e.kind === 'hit')).toBe(true);
  });

  it('the aim line stops at the first coin it would touch', () => {
    const coins = startCoins();
    const [sx, sy] = strikerSpot(0, 0.5);
    const c = firstContact(coins, sx, sy, 0, -1);
    expect(c.coin).not.toBeNull();
    expect(c.at[1]).toBeLessThan(sy);
    const w = firstContact([], sx, sy, 0, -1);
    expect(w.coin).toBeNull();
    expect(w.at[1]).toBeCloseTo(CARROM.strikerR, 9);
    expect(w.after).toEqual([0, 1]);
  });
});
