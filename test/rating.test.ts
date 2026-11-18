import { describe, expect, it } from 'vitest';
import { DEFAULT_RATING, rate, TAU, type Rating } from '../src/rating.js';

const r = DEFAULT_RATING;
const solo = (...ratings: Rating[]) => ratings.map((x) => [x]);
/** each team's first player */
const firsts = (out: Rating[][]) => out.map((t) => t[0]);
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

/** expects every mu and sigma to match to 9 decimals */
function close(out: Rating[][], want: [number, number][][]) {
  expect(out.map((t) => t.length)).toEqual(want.map((t) => t.length));
  out.forEach((team, i) =>
    team.forEach((p, j) => {
      expect(p.mu).toBeCloseTo(want[i][j][0], 9);
      expect(p.sigma).toBeCloseTo(want[i][j][1], 9);
    }),
  );
}

describe('Plackett-Luce rating', () => {
  it("matches openskill's Plackett-Luce numbers (tau left out)", () => {
    close(rate(solo(r, r), [1, 2], 0), [[[27.63523138347365, 8.065506316323548]], [[22.36476861652635, 8.065506316323548]]]);
    close(rate(solo(r, r, r), [1, 2, 3], 0), [
      [[27.868876552746237, 8.204837030780652]],
      [[25.717219138186557, 8.057829747583874]],
      [[21.413904309067206, 8.057829747583874]],
    ]);
    // teams of 3, 1 and 2 players, finishing in that order
    const three: [number, number] = [25.939870821784513, 8.247641552260456];
    const two: [number, number] = [21.84646897330287, 8.213058173195341];
    close(rate([[r, r, r], [r], [r, r]], [1, 2, 3], 0), [[three, three, three], [[27.21366020491262, 8.274321317985242]], [two, two]]);
  });

  it('moves the winner up and the loser down, and both become surer', () => {
    const [win, lose] = firsts(rate(solo(r, r), [1, 2]));
    expect(win.mu).toBeGreaterThan(r.mu);
    expect(lose.mu).toBeLessThan(r.mu);
    expect(win.mu - r.mu).toBeCloseTo(r.mu - lose.mu, 9);
    expect(win.sigma).toBeLessThan(r.sigma);
    expect(lose.sigma).toBeLessThan(r.sigma);
    // the order of the teams in the list doesn't matter, only the ranks
    const [lose2, win2] = firsts(rate(solo(r, r), [2, 1]));
    expect(win2).toEqual(win);
    expect(lose2).toEqual(lose);
  });

  it('adds tau to sigma before rating, so a sure rating can still move', () => {
    const sure = { mu: 30, sigma: 0.01 };
    const [after] = firsts(rate(solo(sure, sure), [1, 2]));
    expect(after.mu).toBeGreaterThan(30);
    expect(after.sigma).toBeGreaterThan(0.01);
    expect(after.sigma).toBeLessThan(Math.sqrt(0.01 ** 2 + TAU ** 2));
    // tau = 0 leaves it almost still
    expect(firsts(rate(solo(sure, sure), [1, 2], 0))[0].mu - 30).toBeLessThan(1e-4);
  });

  it('handles ties: equal players who tie keep their skill and only grow surer', () => {
    const [a, b] = firsts(rate(solo(r, r), [1, 1]));
    expect(a.mu).toBeCloseTo(25, 12);
    expect(b.mu).toBeCloseTo(25, 12);
    expect(a.sigma).toBeLessThan(r.sigma);
    // two sharing last place get the same result, between 2nd and 3rd of an untied game
    const [first, tieA, tieB] = firsts(rate(solo(r, r, r), [1, 2, 2]));
    const ordered = firsts(rate(solo(r, r, r), [1, 2, 3]));
    expect(tieA).toEqual(tieB);
    expect(first.mu).toBeCloseTo(ordered[0].mu, 12);
    expect(tieA.mu).toBeLessThan(ordered[1].mu);
    expect(tieA.mu).toBeGreaterThan(ordered[2].mu);
    // a tied stronger player gives some skill to the weaker one
    const [strong, weak] = firsts(rate(solo({ mu: 30, sigma: 5 }, { mu: 20, sigma: 5 }), [1, 1]));
    expect(strong.mu).toBeLessThan(30);
    expect(weak.mu).toBeGreaterThan(20);
  });

  it('orders 3 to 5 players by where they finished, and equal players share nothing out of thin air', () => {
    for (let n = 3; n <= 5; n++) {
      const out = firsts(rate(solo(...Array.from({ length: n }, () => r)), Array.from({ length: n }, (_, i) => i + 1)));
      for (let i = 1; i < n; i++) expect(out[i].mu).toBeLessThan(out[i - 1].mu);
      expect(out[0].mu).toBeGreaterThan(25);
      expect(out[n - 1].mu).toBeLessThan(25);
      // with equal sigmas the skill gained equals the skill lost
      expect(sum(out.map((p) => p.mu - 25))).toBeCloseTo(0, 9);
      expect(out.every((p) => p.sigma < r.sigma)).toBe(true);
    }
  });

  it('rewards an upset more than an expected win', () => {
    const strong = { mu: 32, sigma: 4 };
    const weak = { mu: 20, sigma: 4 };
    const [expected] = firsts(rate(solo(strong, weak), [1, 2]));
    const [, upset] = firsts(rate(solo(strong, weak), [2, 1]));
    expect(upset.mu - weak.mu).toBeGreaterThan(expected.mu - strong.mu);
    expect(expected.mu - strong.mu).toBeGreaterThan(0);
  });

  it('rates teams: partners move together, the less sure partner moves more', () => {
    const unsure = { mu: 25, sigma: 8 };
    const sure = { mu: 25, sigma: 2 };
    const [[a, b], [c, d]] = rate([[unsure, sure], [r, r]], [1, 2]);
    expect(a.mu).toBeGreaterThan(25);
    expect(b.mu).toBeGreaterThan(25);
    expect(a.mu - 25).toBeGreaterThan(b.mu - 25);
    expect(c.mu).toBeLessThan(25);
    expect(c).toEqual(d);
    // two 2v2 winners tied at rank 1 against two players who didn't finish
    const solo2v2 = firsts(rate(solo(r, r, r, r), [1, 1, 3, 3]));
    expect(solo2v2[0]).toEqual(solo2v2[1]);
    expect(solo2v2[2]).toEqual(solo2v2[3]);
    expect(solo2v2[0].mu).toBeGreaterThan(25);
    expect(solo2v2[2].mu).toBeLessThan(25);
  });

  it('settles over many games: the steady winner climbs, sigma shrinks but never to zero', () => {
    let [a, b] = [r, r];
    let last = r.sigma;
    for (let i = 0; i < 200; i++) {
      [a, b] = firsts(rate(solo(a, b), [1, 2]));
      expect(a.sigma).toBeLessThan(last);
      last = a.sigma;
    }
    expect(a.mu).toBeGreaterThan(45);
    expect(b.mu).toBeLessThan(5);
    for (const p of [a, b]) expect(Number.isFinite(p.mu) && Number.isFinite(p.sigma)).toBe(true);
    // two even players taking turns to win grow much surer of their skill, never fully sure
    let [c, d] = [r, r];
    for (let i = 0; i < 200; i++) [c, d] = firsts(rate(solo(c, d), i % 2 ? [2, 1] : [1, 2]));
    expect(Math.abs(c.mu - 25)).toBeLessThan(0.5);
    expect(Math.abs(d.mu - 25)).toBeLessThan(0.5);
    expect(c.sigma).toBeLessThan(2);
    expect(c.sigma).toBeGreaterThan(TAU);
  });

  it('keeps a single team as it was (plus tau), and needs one rank per team', () => {
    const [[only]] = rate([[r]], [1], 0);
    expect(only).toEqual(r);
    expect(() => rate(solo(r, r), [1])).toThrow();
  });
});
