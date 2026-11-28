import { describe, expect, it } from 'vitest';
import { CARROM, launchOf, simulate, strikerSpot, toBoard, toLocal, type CarromCoin } from '../src/carrom/index.js';
import { CarromGame } from '../src/games/carrom/game.js';
import { carromModule } from '../src/games/carrom/module.js';
import { boardPoints, resolveShot } from '../src/games/carrom/rules.js';
import type { CarromResult } from '../src/carrom/index.js';
import type { GameConfig } from '../src/types.js';

let clock = 1e12;
const now = () => clock;
const cfg = (mode: string, length = 'quick') => ({ game: 'carrom', botLevel: 'hard', opts: { mode, length } }) as unknown as GameConfig;
const game = (ids: string[], mode = 'classic', length = 'quick') => new CarromGame(ids, cfg(mode, length), (n) => 0 % n, [], () => 0.5, now);
const coin = (id: string, x: number, y: number): CarromCoin => ({ id, c: id === 'Q' ? 'q' : id[0] === 'W' ? 'w' : 'b', x, y });
/** a board with these coins far from every line we shoot along */
const parked = (ids: string[]) => ids.map((id, i) => coin(id, 0.62 + (i % 6) * 0.05, 0.4 + Math.floor(i / 6) * 0.05));

/** puts `id` on the line from the shooter's left baseline end to their far-left pocket and finds a power that drops it alone */
function sinkShot(g: CarromGame, shooter: string, id: string) {
  const side = g.sideOf(shooter);
  const [sx, sy] = strikerSpot(side, 0);
  const [px, py] = toBoard(side, CARROM.pocketAt, 1 - CARROM.pocketAt);
  g.coins = [...g.coins.filter((c) => c.id !== id), coin(id, sx + 0.55 * (px - sx), sy + 0.55 * (py - sy))];
  const [lu, lf] = toLocal(side, px, py);
  const [su, sf] = toLocal(side, sx, sy);
  const du = lu - su;
  const df = lf - sf;
  for (let p = 0.1; p <= 1; p += 0.02) {
    const r = simulate(g.coins, launchOf(side, 0, du, df, p));
    if (r.pocketed.length === 1 && r.pocketed[0] === id && !r.striker.pocketed) return { x: 0, dx: du, dy: df, power: p };
  }
  throw new Error('no power drops it');
}

const shoot = (g: CarromGame, id: string, s: { x: number; dx: number; dy: number; power: number }) => {
  const ev = g.shoot(id, s.x, s.dx, s.dy, s.power);
  clock = g.settleAt + 1;
  return ev;
};
const sink = (g: CarromGame, id: string, coinId: string) => shoot(g, id, sinkShot(g, id, coinId));
/** a soft nudge that touches a coin just ahead and drops nothing */
function nudge(g: CarromGame, id: string) {
  const [cx, cy] = toBoard(g.sideOf(id), 0.5 * (CARROM.baseFrom + CARROM.baseTo), CARROM.baseAt + 0.12);
  g.coins = [...g.coins.filter((c) => c.id !== 'B9'), coin('B9', cx, cy)];
  return shoot(g, id, { x: 0.5, dx: 0, dy: 1, power: 0.05 });
}

