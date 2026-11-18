/** a skill estimate (mu) and how unsure it still is (sigma) */
export interface Rating {
  mu: number;
  sigma: number;
}

/** where every player starts a season */
export const DEFAULT_RATING: Rating = { mu: 25, sigma: 25 / 3 };

/** how much luck is in one game: a skill gap of beta wins about 76% of the time */
const BETA = 25 / 6;
/** uncertainty added before each game, so a rating never stops moving */
export const TAU = 25 / 300;
/** keeps sigma above zero however many games are played */
const EPSILON = 1e-4;

/** rates one game with the Plackett-Luce model (Weng and Lin, 2011): teams of one or more, rank 1 is best, equal ranks are ties */
export function rate(teams: Rating[][], ranks: number[], tau = TAU): Rating[][] {
  if (ranks.length !== teams.length) throw new Error('rate: one rank per team');
  // tau joins sigma in quadrature, as in openskill
  const players = teams.map((team) => team.map((p) => ({ mu: p.mu, sigma: Math.sqrt(p.sigma * p.sigma + tau * tau) })));
  // one team alone learns nothing
  if (players.length < 2) return players;

  const teamMu = players.map((team) => team.reduce((sum, p) => sum + p.mu, 0));
  const teamSigmaSq = players.map((team) => team.reduce((sum, p) => sum + p.sigma * p.sigma, 0));
  const c = Math.sqrt(teamSigmaSq.reduce((sum, s) => sum + s + BETA * BETA, 0));
  // exp(mu / c), scaled by the best team so it can't overflow (only the ratios count)
  const top = Math.max(...teamMu);
  const strength = teamMu.map((mu) => Math.exp((mu - top) / c));
  // for each team q: the strength of every team that finished level with or behind it, and how many share its rank
  const sumQ = ranks.map((rq) => ranks.reduce((sum, r, s) => (r >= rq ? sum + strength[s] : sum), 0));
  const tied = ranks.map((rq) => ranks.filter((r) => r === rq).length);

  return players.map((team, i) => {
    let omega = 0;
    let delta = 0;
    for (let q = 0; q < players.length; q++) {
      if (ranks[q] > ranks[i]) continue;
      const p = strength[i] / sumQ[q];
      omega += ((q === i ? 1 : 0) - p) / tied[q];
      delta += (p * (1 - p)) / tied[q];
    }
    const gamma = Math.sqrt(teamSigmaSq[i]) / c;
    const teamOmega = (omega * teamSigmaSq[i]) / c;
    const teamDelta = (gamma * delta * teamSigmaSq[i]) / (c * c);
    // each player takes the team's change in proportion to how unsure their own rating is
    return team.map((p) => {
      const share = (p.sigma * p.sigma) / teamSigmaSq[i];
      return { mu: p.mu + share * teamOmega, sigma: p.sigma * Math.sqrt(Math.max(1 - share * teamDelta, EPSILON)) };
    });
  });
}
