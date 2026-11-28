import { launchOf, simulate, startCoins, type CarromCoin, type CarromSide } from '../src/carrom/index.js';

/** a fixed run of shots from every side, each from the board the last one left: the golden file's source */
export function goldenShots() {
  const shots: [CarromSide, number, number, number, number][] = [
    [0, 0.5, 0, 1, 1], [2, 0.3, 0.2, 1, 0.8], [1, 0.7, -0.3, 1, 0.6], [3, 0.5, 0.1, 1, 0.9],
    [0, 0.1, 0.5, 1, 0.7], [2, 0.9, -0.4, 1, 1], [1, 0.45, 0, 1, 0.4], [3, 0.2, 0.6, 1, 0.75],
    [0, 0.8, -0.2, 1, 0.55], [2, 0.6, 0.05, 1, 0.95], [1, 0.33, 0.25, 1, 0.85], [3, 0.66, -0.15, 1, 0.65],
  ];
  let coins: CarromCoin[] = startCoins();
  return shots.map(([side, x, dx, dy, power]) => {
    const r = simulate(coins, launchOf(side, x, dx, dy, power));
    coins = r.coins;
    return { side, x, dx, dy, power, ms: r.ms, pocketed: r.pocketed, firstHit: r.firstHit, striker: r.striker, events: r.events.length, coins: r.coins };
  });
}
