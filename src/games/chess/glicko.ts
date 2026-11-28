import { CHESS_MAX_RD, CHESS_MIN_RD, type ChessRating } from '../../types.js';

/** Glicko-2 (Glickman, "Example of the Glicko-2 system"); Lichess uses τ 0.75 */
export const GLICKO_TAU = 0.75;
const SCALE = 173.7178;
const EPS = 0.000001;
/** rating periods per day of inactivity (RD grows back between games, as on Lichess) */
const PERIODS_PER_DAY = 0.21436;

export interface GlickoInput {
  r: number;
  rd: number;
  vol: number;
}

/** one game against one opponent; score 1 win, 0.5 draw, 0 loss */
export interface GlickoResult {
  opp: { r: number; rd: number };
  score: number;
}

const g = (phi: number) => 1 / Math.sqrt(1 + (3 * phi * phi) / (Math.PI * Math.PI));
const expected = (mu: number, muJ: number, phiJ: number) => 1 / (1 + Math.exp(-g(phiJ) * (mu - muJ)));

/** the new rating after one rating period's games (no games: RD grows from the volatility only) */
export function glicko2(p: GlickoInput, games: GlickoResult[], tau = GLICKO_TAU): GlickoInput {
  const mu = (p.r - 1500) / SCALE;
  const phi = p.rd / SCALE;
  const sigma = p.vol;
  if (games.length === 0) return { r: p.r, rd: Math.min(Math.sqrt(phi * phi + sigma * sigma) * SCALE, CHESS_MAX_RD), vol: sigma };
  let vInv = 0;
  let sum = 0;
  for (const x of games) {
    const muJ = (x.opp.r - 1500) / SCALE;
    const phiJ = x.opp.rd / SCALE;
    const e = expected(mu, muJ, phiJ);
    const gj = g(phiJ);
    vInv += gj * gj * e * (1 - e);
    sum += gj * (x.score - e);
  }
  const v = 1 / vInv;
  const delta = v * sum;
  // the new volatility by the Illinois algorithm
  const a = Math.log(sigma * sigma);
  const f = (x: number) => {
    const ex = Math.exp(x);
    const d = phi * phi + v + ex;
    return (ex * (delta * delta - phi * phi - v - ex)) / (2 * d * d) - (x - a) / (tau * tau);
  };
  let A = a;
  let B: number;
  if (delta * delta > phi * phi + v) B = Math.log(delta * delta - phi * phi - v);
  else {
    let k = 1;
    while (f(a - k * tau) < 0) k++;
    B = a - k * tau;
  }
  let fA = f(A);
  let fB = f(B);
  for (let i = 0; Math.abs(B - A) > EPS && i < 200; i++) {
    const C = A + ((A - B) * fA) / (fB - fA);
    const fC = f(C);
    if (fC * fB <= 0) {
      A = B;
      fA = fB;
    } else fA /= 2;
    B = C;
    fB = fC;
  }
  const sigma2 = Math.exp(A / 2);
  const phiStar = Math.sqrt(phi * phi + sigma2 * sigma2);
  const phi2 = 1 / Math.sqrt(1 / (phiStar * phiStar) + 1 / v);
  const mu2 = mu + phi2 * phi2 * sum;
  return { r: mu2 * SCALE + 1500, rd: phi2 * SCALE, vol: sigma2 };
}

/** RD grown by the days since the last rated game, capped */
export function agedRd(rating: Pick<ChessRating, 'rd' | 'vol' | 'updatedAt' | 'games'>, now: number): number {
  if (rating.games === 0 || !rating.updatedAt) return Math.min(rating.rd, CHESS_MAX_RD);
  const periods = Math.max(0, (now - rating.updatedAt) / 86_400_000) * PERIODS_PER_DAY;
  const phi = rating.rd / SCALE;
  return Math.min(Math.sqrt(phi * phi + periods * rating.vol * rating.vol) * SCALE, CHESS_MAX_RD);
}

/** both sides' new ratings after one rated game; scoreW 1 / 0.5 / 0 */
export function rateGame(w: GlickoInput, b: GlickoInput, scoreW: number): { w: GlickoInput; b: GlickoInput } {
  const clamp = (x: GlickoInput): GlickoInput => ({ r: Math.max(x.r, 100), rd: Math.min(Math.max(x.rd, CHESS_MIN_RD), CHESS_MAX_RD), vol: Math.min(x.vol, 0.1) });
  return {
    w: clamp(glicko2(w, [{ opp: b, score: scoreW }])),
    b: clamp(glicko2(b, [{ opp: w, score: 1 - scoreW }])),
  };
}
