import { SPIKES_RADIUS, SPIKES_SPEED, type BotLevel } from '../../types.js';
import { cellSafe, freeCells, pathTo, pushOut, SPIKE_DIRS, walk, type Cell, type Point } from './arena.js';
import type { SpikesGame } from './game.js';

export type SpikesBotLevel = BotLevel;

/** a bot's running speed, as a share of SPIKES_SPEED */
const PACE: Record<BotLevel, number> = { normal: 0.85, hard: 0.95, expert: 1 };
/** chance a bot with nothing warned wanders somewhere else each time it looks around */
const WANDER: Record<BotLevel, number> = { normal: 0.07, hard: 0.06, expert: 0.05 };
/** chance a bot misreads a wall: runs to a random square instead of a shielded one */
const BLUNDER: Record<BotLevel, number> = { normal: 0.2, hard: 0.08, expert: 0.03 };

/** a bot's speed in arena units per second */
export const botSpeedOf = (level: BotLevel): number => SPIKES_SPEED * PACE[level];

/** ms until a bot looks around again, by level */
export function botThinkMs(level: BotLevel, rand: () => number): number {
  if (level === 'expert') return 110 + rand() * 110;
  if (level === 'hard') return 170 + rand() * 170;
  return 250 + rand() * 230;
}

const centre = ([c, r]: Cell): Point => [c + 0.5, r + 0.5];

/** how far a point is from square [c, r] */
const gapTo = ([c, r]: Cell, [x, y]: Point): number => Math.hypot(x - Math.min(c + 1, Math.max(c, x)), y - Math.min(r + 1, Math.max(r, y)));

/** the cell a body's centre is in */
const cellOf = (g: SpikesGame, [x, y]: Point): Cell => [Math.min(g.size - 1, Math.max(0, Math.floor(x))), Math.min(g.size - 1, Math.max(0, Math.floor(y)))];

/** a body can run straight from a to b without touching a box */
function clear(g: SpikesGame, a: Point, b: Point): boolean {
  for (let k = 1; k <= 8; k++) {
    const p: Point = [a[0] + ((b[0] - a[0]) * k) / 8, a[1] + ((b[1] - a[1]) * k) / 8];
    const q = pushOut(g.size, g.boxes, p);
    if (Math.abs(q[0] - p[0]) > 1e-9 || Math.abs(q[1] - p[1]) > 1e-9) return false;
  }
  return true;
}

/** how many sides a cell hides from */
const shelter = (g: SpikesGame, cell: Cell): number => SPIKE_DIRS.filter((d) => cellSafe(g.size, g.reaches, d, cell)).length;

/**
 * a bot's new plan: when it has noticed walls, a path round the boxes to the nearest square shielded from all of them (planned
 * once per set of walls); otherwise now and then a wander. null keeps its run
 */
export function botThink(g: SpikesGame, id: string, now: number, rand: () => number): { path: Point[]; plan: string } | null {
  const me = g.pos.get(id)!;
  const run = g.botRun.get(id);
  // only walls this bot has noticed by now
  const seen = g.warnings.filter((w) => (w.notice.get(id) ?? Infinity) <= now);
  const plan = seen.map((w) => w.id).join(',');
  if (seen.length > 0 && run?.plan === plan) return null;
  // while crates are about to shift, their target squares count as taken
  const ghosts = g.boxesNext ?? [];
  const blocks = ghosts.length > 0 ? [...g.boxes, ...ghosts] : g.boxes;
  const found = walk(g.size, blocks, cellOf(g, me));
  const route = (to: Cell): Point[] => {
    const cells = pathTo(found, to);
    const path = cells.length > 0 ? cells.map(centre) : [centre(to)];
    // a straight line to the first centre would rub a box: go by this square's centre first
    return clear(g, me, path[0]) ? path : [centre(cellOf(g, me)), ...path];
  };
  if (seen.length > 0) {
    // already out of reach where it stands: stay
    if (!seen.some((w) => g.hits(w.dir, me))) return { path: [], plan };
    const reachable = [...found.values()];
    if (rand() < BLUNDER[g.level]) return { path: route(reachable[Math.floor(rand() * reachable.length)].cell), plan };
    const safe = reachable.filter((f) => seen.every((w) => cellSafe(g.size, g.reaches, w.dir, f.cell)));
    if (safe.length === 0) return { path: [], plan };
    // nearest first; better bots break ties towards squares that hide from more sides
    const score = (f: (typeof safe)[number]) => f.steps * 10 - (g.level === 'normal' ? 0 : shelter(g, f.cell));
    return { path: route(safe.reduce((a, b) => (score(b) < score(a) ? b : a)).cell), plan };
  }
  // standing on (or touching) a square a crate is about to land on: step off to the nearest clear one
  if (ghosts.some((c) => gapTo(c, me) < SPIKES_RADIUS + 0.1)) {
    const off = [...found.values()].filter((f) => f.steps > 0 && !ghosts.some((c) => gapTo(c, centre(f.cell)) < SPIKES_RADIUS + 0.1));
    if (off.length > 0) return { path: route(off.reduce((a, b) => (b.steps < a.steps ? b : a)).cell), plan: 'shift' };
  }
  // walls gone: forget the plan, keep any run
  if (run && run.plan !== '') return { path: run.path, plan: '' };
  if (run && run.path.length > 0) return null;
  if (rand() >= WANDER[g.level]) return null;
  const near = freeCells(g.size, blocks).filter((c) => (found.get(`${c[0]},${c[1]}`)?.steps ?? 99) <= 3);
  if (near.length === 0) return null;
  // better bots drift to well-sheltered squares, normal ones anywhere close
  if (g.level !== 'normal' && rand() < 0.6) return { path: route(near.reduce((a, b) => (shelter(g, b) > shelter(g, a) ? b : a))), plan: '' };
  return { path: route(near[Math.floor(rand() * near.length)]), plan: '' };
}
