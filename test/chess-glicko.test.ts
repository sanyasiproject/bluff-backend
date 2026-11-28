import { describe, expect, it } from 'vitest';
import { agedRd, glicko2, rateGame } from '../src/games/chess/glicko.js';
import { CHESS_START_RATING, chessClockOf, chessNewRating, chessPerfOf, chessProvisional, chessRatingText, chessSpeedOf } from '../src/types.js';

describe('Glicko-2', () => {
  it("matches Glickman's worked example", () => {
    const out = glicko2(
      { r: 1500, rd: 200, vol: 0.06 },
      [
        { opp: { r: 1400, rd: 30 }, score: 1 },
        { opp: { r: 1550, rd: 100 }, score: 0 },
        { opp: { r: 1700, rd: 300 }, score: 0 },
      ],
      0.5,
    );
    expect(out.r).toBeCloseTo(1464.06, 1);
    expect(out.rd).toBeCloseTo(151.52, 1);
    expect(out.vol).toBeCloseTo(0.05999, 4);
  });

  it('starts everyone at 800 provisional and moves a first game a lot, both ways evenly', () => {
    const fresh = chessNewRating();
    expect(fresh.r).toBe(CHESS_START_RATING);
    expect(chessRatingText(fresh)).toBe('800?');
    const out = rateGame(fresh, fresh, 1);
    expect(out.w.r).toBeGreaterThan(1000);
    expect(out.w.r - 800).toBeCloseTo(800 - out.b.r, 6);
    expect(out.w.rd).toBeLessThan(500);
    expect(out.w.rd).toBeGreaterThanOrEqual(45);
    // a draw between equals moves nothing
    expect(rateGame(fresh, fresh, 0.5).w.r).toBeCloseTo(800, 6);
  });

  it('settles: an established rating moves little and RD never drops under 45', () => {
    let a = { r: 1500, rd: 50, vol: 0.06 };
    for (let i = 0; i < 50; i++) a = rateGame(a, { r: 1500, rd: 50, vol: 0.06 }, 1).w;
    expect(a.rd).toBeGreaterThanOrEqual(45);
    const once = rateGame({ r: 1500, rd: 50, vol: 0.06 }, { r: 1500, rd: 50, vol: 0.06 }, 1);
    expect(once.w.r - 1500).toBeLessThan(10);
    expect(chessProvisional(110)).toBe(false);
    expect(chessProvisional(111)).toBe(true);
  });

  it('grows RD back with time away, capped at 500', () => {
    const r = { rd: 60, vol: 0.06, updatedAt: 1, games: 10 };
    expect(agedRd(r, 1)).toBeCloseTo(60, 6);
    expect(agedRd(r, 365 * 86_400_000)).toBeGreaterThan(60);
    expect(agedRd({ ...r, vol: 0.1 }, 1e15)).toBe(500);
  });
});

describe('chess time controls and perfs', () => {
  it('picks the speed the Lichess way and the perf per variant', () => {
    expect(chessSpeedOf('1+0')).toBe('bullet');
    expect(chessSpeedOf('2+1')).toBe('bullet');
    expect(chessSpeedOf('3+0')).toBe('blitz');
    expect(chessSpeedOf('5+3')).toBe('blitz');
    expect(chessSpeedOf('10+0')).toBe('rapid');
    expect(chessSpeedOf('15+10')).toBe('rapid');
    expect(chessSpeedOf('30+0')).toBe('classical');
    expect(chessSpeedOf('none')).toBe('untimed');
    expect(chessClockOf('3+2')).toEqual({ initialMs: 180_000, incMs: 2000 });
    expect(chessClockOf('none')).toBeNull();
    expect(chessPerfOf('standard', '5+0')).toBe('blitz');
    expect(chessPerfOf('atomic', '1+0')).toBe('atomic');
    expect(chessPerfOf('chess960', '30+20')).toBe('chess960');
  });
});
