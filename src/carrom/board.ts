// Carrom board: sizes, the starting flower, sides and striker placement. Shared byte-identical by tools/sync-carrom.sh.
// Only + - * /, Math.sqrt, Math.min and Math.max, so every engine gets the same numbers.

/** board units: the playing surface is 1 × 1 (a real board's 74 cm), x right, y down, (0,0) the top-left corner */
export const CARROM = {
  /** coin radius (3.18 cm across) */
  coinR: 0.0215,
  /** striker radius (4.13 cm across) */
  strikerR: 0.0279,
  /** pocket radius (4.45 cm across); a piece whose centre comes within it drops */
  pocketR: 0.0315,
  /** pocket centres sit this far in from both edges of their corner */
  pocketAt: 0.0315,
  /** the striker's centre line: this far in from the player's own edge */
  baseAt: 0.1587,
  /** the two baseline lines, as distances from the player's edge */
  baseLines: [0.1372, 0.1802] as const,
  /** the striker's centre may slide between these (along the baseline, 0..1 from the player's left) */
  baseFrom: 0.2039,
  baseTo: 0.7961,
  /** the circles that end each baseline (radius) */
  baseCircleR: 0.0215,
  /** the centre design: the small circle and the big ring */
  centreR: 0.0215,
  ringR: 0.1149,
  /** coin and striker masses */
  coinM: 1,
  strikerM: 1.5,
} as const;

export type CarromColor = 'w' | 'b' | 'q';
/** a coin on the board: id 'W1'..'W9', 'B1'..'B9' or 'Q' */
export interface CarromCoin {
  id: string;
  c: CarromColor;
  x: number;
  y: number;
}

/** sides round the table: 0 bottom, 1 left, 2 top, 3 right (clockwise as seen from above) */
export type CarromSide = 0 | 1 | 2 | 3;

/** the sides players shoot from, by player count, in turn order */
export const CARROM_SIDES: Record<2 | 3 | 4, CarromSide[]> = { 2: [0, 2], 3: [0, 1, 2], 4: [0, 1, 2, 3] };

/** the four pocket centres: top-left, top-right, bottom-right, bottom-left */
export const POCKETS: readonly (readonly [number, number])[] = [
  [CARROM.pocketAt, CARROM.pocketAt],
  [1 - CARROM.pocketAt, CARROM.pocketAt],
  [1 - CARROM.pocketAt, 1 - CARROM.pocketAt],
  [CARROM.pocketAt, 1 - CARROM.pocketAt],
];

/** a point in a player's own frame (u along their baseline from their left, f in from their edge) on the board */
export function toBoard(side: CarromSide, u: number, f: number): [number, number] {
  if (side === 0) return [u, 1 - f];
  if (side === 1) return [f, u];
  if (side === 2) return [1 - u, f];
  return [1 - f, 1 - u];
}

/** a board point in a player's own frame [u, f] (the inverse of toBoard) */
export function toLocal(side: CarromSide, x: number, y: number): [number, number] {
  if (side === 0) return [x, 1 - y];
  if (side === 1) return [y, x];
  if (side === 2) return [1 - x, y];
  return [1 - y, 1 - x];
}

/** a direction in a player's frame (du to their right, df into the board) as a board direction */
export function dirToBoard(side: CarromSide, du: number, df: number): [number, number] {
  if (side === 0) return [du, -df];
  if (side === 1) return [df, du];
  if (side === 2) return [-du, df];
  return [-df, -du];
}

/** a board direction in a player's frame [du, df] */
export function dirToLocal(side: CarromSide, dx: number, dy: number): [number, number] {
  if (side === 0) return [dx, -dy];
  if (side === 1) return [dy, dx];
  if (side === 2) return [-dx, dy];
  return [-dy, -dx];
}