describe('Carrom rules (resolveShot)', () => {
  const res = (pocketed: string[], over: Partial<CarromResult> = {}): CarromResult => ({ coins: parked(['W1', 'W2', 'B1', 'B2']), pocketed, striker: { x: 0.5, y: 0.8, pocketed: false }, firstHit: 'W1', events: [], ms: 1000, ...over });
  const start = parked(['W1', 'W2', 'B1', 'B2', 'W3', 'Q']);

  it('own coin: shoot again; theirs: turn ends and they keep it', () => {
    expect(resolveShot('classic', 'a', 'w', start, { state: 'board', by: null }, res(['W3']))).toMatchObject({ again: true, kept: ['W3'], foul: null });
    expect(resolveShot('classic', 'a', 'w', start, { state: 'board', by: null }, res(['B3']))).toMatchObject({ again: false, given: ['B3'] });
    expect(resolveShot('classic', 'a', 'w', start, { state: 'board', by: null }, res(['B3', 'W3']))).toMatchObject({ again: true });
  });

  it('fouls: striker in or nothing touched; one of my pocketed coins comes back', () => {
    const s = parked(['W1', 'W2', 'B1', 'B2', 'Q']);
    const out = resolveShot('classic', 'a', 'w', s, { state: 'board', by: null }, res([], { striker: { x: 0, y: 0, pocketed: true } }));
    expect(out.foul).toBe('striker');
    expect(out.again).toBe(false);
    expect(out.returned).toHaveLength(1);
    expect(out.coins.some((c) => c.id === out.returned[0] && c.c === 'w')).toBe(true);
    expect(resolveShot('classic', 'a', 'w', s, { state: 'board', by: null }, res([], { firstHit: null })).foul).toBe('miss');
  });

  it('the queen: back before any coin of my own; pending, then covered or returned', () => {
    // nothing of mine pocketed yet: W1..W9 all on the board
    const all = parked(['W1', 'W2', 'W3', 'W4', 'W5', 'W6', 'W7', 'W8', 'W9', 'B1', 'Q']);
    const early = resolveShot('classic', 'a', 'w', all, { state: 'board', by: null }, res(['Q'], { coins: parked(['W1', 'W2', 'W3', 'W4', 'W5', 'W6', 'W7', 'W8', 'W9', 'B1']) }));
    expect(early.queenNote).toBe('returned');
    expect(early.coins.some((c) => c.id === 'Q')).toBe(true);
    const ok = resolveShot('classic', 'a', 'w', start, { state: 'board', by: null }, res(['Q']));
    expect(ok).toMatchObject({ queenNote: 'pocketed', again: true, queen: { state: 'pending', by: 'a' } });
    const cover = resolveShot('classic', 'a', 'w', parked(['W1', 'W2', 'B1', 'B2', 'W3']), { state: 'pending', by: 'a' }, res(['W3']));
    expect(cover).toMatchObject({ queenNote: 'covered', queen: { state: 'covered', by: 'a' } });
    const fail = resolveShot('classic', 'a', 'w', parked(['W1', 'W2', 'B1', 'B2']), { state: 'pending', by: 'a' }, res([]));
    expect(fail).toMatchObject({ queenNote: 'returned', queen: { state: 'board', by: null }, again: false });
    expect(fail.coins.some((c) => c.id === 'Q')).toBe(true);
    // the queen with my own coin in one shot: covered at once
    expect(resolveShot('classic', 'a', 'w', start, { state: 'board', by: null }, res(['Q', 'W3'])).queenNote).toBe('covered');
  });

  it('my last coin before the queen is covered is a foul and comes back', () => {
    const s = [coin('W9', 0.7, 0.4), coin('B1', 0.6, 0.4), coin('Q', 0.5, 0.5)];
    const out = resolveShot('classic', 'a', 'w', s, { state: 'board', by: null }, res(['W9'], { coins: [coin('B1', 0.6, 0.4), coin('Q', 0.5, 0.5)] }));
    expect(out.foul).toBe('lastCoin');
    expect(out.coins.some((c) => c.id === 'W9')).toBe(true);
    expect(out.cleared).toBeNull();
  });

  it('Classic board points: their coins left plus 3 for a queen the winner covered', () => {
    const left = parked(['B1', 'B2', 'B3']);
    expect(boardPoints(left, 'w', true)).toBe(6);
    expect(boardPoints(left, 'w', false)).toBe(3);
  });

  it('Freestyle: white 20, black 10, queen 50 once covered, foul −10, anything pocketed shoots again', () => {
    const s = parked(['W1', 'B1', 'Q', 'B2']);
    expect(resolveShot('freestyle', 'a', null, s, { state: 'board', by: null }, res(['W1', 'B1']))).toMatchObject({ points: 30, again: true });
    expect(resolveShot('freestyle', 'a', null, s, { state: 'board', by: null }, res(['Q', 'B1']))).toMatchObject({ points: 60, queenNote: 'covered' });
    expect(resolveShot('freestyle', 'a', null, s, { state: 'board', by: null }, res(['Q']))).toMatchObject({ points: 0, queenNote: 'pocketed', again: true });
    expect(resolveShot('freestyle', 'a', null, s, { state: 'board', by: null }, res(['B1'], { firstHit: null }))).toMatchObject({ points: 0, foul: 'miss', again: false });
    expect(resolveShot('freestyle', 'a', null, [coin('B1', 0.5, 0.5)], { state: 'board', by: null }, res(['B1'], { coins: [] })).cleared).toBe('all');
  });
});

