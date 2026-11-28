import type { RandomInt } from '../../cards.js';
import { SPIKES_RADIUS, spikeReach, type SpikeDir } from '../../types.js';

export type Point = [number, number];
export type Cell = [number, number];
export type Reaches = Record<SpikeDir, number[]>;

export const SPIKE_DIRS: readonly SpikeDir[] = ['left', 'right', 'top', 'bottom'];
/** a wall hits a body overlapping its reach by this share of the radius (a little forgiving) */
export const SPIKES_HIT_SHARE = 0.85;
/** a move is walked in steps no longer than this (arena units), so nobody skips through a box */
export const SPIKES_SUBSTEP = 0.2;

const isRows = (dir: SpikeDir) => dir === 'left' || dir === 'right';
const clampTo = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** a body centred at v overlaps lane `line` (the lane spans line..line+1) */
export const inBand = (v: number, line: number): boolean => Math.abs(v - (line + 0.5)) < 0.5 + SPIKES_RADIUS * SPIKES_HIT_SHARE;

/** every side's reach per line for these boxes */
export const reachesOf = (size: number, boxes: readonly Cell[]): Reaches => ({
  left: spikeReach(size, boxes, 'left'),
  right: spikeReach(size, boxes, 'right'),
  top: spikeReach(size, boxes, 'top'),
  bottom: spikeReach(size, boxes, 'bottom'),
});

/** a wall from `dir` hits a body at p: it overlaps a line and its near edge is inside that line's reach */
export function hitBy(size: number, reach: readonly number[], dir: SpikeDir, [x, y]: Point): boolean {
  const r = SPIKES_RADIUS * SPIKES_HIT_SHARE;
  const across = isRows(dir) ? y : x;
  const along = isRows(dir) ? x : y;
  // how deep the body's near edge sits, measured from the wall's side
  const near = dir === 'left' || dir === 'top' ? along - r : size - along - r;
  for (let line = 0; line < size; line++) if (inBand(across, line) && near < reach[line]) return true;
  return false;
}

/** a cell's centre is safe from a wall from `dir` (it sits behind a box) */
export const cellSafe = (size: number, reaches: Reaches, dir: SpikeDir, [c, r]: Cell): boolean => !hitBy(size, reaches[dir], dir, [c + 0.5, r + 0.5]);

/** pushes a body out of the arena edges and any box it overlaps (circle vs square), twice for corners between boxes */
export function pushOut(size: number, boxes: readonly Cell[], [px, py]: Point): Point {
  const R = SPIKES_RADIUS;
  let x = px;
  let y = py;
  for (let pass = 0; pass < 2; pass++) {
    x = clampTo(x, R, size - R);
    y = clampTo(y, R, size - R);
    for (const [c, r] of boxes) {
      const qx = clampTo(x, c, c + 1);
      const qy = clampTo(y, r, r + 1);
      const dx = x - qx;
      const dy = y - qy;
      const d = Math.hypot(dx, dy);
      if (d >= R) continue;
      if (d > 1e-9) {
        // out along the line from the box's nearest point
        x = qx + (dx / d) * R;
        y = qy + (dy / d) * R;
        continue;
      }
      // centre inside the box: out through the nearest face
      const faces: [number, number, number][] = [[x - c, c - R, y], [c + 1 - x, c + 1 + R, y], [y - r, x, r - R], [r + 1 - y, x, r + 1 + R]];
      const best = faces.reduce((a, b) => (b[0] < a[0] ? b : a));
      x = best[1];
      y = best[2];
    }
  }
  return [clampTo(x, R, size - R), clampTo(y, R, size - R)];
}

/** walks from `from` towards `to` in short steps, pushed out of boxes after each, so a body slides along their edges */
export function slide(size: number, boxes: readonly Cell[], from: Point, to: Point): Point {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const n = Math.max(1, Math.ceil(Math.hypot(dx, dy) / SPIKES_SUBSTEP));
  let p: Point = [from[0], from[1]];
  for (let k = 0; k < n; k++) p = pushOut(size, boxes, [p[0] + dx / n, p[1] + dy / n]);
  return p;
}