/** where the striker sits for a baseline position x (0..1, clamped) */
export function strikerSpot(side: CarromSide, x: number): [number, number] {
  const t = Math.max(0, Math.min(1, x));
  return toBoard(side, CARROM.baseFrom + t * (CARROM.baseTo - CARROM.baseFrom), CARROM.baseAt);
}

/** the striker at x would overlap no coin */
export function strikerFits(coins: readonly CarromCoin[], side: CarromSide, x: number): boolean {
  const [sx, sy] = strikerSpot(side, x);
  const min = CARROM.strikerR + CARROM.coinR;
  for (const c of coins) {
    const dx = c.x - sx;
    const dy = c.y - sy;
    if (dx * dx + dy * dy < min * min) return false;
  }
  return true;
}

/** the free baseline spot nearest `want` (steps of 1/200), or null when the whole baseline is covered */
export function nearestFit(coins: readonly CarromCoin[], side: CarromSide, want: number): number | null {
  for (let k = 0; k <= 200; k++) {
    for (const s of k === 0 ? [0] : [k, -k]) {
      const x = want + s / 200;
      if (x < 0 || x > 1) continue;
      if (strikerFits(coins, side, x)) return x;
    }
  }
  return null;
}

// cos/sin of multiples of 30°, as exact constants (no trig)
const H = Math.sqrt(3) / 2;
const RAYS: readonly (readonly [number, number])[] = [
  [1, 0], [H, 0.5], [0.5, H], [0, 1], [-0.5, H], [-H, 0.5],
  [-1, 0], [-H, -0.5], [-0.5, -H], [0, -1], [0.5, -H], [H, -0.5],
];

/** the standard flower: the queen in the middle, 6 coins round her, 12 round them (9 white, 9 black) */
export function startCoins(): CarromCoin[] {
  // a hair's gap so the pack starts untouched
  const d = 2 * CARROM.coinR + 0.0002;
  const coins: CarromCoin[] = [{ id: 'Q', c: 'q', x: 0.5, y: 0.5 }];
  let w = 0;
  let b = 0;
  const add = (c: 'w' | 'b', rx: number, ry: number, r: number) => {
    const id = c === 'w' ? `W${++w}` : `B${++b}`;
    coins.push({ id, c, x: 0.5 + rx * r, y: 0.5 - ry * r });
  };
  // inner ring at 60° steps, alternating, white pointing at the bottom player
  for (let k = 0; k < 6; k++) add(k % 2 === 0 ? 'w' : 'b', RAYS[(2 * k + 9) % 12][0], RAYS[(2 * k + 9) % 12][1], d);
  // outer ring: on the same rays (same colour, making the Y) and between them (the other colour)
  for (let k = 0; k < 6; k++) add(k % 2 === 0 ? 'w' : 'b', RAYS[(2 * k + 9) % 12][0], RAYS[(2 * k + 9) % 12][1], 2 * d);
  for (let k = 0; k < 6; k++) add(k % 2 === 0 ? 'b' : 'w', RAYS[(2 * k + 10) % 12][0], RAYS[(2 * k + 10) % 12][1], H * 2 * d);
  return coins;
}

/** a free spot for a coin coming back to the centre: the centre, else the nearest free point on rings round it */
export function freeSpot(coins: readonly CarromCoin[]): [number, number] {
  const min = 2 * CARROM.coinR + 0.0002;
  const free = (x: number, y: number) => {
    for (const c of coins) {
      const dx = c.x - x;
      const dy = c.y - y;
      if (dx * dx + dy * dy < min * min) return false;
    }
    return true;
  };
  if (free(0.5, 0.5)) return [0.5, 0.5];
  for (let ring = 1; ring <= 40; ring++) {
    const r = ring * CARROM.coinR * 0.5;
    for (const [rx, ry] of RAYS) {
      const x = 0.5 + rx * r;
      const y = 0.5 + ry * r;
      if (free(x, y)) return [x, y];
    }
  }
  return [0.5, 0.5];
}
