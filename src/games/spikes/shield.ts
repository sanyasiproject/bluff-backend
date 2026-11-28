import { SPIKES_RADIUS, spikeReach } from '../../types.js';

/** how much looser than the real hit test the layout check is (arena units), so a thin hiding spot can't slip between samples */
export const SHIELD_SLACK = 0.02;
/** the sample step; at most SHIELD_SLACK × √2 so every looser-safe patch holds a sample */
const STEP = 0.025;

/**
 * a spot where a player's circle sits clear of every box and no wall reaches it (null if none): what a camper would hunt for.
 * `hitR` is the part of the radius a wall must overlap (SPIKES_RADIUS × SPIKES_HIT_SHARE). The check is looser than the game's
 * hit test by SHIELD_SLACK in the radius and the hit band, so any real safe spot shows up as a sample here
 */
export function shieldedSpot(size: number, boxes: readonly [number, number][], hitR: number): [number, number] | null {
  const hr = hitR - SHIELD_SLACK;
  const R = SPIKES_RADIUS - SHIELD_SLACK;
  const w = 0.5 + hr;
  const L = spikeReach(size, boxes, 'left');
  const Rt = spikeReach(size, boxes, 'right');
  const T = spikeReach(size, boxes, 'top');
  const B = spikeReach(size, boxes, 'bottom');
  const vals: number[] = [];
  for (let k = Math.ceil(R / STEP); k * STEP <= size - R + 1e-9; k++) vals.push(k * STEP);
  // the lanes a centre at v overlaps
  const lanes = (v: number): number[] => {
    const out: number[] = [];
    for (let l = Math.max(0, Math.floor(v - w - 0.5)); l <= Math.min(size - 1, Math.ceil(v + w - 0.5)); l++) if (Math.abs(v - (l + 0.5)) < w) out.push(l);
    return out;
  };
  // for each sample row y: the x stretch hidden from the left and right walls; for each column x: the y stretch hidden from top and bottom
  const span = (near: number[], far: number[]) => (v: number): [number, number] => {
    const ls = lanes(v);
    return [Math.max(...ls.map((l) => near[l])) + hr, size - Math.max(...ls.map((l) => far[l])) - hr];
  };
  const xSafe = vals.map(span(L, Rt));
  const ySafe = vals.map(span(T, B));
  const clear = (x: number, y: number) =>
    boxes.every(([c, r]) => Math.hypot(x - Math.min(c + 1, Math.max(c, x)), y - Math.min(r + 1, Math.max(r, y))) >= R);
  for (let j = 0; j < vals.length; j++) {
    const [xl, xh] = xSafe[j];
    if (xl > xh) continue;
    for (let i = 0; i < vals.length; i++) {
      const x = vals[i];
      if (x < xl || x > xh) continue;
      const y = vals[j];
      const [yl, yh] = ySafe[i];
      if (y >= yl && y <= yh && clear(x, y)) return [x, y];
    }
  }
  return null;
}

/** crates per arena size: 4 on 5 × 5, 6 on 6 × 6, 10 on 8 × 8, 14 on 10 × 10 */
export function boxCount(size: number): number {
  if (size <= 5) return 4;
  if (size <= 6) return 6;
  if (size <= 8) return 10;
  return 14;
}

/** reorders `to` so to[i] is the square crate from[i] slides to: nearest pairs first */
export function pairUp(from: readonly [number, number][], to: readonly [number, number][]): [number, number][] {
  const out: ([number, number] | null)[] = from.map(() => null);
  const left = new Set(to.map((_, j) => j));
  const pairs: [number, number, number][] = [];
  from.forEach(([a, b], i) => to.forEach(([c, d], j) => pairs.push([Math.abs(a - c) + Math.abs(b - d), i, j])));
  pairs.sort((p, q) => p[0] - q[0] || p[1] - q[1] || p[2] - q[2]);
  for (const [, i, j] of pairs) {
    if (out[i] || !left.has(j)) continue;
    out[i] = [to[j][0], to[j][1]];
    left.delete(j);
  }
  // more targets than crates (never in play): the rest go on the end
  return [...(out.filter(Boolean) as [number, number][]), ...[...left].map((j) => [to[j][0], to[j][1]] as [number, number])];
}
