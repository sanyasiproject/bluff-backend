import { CARROM, PHYS, POCKETS, launchOf, nearestFit, simulate, strikerFits, toLocal, type CarromCoin, type CarromSide } from '../../carrom/index.js';
import type { BotLevel, CarromMoveInput, CarromMode } from '../../types.js';
import { resolveShot, type QueenState } from './rules.js';

/** what a bot knows: the public table */
export interface CarromSeat {
  mode: CarromMode;
  me: string;
  side: CarromSide;
  color: 'w' | 'b' | null;
  coins: CarromCoin[];
  queen: QueenState;
}

/** candidates simulated, aim noise (direction units) and power noise (share) by level */
const LEVEL = {
  normal: { sims: 24, aim: 0.02, power: 0.12, banks: false, pickTop: 4 },
  hard: { sims: 60, aim: 0.008, power: 0.06, banks: true, pickTop: 2 },
  expert: { sims: 110, aim: 0.0025, power: 0.025, banks: true, pickTop: 1 },
} as const;

/** a normal random number (Box-Muller); bots may use trig, the physics may not */
function gauss(rand: () => number): number {
  const u = Math.max(rand(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

// distance a piece slides from speed v under the friction model (closed form of dv/dt = -(A + K v))
const slide = (v: number) => v / PHYS.drag - (PHYS.friction / (PHYS.drag * PHYS.drag)) * Math.log(1 + (PHYS.drag * v) / PHYS.friction);
function speedFor(dist: number): number {
  let lo = 0;
  let hi = 20;
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    if (slide(mid) < dist) lo = mid;
    else hi = mid;
  }
  return hi;
}

/** geometric candidates: each target coin into each pocket (cut shots), a few banks, and plain pushes */
export function candidates(s: CarromSeat, level: BotLevel, rand: () => number): (CarromMoveInput & { prior: number })[] {
  const L = LEVEL[level];
  const out: (CarromMoveInput & { prior: number })[] = [];
  const targets = s.coins.filter((c) => (s.mode === 'freestyle' ? true : c.c === s.color || c.c === 'q'));
  const R = CARROM.strikerR + CARROM.coinR;
  const xs = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1];
  for (const c of targets) {
    const [cu, cf] = toLocal(s.side, c.x, c.y);
    for (const P of POCKETS) {
      const [pu, pf] = toLocal(s.side, P[0], P[1]);
      const lx = pu - cu;
      const ly = pf - cf;
      const dist = Math.sqrt(lx * lx + ly * ly);
      const nu = lx / dist;
      const nf = ly / dist;
      const gu = cu - nu * R;
      const gf = cf - nf * R;
      // the striker spot that lines up straight behind the coin, plus the grid
      const straight = nf > 0.05 ? (cu - ((cf - CARROM.baseAt) * nu) / nf - CARROM.baseFrom) / (CARROM.baseTo - CARROM.baseFrom) : -1;
      for (const x of straight >= 0 && straight <= 1 ? [straight, ...xs] : xs) {
        if (!strikerFits(s.coins, s.side, x)) continue;
        const su = CARROM.baseFrom + x * (CARROM.baseTo - CARROM.baseFrom);
        const sf = CARROM.baseAt;
        let du = gu - su;
        let df = gf - sf;
        const ls = Math.sqrt(du * du + df * df);
        du /= ls;
        df /= ls;
        if (df < 0.08) continue;
        const cut = du * nu + df * nf;
        if (cut < 0.35) continue;
        const vc = speedFor(dist + 0.06);
        const vs = vc / (cut * ((1 + PHYS.hitE) * CARROM.strikerM) / (CARROM.strikerM + CARROM.coinM));
        const v0 = Math.sqrt(vs * vs + 2 * (PHYS.friction + PHYS.drag * vs) * ls);
        const power = Math.min(1, Math.max(0.05, (v0 - PHYS.vMin) / (PHYS.vMax - PHYS.vMin)));
        out.push({ type: 'shot', x, dx: du, dy: df, power, prior: cut * 2 - dist - ls * 0.5 + (c.c === 'q' ? 0.3 : 0) });
      }
      // a bank off the side walls (in my frame): aim at the ghost's mirror image
      if (L.banks) {
        for (const wall of [CARROM.strikerR, 1 - CARROM.strikerR]) {
          const mu = 2 * wall - gu;
          const x = 0.5;
          if (!strikerFits(s.coins, s.side, x)) continue;
          const su = CARROM.baseFrom + x * (CARROM.baseTo - CARROM.baseFrom);
          let du = mu - su;
          let df = gf - CARROM.baseAt;
          const ls = Math.sqrt(du * du + df * df);
          du /= ls;
          df /= ls;
          if (df < 0.08) continue;
          out.push({ type: 'shot', x, dx: du, dy: df, power: Math.min(1, 0.35 + ls * 0.4 + dist * 0.4), prior: -1.2 - dist });
        }
      }
    }
  }
  // plain pushes straight up the board (breaks and nothing better)
  for (const x of [0.3, 0.5, 0.7]) if (strikerFits(s.coins, s.side, x)) out.push({ type: 'shot', x, dx: (rand() - 0.5) * 0.1, dy: 1, power: 0.7 + rand() * 0.3, prior: -3 });
  return out.sort((a, b) => b.prior - a.prior).slice(0, L.sims);
}

/** how good a shot's outcome is for me */
export function scoreShot(s: CarromSeat, m: CarromMoveInput): number {
  const res = simulate(s.coins, launchOf(s.side, m.x, m.dx, m.dy, m.power));
  const out = resolveShot(s.mode, s.me, s.color, s.coins, s.queen, res);
  let score = 0;
  if (s.mode === 'freestyle') score += out.points;
  else {
    score += out.kept.filter((id) => id !== 'Q').length * 30 - out.given.length * 25;
    if (out.queenNote === 'covered') score += 60;
    if (out.queenNote === 'pocketed') score += 25;
    if (out.queenNote === 'returned') score -= 15;
    if (out.cleared === s.color) score += 200;
  }
  if (out.foul) score -= 40;
  if (out.again) score += 15;
  // leave: my coins near pockets are good, theirs (Classic) are bad
  for (const c of out.coins) {
    let near = 9;
    for (const P of POCKETS) near = Math.min(near, Math.sqrt((c.x - P[0]) ** 2 + (c.y - P[1]) ** 2));
    const w = near < 0.2 ? (0.2 - near) * 20 : 0;
    if (s.mode === 'freestyle' || c.c === s.color) score += w;
    else if (c.c !== 'q') score -= w * 0.6;
  }
  return score;
}

/** the move to play: the best simulated candidate (Normal picks among the top few), then the hand's noise */
export function finish(best: { m: CarromMoveInput; score: number }[], level: BotLevel, rand: () => number): CarromMoveInput {
  const L = LEVEL[level];
  best.sort((a, b) => b.score - a.score);
  const pick = best[Math.floor(rand() * Math.min(L.pickTop, best.length))]?.m ?? { type: 'shot', x: 0.5, dx: 0, dy: 1, power: 0.6 };
  const e = gauss(rand) * L.aim;
  const du = pick.dx - e * pick.dy;
  const df = pick.dy + e * pick.dx;
  const power = Math.min(1, Math.max(0, pick.power * (1 + gauss(rand) * L.power)));
  return { type: 'shot', x: pick.x, dx: du, dy: df, power };
}

/** a quick decision on the spot (stand-in moves): fewer sims */
export function decideNow(s: CarromSeat, level: BotLevel, rand: () => number, maxSims = 16): CarromMoveInput {
  const cands = candidates(s, level, rand).slice(0, maxSims);
  return fit(s, finish(cands.map((m) => ({ m, score: scoreShot(s, m) })), level, rand));
}

/** a striker spot that sits clear of the coins */
function fit(s: CarromSeat, m: CarromMoveInput): CarromMoveInput {
  return strikerFits(s.coins, s.side, m.x) ? m : { ...m, x: nearestFit(s.coins, s.side, m.x) ?? m.x };
}

/** the full think, in short slices so the event loop stays free; stops early past `budgetMs` */
export async function decide(s: CarromSeat, level: BotLevel, rand: () => number, budgetMs = 400): Promise<CarromMoveInput> {
  const cands = candidates(s, level, rand);
  const t0 = Date.now();
  const scored: { m: CarromMoveInput; score: number }[] = [];
  let slice = Date.now();
  for (const m of cands) {
    scored.push({ m, score: scoreShot(s, m) });
    if (Date.now() - t0 > budgetMs) break;
    if (Date.now() - slice > 8) {
      await new Promise<void>((r) => setImmediate(r));
      slice = Date.now();
    }
  }
  return fit(s, finish(scored, level, rand));
}
