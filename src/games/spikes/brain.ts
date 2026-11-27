import type { BotLevel } from '../../types.js';
import { covers, SPIKES_STEP_MS, STEPS, type SpikesGame, type StepDir } from './game.js';

export type SpikesBotLevel = BotLevel;

/** a bot's step pace while running, for judging what it can reach in time (ms; read at call time: game.ts imports this file) */
const runMs = () => SPIKES_STEP_MS + 100;
/** chance a bot on a safe square wanders a step, by level */
const WANDER: Record<BotLevel, number> = { normal: 0.3, hard: 0.22, expert: 0.15 };

type Cell = [number, number];
const key = ([c, r]: Cell) => `${c},${r}`;

/** a bot's next step: off any line it has noticed is about to strike, else now and then a wander; null to stay */
export function botThink(g: SpikesGame, id: string, now: number, rand: () => number): StepDir | null {
  const me = g.pos.get(id)!;
  // only warnings this bot has noticed by now
  const seen = g.warnings.filter((w) => (w.notice.get(id) ?? Infinity) <= now);
  const strikeOn = (cell: Cell) => Math.min(Infinity, ...seen.filter((w) => covers(w, cell)).map((w) => w.strikeAt));
  const moves = (cell: Cell) =>
    (Object.keys(STEPS) as StepDir[])
      .map((d) => [d, [cell[0] + STEPS[d][0], cell[1] + STEPS[d][1]] as Cell] as const)
      .filter(([, c]) => c[0] >= 0 && c[1] >= 0 && c[0] < g.size && c[1] < g.size);
  if (strikeOn(me) === Infinity) {
    if (rand() >= WANDER[g.level]) return null;
    const ok = moves(me).filter(([, c]) => strikeOn(c) === Infinity);
    if (ok.length === 0) return null;
    // better bots drift towards the middle, where there's room to run
    const mid = (g.size - 1) / 2;
    const dist = (c: Cell) => Math.abs(c[0] - mid) + Math.abs(c[1] - mid);
    if (g.level !== 'normal' && rand() < 0.5) return ok.reduce((a, b) => (dist(b[1]) < dist(a[1]) ? b : a))[0];
    return ok[Math.floor(rand() * ok.length)][0];
  }
  // run: the nearest square no seen spike will cross, through squares that won't be struck before we pass
  const first = new Map<string, StepDir>();
  const queue: { cell: Cell; steps: number }[] = [{ cell: me, steps: 0 }];
  const done = new Set([key(me)]);
  let fallback: { dir: StepDir; at: number } | null = null;
  while (queue.length > 0) {
    const { cell, steps } = queue.shift()!;
    for (const [d, next] of moves(cell)) {
      const k = key(next);
      if (done.has(k)) continue;
      done.add(k);
      const dir = steps === 0 ? d : first.get(key(cell))!;
      first.set(k, dir);
      const strike = strikeOn(next);
      if (strike === Infinity) return dir;
      const arrive = now + (steps + 1) * runMs();
      // the square the spike reaches last, in case nowhere is safe
      if (!fallback || strike > fallback.at) fallback = { dir, at: strike };
      if (strike > arrive + runMs()) queue.push({ cell: next, steps: steps + 1 });
    }
  }
  return fallback && fallback.at > strikeOn(me) ? fallback.dir : null;
}