describe('Carrom game', () => {
  it('2 players sit opposite; 1st is white and breaks; Classic with 3 is refused', () => {
    const g = game(['a', 'b']);
    expect([g.sideOf('a'), g.sideOf('b')]).toEqual([0, 2]);
    expect(g.colors!.get('a')).toBe('w');
    expect(g.turnId).toBe('a');
    expect(() => game(['a', 'b', 'c'])).toThrow(/Classic/);
    expect(() => carromModule.checkStart!(cfg('classic'), 3)).toThrow(/Freestyle/);
    expect(() => carromModule.checkStart!(cfg('freestyle'), 3)).not.toThrow();
    expect(game(['a', 'b', 'c'], 'freestyle').teams).toBeNull();
  });

  it('2v2: partners opposite share a colour and points; turns alternate sides', () => {
    const g = game(['a', 'b', 'c', 'd']);
    expect(g.teams).toEqual([['a', 'c'], ['b', 'd']]);
    expect([g.colors!.get('a'), g.colors!.get('c'), g.colors!.get('b')]).toEqual(['w', 'w', 'b']);
    expect([0, 1, 2, 3].map((i) => g.sideOf(['a', 'b', 'c', 'd'][i]))).toEqual([0, 1, 2, 3]);
    g.coins = parked(['W1', 'W2', 'B1', 'B2', 'Q']);
    nudge(g, 'a');
    expect(g.turnId).toBe('b');
    const v = g.view();
    expect(v.teams).toEqual([['a', 'c'], ['b', 'd']]);
  });

  it('shots: refused off turn, on a coin and while coins still roll', () => {
    const g = game(['a', 'b']);
    expect(() => g.shoot('b', 0.5, 0, 1, 0.5)).toThrow('Not your turn');
    g.coins = [coin('W1', ...strikerSpot(0, 0.5))];
    expect(() => g.shoot('a', 0.5, 0, 1, 0.5)).toThrow("can't sit on a coin");
    g.coins = parked(['W1', 'B1', 'Q', 'W2', 'B2']);
    g.shoot('a', 0.5, 0, 1, 0.3);
    if (g.turnId === 'a') expect(() => g.shoot('a', 0.5, 0, 1, 0.3)).toThrow('Wait');
  });

  it('own coin: again, kept near my seat; tallies count it', () => {
    const g = game(['a', 'b']);
    g.coins = parked(['W2', 'B1', 'B2', 'Q']);
    sink(g, 'a', 'W1');
    expect(g.last).toMatchObject({ pocketed: ['W1'], again: true, foul: null });
    expect(g.turnId).toBe('a');
    expect(g.view().pocketed.a).toEqual(['W1']);
    expect(carromModule.tallies(g, 'a')).toMatchObject({ pocketed: 1, fouls: 0 });
  });

  it("their coin: turn passes and it's theirs", () => {
    const g = game(['a', 'b']);
    g.coins = parked(['W2', 'W1', 'B2', 'Q']);
    sink(g, 'a', 'B1');
    expect(g.turnId).toBe('b');
    expect(g.view().pocketed.b).toEqual(['B1']);
  });

  it('a Classic board: queen covered, last coin in, points to the winner', () => {
    const g = game(['a', 'b']);
    g.coins = parked(['B1', 'B2', 'Q', 'W2']);
    // W1..W9 off except W1 and W2
    sink(g, 'a', 'Q');
    expect(g.queen).toMatchObject({ state: 'pending', by: 'a' });
    expect(g.view().last!.queen).toBe('pocketed');
    sink(g, 'a', 'W1');
    expect(g.queen).toMatchObject({ state: 'covered', by: 'a' });
    expect(carromModule.tallies(g, 'a').queens).toBe(1);
    sink(g, 'a', 'W2');
    expect(g.over).toBe(true);
    expect(g.results).toEqual([{ board: 1, winners: ['a'], points: 2 + 3 }]);
    expect(g.winners()).toEqual(['a']);
    expect(g.losers()).toEqual(['b']);
    expect(g.view().places).toEqual({ a: 1, b: 2 });
  });

  it('Classic full: a new board after the first, until 25 points', () => {
    const g = game(['a', 'b'], 'classic', 'full');
    g.coins = parked(['B1', 'B2', 'W2']);
    g.queen = { state: 'covered', by: 'a' };
    sink(g, 'a', 'W1');
    sink(g, 'a', 'W2');
    expect(g.over).toBe(false);
    expect(g.board).toBe(2);
    expect(g.coins).toHaveLength(19);
    expect(g.turnId).toBe('b');
    expect(g.scores.get('a')).toBe(5);
    g.scores.set('a', 24);
    g.coins = parked(['B1', 'W2']);
    g.queen = { state: 'covered', by: 'b' };
    g.turnId = 'a';
    sink(g, 'a', 'W2');
    expect(g.over).toBe(true);
    expect(g.scores.get('a')).toBe(25);
  });

  it('Freestyle: scores add up, a foul costs 10, the board ends when every coin is gone', () => {
    const g = game(['a', 'b', 'c'], 'freestyle');
    g.coins = parked(['B1']);
    sink(g, 'a', 'W1');
    expect(g.scores.get('a')).toBe(20);
    expect(g.turnId).toBe('a');
    sink(g, 'a', 'B1');
    expect(g.over).toBe(true);
    expect(g.scores.get('a')).toBe(30);
    expect(g.winners()).toEqual(['a']);
    const f = game(['a', 'b'], 'freestyle', 'full');
    f.coins = parked(['B1', 'B2']);
    f.shoot('a', 0.5, -1, 0.06, 0.05);
    clock = f.settleAt + 1;
    expect(f.last!.foul).toBe('miss');
    expect(f.scores.get('a')).toBe(-10);
    expect(f.turnId).toBe('b');
    expect(f.boards).toBe(3);
  });

  it('time out: a soft straight shot from the nearest free spot', () => {
    const g = game(['a', 'b']);
    const step = carromModule.auto(g)!;
    expect(step.delayMs).toBeGreaterThan(19_000);
    step.run();
    expect(g.last).toMatchObject({ auto: true, playerId: 'a', dx: 0, dy: 1, power: 0.3 });
  });

  it('walking out: 2 players, the other wins; 2v2, the other side wins', () => {
    const g = game(['a', 'b']);
    g.leave('b');
    expect(g.over).toBe(true);
    expect(g.winners()).toEqual(['a']);
    expect(g.losers()).toEqual(['b']);
    const t = game(['a', 'b', 'c', 'd']);
    t.leave('c');
    expect(t.winners()).toEqual(['b', 'd']);
    const k = game(['a', 'b']);
    k.removePlayer('b');
    expect(k.aborted).toBe(true);
  });

  it('the view carries the last shot to replay it on the phone', () => {
    const g = game(['a', 'b']);
    g.coins = parked(['W2', 'B1', 'Q']);
    const shot = sinkShot(g, 'a', 'W1');
    const before = g.coins.map((c) => ({ ...c }));
    g.shoot('a', shot.x, shot.dx, shot.dy, shot.power);
    const v = carromModule.view(g, 'b', true);
    if (v.kind !== 'carrom') throw new Error('kind');
    const last = v.carrom.last!;
    expect(last.before).toEqual(before);
    const again = simulate(last.before, launchOf(last.side, last.x, last.dx, last.dy, last.power));
    expect(again.pocketed).toEqual(last.pocketed);
    expect(again.coins).toEqual(v.carrom.coins);
    expect(v.carrom.settleAt).toBe(clock + last.ms + 700);
  });
});
