import { DART_NUMBERS, DART_RINGS, type BotLevel } from '../../types.js';
import { gauss, type DartsGame } from './game.js';

/** how far a bot's dart lands from its aim (board units, Normal spread) */
export const DART_AIM_NOISE: Record<BotLevel, number> = { normal: 0.22, hard: 0.14, expert: 0.08 };

/** the middle of each ring, as a share of the board's radius */
const MID = {
  single: (DART_RINGS.outerBull + DART_RINGS.trebleIn) / 2,
  treble: (DART_RINGS.trebleIn + DART_RINGS.trebleOut) / 2,
  double: (DART_RINGS.doubleIn + DART_RINGS.doubleOut) / 2,
} as const;

/** a point on the board: ring radius r, the middle of number n's wedge */
export function aimAt(n: number, r: number): { x: number; y: number } {
  const a = (DART_NUMBERS.indexOf(n as (typeof DART_NUMBERS)[number]) * 18 * Math.PI) / 180;
  return { x: r * Math.sin(a), y: r * Math.cos(a) };
}

/** where to aim with this many points left: an exact finish when one dart can do it (easiest ring first), else treble 20 or a set-up */
export function targetFor(left: number): { x: number; y: number } {
  if (left <= 20) return aimAt(left, MID.single);
  if (left <= 60 && left % 3 === 0) return aimAt(left / 3, MID.treble);
  if (left <= 40 && left % 2 === 0) return aimAt(left / 2, MID.double);
  if (left === 25) return { x: 0, y: (DART_RINGS.bull + DART_RINGS.outerBull) / 2 };
  if (left === 50) return { x: 0, y: 0 };
  // no one-dart finish: treble 20 when far, else a single that leaves an easy number
  if (left > 80) return aimAt(20, MID.treble);
  return aimAt(Math.min(20, left - 20), MID.single);
}

/** a bot's (or a timed-out person's) dart: aim, then the level's hand noise */
export function decide(g: DartsGame, id: string, level: BotLevel, rand: () => number): { type: 'throw'; x: number; y: number } {
  const t = targetFor(g.left.get(id) ?? g.start);
  const s = DART_AIM_NOISE[level];
  const r3 = (v: number) => Math.round(v * 1000) / 1000;
  return { type: 'throw', x: r3(t.x + gauss(rand) * s), y: r3(t.y + gauss(rand) * s) };
}
