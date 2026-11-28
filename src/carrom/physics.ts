// Deterministic carrom physics: a fixed step, a fixed loop order, and only + - * /, Math.sqrt, Math.min, Math.max,
// so the server and every phone get the identical result from the same start and shot. Never use trig here.
import { CARROM, POCKETS, dirToBoard, strikerSpot, type CarromCoin, type CarromSide } from './board.js';

export const PHYS = {
  /** one step (seconds) and the same in ms */
  dt: 0.002,
  stepMs: 2,
  /** the simulation stops after this long even if something still crawls */
  maxMs: 12_000,
  /** striker speed (board units a second) at power 0 and 1 */
  vMin: 0.25,
  vMax: 6,
  /** coin-coin and wall restitution */
  hitE: 0.92,
  wallE: 0.8,
  /** rolling friction: a constant slowdown plus a part that grows with speed */
  friction: 0.4,
  drag: 0.1,
  /** below this speed a piece stops */
  stopV: 0.004,
  /** the shot must point at least this far into the board (unit direction's forward part) */
  minForward: 0.05,
  /** quieter hits and wall knocks than this aren't reported */
  soundV: 0.06,
  maxEvents: 400,
} as const;

/** the striker's id in events and results */
export const STRIKER = 'S';

/** what happened, for sounds: t in ms from the shot; v the impact speed; with the other piece of a hit; pocket 0..3 */
export interface CarromEvent {
  t: number;
  kind: 'pocket' | 'hit' | 'wall';
  id: string;
  with?: string;
  v?: number;
  pocket?: number;
}

/** the striker's start and velocity on the board */
export interface CarromLaunch {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

export interface CarromResult {
  /** coins still on the board, in their start order */
  coins: CarromCoin[];
  /** coin ids that dropped, in order */
  pocketed: string[];
  striker: { x: number; y: number; pocketed: boolean };
  /** the first coin the striker touched, or null */
  firstHit: string | null;
  events: CarromEvent[];
  /** how long it ran */
  ms: number;
}

/** a shot direction in a player's frame (du to their right, df into the board), normalised and turned into the board */
export function aimOf(du: number, df: number): [number, number] {
  let len = Math.sqrt(du * du + df * df);
  if (!(len > 0)) {
    du = 0;
    df = 1;
    len = 1;
  }
  du = du / len;
  df = df / len;
  // no backward shots: at least a little into the board
  if (!(df >= PHYS.minForward)) {
    df = PHYS.minForward;
    du = (du < 0 ? -1 : 1) * Math.sqrt(1 - df * df);
  }
  return [du, df];
}

/** a shot from a player's baseline: x 0..1 along it, (du, df) as aimOf takes it, power 0..1 */
export function launchOf(side: CarromSide, x: number, du: number, df: number, power: number): CarromLaunch {
  const [au, af] = aimOf(du, df);
  const p = Math.max(0, Math.min(1, power || 0));
  const speed = PHYS.vMin + p * (PHYS.vMax - PHYS.vMin);
  const [bx, by] = dirToBoard(side, au, af);
  const [sx, sy] = strikerSpot(side, x);
  return { x: sx, y: sy, vx: bx * speed, vy: by * speed };
}

/** a running simulation; apps step it to animate (advance(ms) each frame), the server runs it to the end */
export class CarromSim {
  readonly ids: string[];
  readonly colors: ('w' | 'b' | 'q' | 's')[];
  readonly x: number[];
  readonly y: number[];
  readonly vx: number[];
  readonly vy: number[];
  readonly r: number[];
  readonly m: number[];
  /** still on the board */
  readonly on: boolean[];
  readonly events: CarromEvent[] = [];
  readonly pocketed: string[] = [];
  firstHit: string | null = null;
  steps = 0;
  done = false;

  constructor(coins: readonly CarromCoin[], launch: CarromLaunch) {
    // index 0 is the striker, then the coins in the order given
    this.ids = [STRIKER, ...coins.map((c) => c.id)];
    this.colors = ['s', ...coins.map((c) => c.c)];
    this.x = [launch.x, ...coins.map((c) => c.x)];
    this.y = [launch.y, ...coins.map((c) => c.y)];
    this.vx = [launch.vx, ...coins.map(() => 0)];
    this.vy = [launch.vy, ...coins.map(() => 0)];
    this.r = [CARROM.strikerR, ...coins.map(() => CARROM.coinR)];
    this.m = [CARROM.strikerM, ...coins.map(() => CARROM.coinM)];
    this.on = this.ids.map(() => true);
  }