const key = ([c, r]: Cell) => `${c},${r}`;

/** free cells reachable from `start` (4-neighbour), each with its step count and the cell it came from */
export function walk(size: number, boxes: readonly Cell[], start: Cell): Map<string, { cell: Cell; steps: number; prev: string | null }> {
  const blocked = new Set(boxes.map(key));
  const seen = new Map<string, { cell: Cell; steps: number; prev: string | null }>([[key(start), { cell: start, steps: 0, prev: null }]]);
  const queue: Cell[] = [start];
  for (let i = 0; i < queue.length; i++) {
    const [c, r] = queue[i];
    const here = seen.get(key([c, r]))!;
    for (const n of [[c + 1, r], [c - 1, r], [c, r + 1], [c, r - 1]] as Cell[]) {
      if (n[0] < 0 || n[1] < 0 || n[0] >= size || n[1] >= size || blocked.has(key(n)) || seen.has(key(n))) continue;
      seen.set(key(n), { cell: n, steps: here.steps + 1, prev: key([c, r]) });
      queue.push(n);
    }
  }
  return seen;
}

/** the cells from start to `to` (start left out), following walk()'s steps */
export function pathTo(found: ReturnType<typeof walk>, to: Cell): Cell[] {
  const out: Cell[] = [];
  for (let k: string | null = key(to); k; k = found.get(k)!.prev) out.unshift(found.get(k)!.cell);
  return out.slice(1);
}

/** cells that may hold a box: not a start corner and not touching one */
export function boxSpots(size: number): Cell[] {
  const out: Cell[] = [];
  const nearCorner = (v: number) => v <= 1 || v >= size - 2;
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (!(nearCorner(c) && nearCorner(r))) out.push([c, r]);
  return out;
}

/** a fair layout: no two boxes side by side, every free cell reachable, every side shields at least one free cell */
export function fairBoxes(size: number, boxes: readonly Cell[]): boolean {
  const has = new Set(boxes.map(key));
  if (boxes.some(([c, r]) => has.has(key([c + 1, r])) || has.has(key([c, r + 1])))) return false;
  if (walk(size, boxes, [0, 0]).size !== size * size - boxes.length) return false;
  const reaches = reachesOf(size, boxes);
  const free = freeCells(size, boxes);
  return SPIKE_DIRS.every((dir) => free.some((cell) => cellSafe(size, reaches, dir, cell)));
}

export const freeCells = (size: number, boxes: readonly Cell[]): Cell[] => {
  const has = new Set(boxes.map(key));
  const out: Cell[] = [];
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (!has.has(key([c, r]))) out.push([c, r]);
  return out;
};

/** boxes for one game: 4 on size 5, 6 on size 6, drawn with the game's random until fair */
export function makeBoxes(size: number, rand: RandomInt): Cell[] {
  const count = size >= 6 ? 6 : 4;
  const spots = boxSpots(size);
  for (let tries = 0; tries < 500; tries++) {
    const pool = [...spots];
    for (let i = pool.length - 1; i > 0; i--) {
      const j = rand(i + 1);
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    const pick = pool.slice(0, count).sort((a, b) => a[1] - b[1] || a[0] - b[0]);
    if (fairBoxes(size, pick)) return pick;
  }
  // never needed in practice: a known fair layout
  const m = Math.floor(size / 2);
  return size >= 6 ? [[2, 0], [m, 2], [0, 3], [5, 2], [2, 4], [3, 5]] : [[m, 0], [0, m], [size - 1, m], [m, size - 1]];
}

/** pairs of sides that may fire together: some free cell is safe from both */
export function safePairs(size: number, boxes: readonly Cell[]): [SpikeDir, SpikeDir][] {
  const reaches = reachesOf(size, boxes);
  const free = freeCells(size, boxes);
  const out: [SpikeDir, SpikeDir][] = [];
  for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) {
    const [a, b] = [SPIKE_DIRS[i], SPIKE_DIRS[j]];
    if (free.some((cell) => cellSafe(size, reaches, a, cell) && cellSafe(size, reaches, b, cell))) out.push([a, b]);
  }
  return out;
}
