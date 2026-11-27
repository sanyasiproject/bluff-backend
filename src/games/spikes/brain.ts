import { SPIKES_SPEED, type BotLevel } from '../../types.js';
import { covers, type LiveWarning, type Point, type SpikesGame } from './game.js';

export type SpikesBotLevel = BotLevel;

/** a bot's running speed, as a share of SPIKES_SPEED */
const PACE: Record<BotLevel, number> = { normal: 0.85, hard: 0.95, expert: 1 };
/** chance a bot standing safe wanders somewhere else each time it looks around */
const WANDER: Record<BotLevel, number> = { normal: 0.07, hard: 0.06, expert: 0.05 };
/** a path crossing a band this close to its strike is not taken (ms) */
const CROSS_MS = 220;

/** a bot's speed in arena units per second */
export const botSpeedOf = (level: BotLevel): number => SPIKES_SPEED * PACE[level];

/** ms until a bot looks around again, by level */
export function botThinkMs(level: BotLevel, rand: () => number): number {
  if (level === 'expert') return 110 + rand() * 110;
  if (level === 'hard') return 170 + rand() * 170;
  return 250 + rand() * 230;
}

const dist = (a: Point, b: Point) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** a bot's new target: off any band it has noticed is about to strike, now and then a wander; null keeps its run */
export function botThink(g: SpikesGame, id: string, now: number, rand: () => number): Point | null {
  const me = g.pos.get(id)!;
  const run = g.botRun.get(id);
  // only warnings this bot has noticed by now
  const seen = g.warnings.filter((w) => (w.notice.get(id) ?? Infinity) <= now);
  const safe = (p: Point) => !seen.some((w) => covers(w, p));
  const speed = botSpeedOf(g.level) / 1000;
  const pathOk = (to: Point) => clearPath(seen, me, to, now, speed);
  // a target still safe and reachable: carry on
  if (run?.target && safe(run.target) && pathOk(run.target)) return null;
  const spots = candidates(g, me);
  const mid = g.size / 2;
  const fromMid = (p: Point) => Math.abs(p[0] - mid) + Math.abs(p[1] - mid);
  if (safe(me)) {
    // standing safe: stop a run that turned bad, sometimes stroll somewhere new
    if (rand() >= WANDER[g.level]) return run?.target ? [...me] : null;
    const ok = spots.filter((p) => safe(p) && pathOk(p) && dist(p, me) > 0.4);
    if (ok.length === 0) return null;
    // better bots drift towards the middle, where there's room to run
    if (g.level !== 'normal' && rand() < 0.5) return ok.reduce((a, b) => (fromMid(b) < fromMid(a) ? b : a));
    return ok[Math.floor(rand() * ok.length)];
  }
  // run: the nearest safe spot whose path crosses no band near its strike
  const good = spots.filter((p) => safe(p) && pathOk(p));
  if (good.length > 0) return good.reduce((a, b) => (dist(b, me) + (g.level === 'normal' ? 0 : fromMid(b) * 0.05) < dist(a, me) + (g.level === 'normal' ? 0 : fromMid(a) * 0.05) ? b : a));
  // nowhere clean: the nearest safe spot anyway
  const any = spots.filter(safe);
  return any.length > 0 ? any.reduce((a, b) => (dist(b, me) < dist(a, me) ? b : a)) : null;
}

/** box centres, and the centres straight across from where the bot stands */
function candidates(g: SpikesGame, me: Point): Point[] {
  const out: Point[] = [];
  for (let i = 0; i < g.size; i++) {
    out.push([g.clamp(me[0]), i + 0.5], [i + 0.5, g.clamp(me[1])]);
    for (let j = 0; j < g.size; j++) out.push([i + 0.5, j + 0.5]);
  }
  return out;
}

/** no point on the way sits in a band when its spike strikes */
function clearPath(seen: LiveWarning[], from: Point, to: Point, now: number, speed: number): boolean {
  const total = dist(from, to) / speed;
  const parts = 6;
  for (let k = 0; k <= parts; k++) {
    const f = k / parts;
    const p: Point = [from[0] + (to[0] - from[0]) * f, from[1] + (to[1] - from[1]) * f];
    const t = now + total * f;
    if (seen.some((w) => covers(w, p) && Math.abs(w.strikeAt - t) <= CROSS_MS)) return false;
  }
  return true;
}