  get ms(): number {
    return this.steps * PHYS.stepMs;
  }

  private note(e: CarromEvent): void {
    if (this.events.length < PHYS.maxEvents) this.events.push(e);
  }

  /** one fixed step: move, pockets, collisions, walls, friction */
  step(): void {
    if (this.done) return;
    const n = this.ids.length;
    const dt = PHYS.dt;
    const { x, y, vx, vy, r, m, on } = this;
    this.steps++;
    const t = this.steps * PHYS.stepMs;
    for (let i = 0; i < n; i++) {
      if (!on[i]) continue;
      x[i] = x[i] + vx[i] * dt;
      y[i] = y[i] + vy[i] * dt;
    }
    const pr2 = CARROM.pocketR * CARROM.pocketR;
    for (let i = 0; i < n; i++) {
      if (!on[i]) continue;
      for (let p = 0; p < 4; p++) {
        const dx = x[i] - POCKETS[p][0];
        const dy = y[i] - POCKETS[p][1];
        if (dx * dx + dy * dy < pr2) {
          on[i] = false;
          vx[i] = 0;
          vy[i] = 0;
          if (i > 0) this.pocketed.push(this.ids[i]);
          this.note({ t, kind: 'pocket', id: this.ids[i], pocket: p });
          break;
        }
      }
    }
    for (let i = 0; i < n; i++) {
      if (!on[i]) continue;
      for (let j = i + 1; j < n; j++) {
        if (!on[j]) continue;
        if (vx[i] === 0 && vy[i] === 0 && vx[j] === 0 && vy[j] === 0) continue;
        const dx = x[j] - x[i];
        const dy = y[j] - y[i];
        const rr = r[i] + r[j];
        const d2 = dx * dx + dy * dy;
        if (d2 >= rr * rr) continue;
        const d = Math.sqrt(d2);
        const nx = d > 0 ? dx / d : 1;
        const ny = d > 0 ? dy / d : 0;
        // push apart by mass share
        const over = rr - d;
        const inv = 1 / (m[i] + m[j]);
        x[i] = x[i] - nx * over * m[j] * inv;
        y[i] = y[i] - ny * over * m[j] * inv;
        x[j] = x[j] + nx * over * m[i] * inv;
        y[j] = y[j] + ny * over * m[i] * inv;
        const vn = (vx[i] - vx[j]) * nx + (vy[i] - vy[j]) * ny;
        if (vn <= 0) continue;
        const jj = ((1 + PHYS.hitE) * vn) / (1 / m[i] + 1 / m[j]);
        vx[i] = vx[i] - (jj / m[i]) * nx;
        vy[i] = vy[i] - (jj / m[i]) * ny;
        vx[j] = vx[j] + (jj / m[j]) * nx;
        vy[j] = vy[j] + (jj / m[j]) * ny;
        if (i === 0 && this.firstHit === null) this.firstHit = this.ids[j];
        if (vn >= PHYS.soundV) this.note({ t, kind: 'hit', id: this.ids[i], with: this.ids[j], v: vn });
      }
    }
    for (let i = 0; i < n; i++) {
      if (!on[i]) continue;
      const lo = r[i];
      const hi = 1 - r[i];
      let knock = 0;
      if (x[i] < lo) {
        x[i] = lo;
        if (vx[i] < 0) {
          knock = Math.max(knock, -vx[i]);
          vx[i] = -vx[i] * PHYS.wallE;
        }
      } else if (x[i] > hi) {
        x[i] = hi;
        if (vx[i] > 0) {
          knock = Math.max(knock, vx[i]);
          vx[i] = -vx[i] * PHYS.wallE;
        }
      }
      if (y[i] < lo) {
        y[i] = lo;
        if (vy[i] < 0) {
          knock = Math.max(knock, -vy[i]);
          vy[i] = -vy[i] * PHYS.wallE;
        }
      } else if (y[i] > hi) {
        y[i] = hi;
        if (vy[i] > 0) {
          knock = Math.max(knock, vy[i]);
          vy[i] = -vy[i] * PHYS.wallE;
        }
      }
      if (knock >= PHYS.soundV) this.note({ t, kind: 'wall', id: this.ids[i], v: knock });
    }
    let moving = false;
    for (let i = 0; i < n; i++) {
      if (!on[i] || (vx[i] === 0 && vy[i] === 0)) continue;
      const s = Math.sqrt(vx[i] * vx[i] + vy[i] * vy[i]);
      const ns = s - (PHYS.friction + PHYS.drag * s) * dt;
      if (ns <= PHYS.stopV) {
        vx[i] = 0;
        vy[i] = 0;
      } else {
        const k = ns / s;
        vx[i] = vx[i] * k;
        vy[i] = vy[i] * k;
        moving = true;
      }
    }
    if (!moving || t >= PHYS.maxMs) {
      for (let i = 0; i < n; i++) {
        vx[i] = 0;
        vy[i] = 0;
      }
      this.done = true;
    }
  }

