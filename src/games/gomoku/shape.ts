import { GOMOKU_WIN } from '../../types.js';

/** the four line directions: right, down, down-right, down-left */
export const DIRS: readonly [number, number][] = [[1, 0], [0, 1], [1, 1], [-1, 1]];

/** what one stone of `seat` at an empty point would make, over all four directions */
export interface Threat {
  five: number;
  openFour: number;
  four: number;
  openThree: number;
  three: number;
  two: number;
}

/** the run of seat's stones through at in one direction (at counts as seat's), as point indexes end to end */
export function runThrough(cells: ArrayLike<number>, size: number, at: number, seat: number, dx: number, dy: number): number[] {
  const x0 = at % size;
  const y0 = Math.floor(at / size);
  const back: number[] = [];
  const fwd: number[] = [];
  for (let k = 1; ; k++) {
    const x = x0 - dx * k;
    const y = y0 - dy * k;
    if (x < 0 || y < 0 || x >= size || y >= size || cells[y * size + x] !== seat) break;
    back.unshift(y * size + x);
  }
  for (let k = 1; ; k++) {
    const x = x0 + dx * k;
    const y = y0 + dy * k;
    if (x < 0 || y < 0 || x >= size || y >= size || cells[y * size + x] !== seat) break;
    fwd.push(y * size + x);
  }
  return [...back, at, ...fwd];
}

/** the longest line through at (its stone counted as seat's) */
export function longestAt(cells: ArrayLike<number>, size: number, at: number, seat: number): number[] {
  let best: number[] = [];
  for (const [dx, dy] of DIRS) {
    const run = runThrough(cells, size, at, seat, dx, dy);
    if (run.length > best.length) best = run;
  }
  return best;
}

// the line of 9 points centred on at: 1 seat (at itself too), 0 empty, 2 blocked (other stone or off the board)
function windowOf(cells: ArrayLike<number>, size: number, at: number, seat: number, dx: number, dy: number): number[] {
  const x0 = at % size;
  const y0 = Math.floor(at / size);
  const out: number[] = [];
  for (let k = -4; k <= 4; k++) {
    const x = x0 + dx * k;
    const y = y0 + dy * k;
    if (k === 0) out.push(1);
    else if (x < 0 || y < 0 || x >= size || y >= size) out.push(2);
    else {
      const c = cells[y * size + x];
      out.push(c === seat ? 1 : c === -1 ? 0 : 2);
    }
  }
  return out;
}

/** the shapes a stone of seat at the empty point at would make */
export function threatAt(cells: ArrayLike<number>, size: number, at: number, seat: number): Threat {
  const t: Threat = { five: 0, openFour: 0, four: 0, openThree: 0, three: 0, two: 0 };
  for (const [dx, dy] of DIRS) {
    const w = windowOf(cells, size, at, seat, dx, dy);
    if (runThrough(cells, size, at, seat, dx, dy).length >= GOMOKU_WIN) {
      t.five++;
      continue;
    }
    // six-point windows holding the centre (index 4): _XXXX_ is an open four, _ with 3 of 4 and _ an open three
    let openFour = false;
    let openThree = false;
    for (let s = 0; s <= 3; s++) {
      const six = w.slice(s, s + 6);
      if (six[0] !== 0 || six[5] !== 0 || six.includes(2)) continue;
      const mid = six.slice(1, 5).filter((v) => v === 1).length;
      if (mid === 4) openFour = true;
      else if (mid === 3) openThree = true;
    }
    // five-point windows holding the centre: 4 stones and a gap is a four, 3 a three, 2 a two
    const gaps = new Set<number>();
    let threes = 0;
    let twos = 0;
    for (let s = 0; s <= 4; s++) {
      const five = w.slice(s, s + 5);
      if (five.includes(2)) continue;
      const n = five.filter((v) => v === 1).length;
      if (n === 4) gaps.add(s + five.indexOf(0));
      else if (n === 3) threes++;
      else if (n === 2) twos++;
    }
    if (openFour || gaps.size >= 2) t.openFour++;
    else if (gaps.size === 1) t.four++;
    else if (openThree) t.openThree++;
    else if (threes > 0) t.three++;
    else if (twos > 0) t.two++;
  }
  return t;
}

/** how good a threat is, roughly: five ≫ open four ≈ double threats ≫ four > open three ≫ the rest */
export function threatScore(t: Threat): number {
  if (t.five) return 1_000_000;
  if (t.openFour || t.four >= 2) return 100_000;
  if (t.four && t.openThree) return 60_000;
  if (t.openThree >= 2) return 40_000;
  return t.four * 5_000 + t.openThree * 3_000 + t.three * 300 + t.two * 60;
}

/** how urgent stopping a threat is (the opponent's shape if they got this point): forced blocks high, small shapes low */
export function defenseScore(t: Threat): number {
  if (t.five) return 900_000;
  if (t.openFour || t.four >= 2) return 80_000;
  if (t.four && t.openThree) return 50_000;
  if (t.openThree >= 2) return 30_000;
  return t.four * 1_500 + t.openThree * 1_200 + t.three * 100 + t.two * 25;
}