  /** steps until `ms` of shot time have passed (or it stops); apps call it every frame */
  advance(ms: number): void {
    const target = Math.min(PHYS.maxMs, ms);
    while (!this.done && this.steps * PHYS.stepMs < target) this.step();
  }

  /** every piece now, the striker first (id 'S', c 's'); on false once pocketed */
  pieces(): { id: string; c: 'w' | 'b' | 'q' | 's'; x: number; y: number; on: boolean }[] {
    return this.ids.map((id, i) => ({ id, c: this.colors[i], x: this.x[i], y: this.y[i], on: this.on[i] }));
  }

  result(): CarromResult {
    const coins: CarromCoin[] = [];
    for (let i = 1; i < this.ids.length; i++) if (this.on[i]) coins.push({ id: this.ids[i], c: this.colors[i] as 'w' | 'b' | 'q', x: this.x[i], y: this.y[i] });
    return {
      coins,
      pocketed: [...this.pocketed],
      striker: { x: this.x[0], y: this.y[0], pocketed: !this.on[0] },
      firstHit: this.firstHit,
      events: this.events.map((e) => ({ ...e })),
      ms: this.ms,
    };
  }
}

/** runs a shot to the end */
export function simulate(coins: readonly CarromCoin[], launch: CarromLaunch): CarromResult {
  const sim = new CarromSim(coins, launch);
  while (!sim.done) sim.step();
  return sim.result();
}

/**
 * the aim line: where the striker first touches a coin or a wall going straight from (x, y) along unit (dx, dy).
 * at: the striker's centre then; coin: the coin it meets (null for a wall); after: the coin's way off, or the bounce
 */
export function firstContact(coins: readonly CarromCoin[], x: number, y: number, dx: number, dy: number): { at: [number, number]; coin: string | null; after: [number, number] } {
  const R = CARROM.strikerR + CARROM.coinR;
  let best = Infinity;
  let hit: CarromCoin | null = null;
  for (const c of coins) {
    const px = c.x - x;
    const py = c.y - y;
    const b = px * dx + py * dy;
    if (b <= 0) continue;
    const q = px * px + py * py - R * R;
    const disc = b * b - q;
    if (disc < 0) continue;
    const t = Math.max(0, b - Math.sqrt(disc));
    if (t < best) {
      best = t;
      hit = c;
    }
  }
  const sr = CARROM.strikerR;
  let wall = Infinity;
  let bx = dx;
  let by = dy;
  if (dx > 0 && (1 - sr - x) / dx < wall) [wall, bx, by] = [(1 - sr - x) / dx, -dx, dy];
  if (dx < 0 && (sr - x) / dx < wall) [wall, bx, by] = [(sr - x) / dx, -dx, dy];
  if (dy > 0 && (1 - sr - y) / dy < wall) [wall, bx, by] = [(1 - sr - y) / dy, dx, -dy];
  if (dy < 0 && (sr - y) / dy < wall) [wall, bx, by] = [(sr - y) / dy, dx, -dy];
  if (hit && best <= wall) {
    const ax = x + dx * best;
    const ay = y + dy * best;
    const nx = hit.x - ax;
    const ny = hit.y - ay;
    const l = Math.sqrt(nx * nx + ny * ny) || 1;
    return { at: [ax, ay], coin: hit.id, after: [nx / l, ny / l] };
  }
  const w = Math.max(0, wall === Infinity ? 0 : wall);
  return { at: [x + dx * w, y + dy * w], coin: null, after: [bx, by] };
}
