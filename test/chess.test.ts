import { beforeEach, describe, expect, it } from 'vitest';
import { ChessTable, CHESS_TIMING, forgetRematches } from '../src/games/chess/game.js';
import { chessModule } from '../src/games/chess/module.js';
import type { GameConfig } from '../src/types.js';
import { parseConfig } from '../src/validate.js';

const cfg = (opts: Record<string, string | number>): GameConfig => parseConfig({ decks: 1, bluffRule: 'one', game: 'chess', opts });
const W = 'p1';
const B = 'p2';

/** a table with p1 white (host picks white) and a hand-moved clock */
function table(opts: Record<string, string | number> = {}, fen?: string, bots: string[] = []) {
  const g = new ChessTable([W, B], cfg({ color: 'white', ...opts }), (n) => n - 1, bots, fen);
  let t = 1_000_000;
  g.now = () => t;
  g.seat([
    { id: W, userId: 'aaaaaaaaaaaaaaaaaaaaaaaa', name: 'Asha', bot: bots.includes(W), host: true },
    { id: B, userId: 'bbbbbbbbbbbbbbbbbbbbbbbb', name: 'Bilal', bot: bots.includes(B), host: false },
  ]);
  return { g, tick: (ms: number) => (t += ms) };
}

const mv = (g: ChessTable, uci: string) => chessModule.move(g, g.turnId!, { type: 'move', uci, ply: g.uci.length });
const playAll = (g: ChessTable, ucis: string) => ucis.split(' ').forEach((u) => mv(g, u));

// each table is a first game, not a rematch with colours swapped
beforeEach(() => forgetRematches());

describe('chess moves', () => {
  it('takes legal moves in turn and refuses illegal, out-of-turn and stale ones', () => {
    const { g } = table();
    expect(g.colors).toEqual({ w: W, b: B });
    expect(() => chessModule.move(g, B, { type: 'move', uci: 'e7e5', ply: 0 })).toThrow('Not your turn');
    expect(() => chessModule.move(g, W, { type: 'move', uci: 'e2e5', ply: 0 })).toThrow('Illegal move');
    expect(() => chessModule.move(g, W, { type: 'move', uci: 'zz', ply: 0 })).toThrow('Invalid move');
    expect(() => chessModule.move(g, W, { type: 'move', uci: 'e2e4', ply: 3 })).toThrow('The position has changed');
    expect(() => chessModule.move(g, 'x', { type: 'move', uci: 'e2e4', ply: 0 })).toThrow("You're not playing this game");
    const ev = mv(g, 'e2e4');
    expect(ev).toEqual([{ kind: 'chess', ev: { type: 'move', playerId: W, uci: 'e2e4', san: 'e4', ply: 1 } }]);
    const v = g.view();
    expect(v).toMatchObject({ moves: ['e2e4'], sans: ['e4'], turn: 'b', lastMove: 'e2e4', players: { w: W, b: B }, status: 'playing', perf: 'rapid', rated: false });
    expect(v.fen.startsWith('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b')).toBe(true);
    expect(g.turnId).toBe(B);
  });

  it("fool's mate ends the game for black, with places and tallies", () => {
    const { g } = table();
    playAll(g, 'f2f3 e7e5 g2g4');
    const ev = mv(g, 'd8h4');
    expect(ev.at(-1)).toEqual({ kind: 'gameOver', loserId: W });
    expect(g.view()).toMatchObject({ status: 'over', result: { winner: 'b', reason: 'checkmate' } });
    expect(g.winners()).toEqual([B]);
    expect(g.losers()).toEqual([W]);
    expect(g.placeOf(B)).toBe(1);
    expect(chessModule.tallies(g, B)).toEqual({ moves: 2, mates: 1 });
    expect(chessModule.describe(g, ev.at(-1)!, (id) => (id === B ? 'Bilal' : 'Asha'))).toEqual(['over', 'Checkmate. Bilal wins with Black 🎉']);
    expect(g.pgn({ w: 'Asha', b: 'Bilal' })).toContain('1. f3 e5 2. g4 Qh4# 0-1');
  });

  it('draws by threefold repetition and by stalemate on their own', () => {
    const a = table().g;
    playAll(a, 'g1f3 g8f6 f3g1 f6g8 g1f3 g8f6 f3g1 f6g8');
    expect(a.result).toEqual({ winner: null, reason: 'threefold' });
    expect(a.winners()).toEqual([]);
    expect(a.placeOf(W)).toBe(1);
    const s = table().g;
    playAll(s, 'e2e3 a7a5 d1h5 a8a6 h5a5 h7h5 h2h4 a6h6 a5c7 f7f6 c7d7 e8f7 d7b7 d8d3 b7b8 d3h7 b8c8 f7g6 c8e6');
    expect(s.result).toEqual({ winner: null, reason: 'stalemate' });
  });
});

describe('chess clocks', () => {
  it('starts after both first moves, adds the increment and flags on time', () => {
    const { g, tick } = table({ time: '3+2' });
    expect(g.view().clock).toEqual({ w: 180_000, b: 180_000, runningSince: null, inc: 2000 });
    tick(5000);
    mv(g, 'e2e4');
    tick(7000);
    mv(g, 'e7e5');
    // no time used and no increment before both have moved
    expect(g.left).toEqual({ w: 180_000, b: 180_000 });
    expect(g.view().abortAt).toBeNull();
    tick(10_000);
    mv(g, 'g1f3');
    expect(g.left!.w).toBe(180_000 - 10_000 + 2000);
    expect(g.timeLeft('b')).toBe(180_000);
    tick(1000);
    expect(g.timeLeft('b')).toBe(179_000);
    const clock = chessModule.clock(g)!;
    expect(clock.endsAt).toBe(g.now() + 179_000);
    expect(clock.key).toBeDefined();
    expect(g.checkTimers()).toEqual([]);
    tick(179_000);
    expect(g.flagDue()).toBe(true);
    // a move after the flag fell doesn't count
    const ev = mv(g, 'b8c6');
    expect(ev).toEqual([{ kind: 'gameOver', loserId: B }]);
    expect(g.result).toEqual({ winner: 'w', reason: 'timeout' });
    expect(chessModule.clock(g)).toBeNull();
  });

  it('a flag against a side that could never mate is a draw', () => {
    const { g, tick } = table({ time: '1+0' }, 'k7/8/8/8/8/8/7q/K7 w - - 0 1');
    playAll(g, 'a1b1');
    // set by hand: the clock runs with black to move
    expect(g.over).toBe(false);
    g.left = { w: 60_000, b: 60_000 };
    g.runningSince = g.now();
    g.abortAt = null;
    tick(61_000);
    // black's flag: white has a lone king and can't win
    g.checkTimers();
    expect(g.result).toEqual({ winner: null, reason: 'timeout' });
  });

  it('aborts when the first move never comes, and abort works only before both have moved', () => {
    const { g, tick } = table({ time: '5+0' });
    expect(g.abortAt).toBe(g.now() + CHESS_TIMING.firstMoveMs.blitz);
    expect(chessModule.clock(g)!.endsAt).toBe(g.abortAt);
    tick(CHESS_TIMING.firstMoveMs.blitz);
    expect(g.checkTimers()).toEqual([{ kind: 'gameOver', loserId: null }]);
    expect(g.result).toEqual({ winner: null, reason: 'abort' });
    expect(g.aborted).toBe(true);
    expect(g.winners()).toEqual([]);
    const h = table({ time: '5+0' }).g;
    mv(h, 'e2e4');
    expect(chessModule.move(h, B, { type: 'abort' })).toEqual([{ kind: 'gameOver', loserId: null }]);
    const late = table().g;
    playAll(late, 'e2e4 e7e5');
    expect(() => chessModule.move(late, W, { type: 'abort' })).toThrow('Too late to abort');
    // untimed games have no first-move limit
    expect(table({ time: 'none' }).g.abortAt).toBeNull();
  });
});

describe('chess offers', () => {
  it('draw: offer, decline by moving, offer again and accept', () => {
    const { g } = table();
    expect(() => chessModule.move(g, W, { type: 'draw', offer: true })).toThrow('Make a move first');
    playAll(g, 'e2e4 e7e5');
    expect(chessModule.move(g, W, { type: 'draw', offer: true })[0]).toMatchObject({ ev: { offer: 'draw', answer: 'ask' } });
    expect(g.view().drawOffer).toBe('w');
    mv(g, 'g1f3');
    // white's own move keeps white's offer; black moving declines it
    expect(g.view().drawOffer).toBe('w');
    mv(g, 'b8c6');
    expect(g.view().drawOffer).toBeUndefined();
    chessModule.move(g, B, { type: 'draw', offer: true });
    expect(chessModule.move(g, W, { type: 'draw', offer: false })[0]).toMatchObject({ ev: { answer: 'no' } });
    chessModule.move(g, B, { type: 'draw', offer: true });
    const ev = chessModule.move(g, W, { type: 'draw', offer: true });
    expect(ev.at(-1)).toEqual({ kind: 'gameOver', loserId: null });
    expect(g.result).toEqual({ winner: null, reason: 'agreement' });
  });

  it('takeback: one ply when I moved last, two when they replied; refused in rated games', () => {
    const { g } = table();
    playAll(g, 'e2e4 e7e5 g1f3');
    chessModule.move(g, W, { type: 'takeback' });
    expect(g.view().takebackOffer).toBe('w');
    const ev = chessModule.move(g, B, { type: 'takeback', accept: true });
    expect(ev.at(-1)).toEqual({ kind: 'chess', ev: { type: 'takeback', plies: 1 } });
    expect(g.uci).toEqual(['e2e4', 'e7e5']);
    expect(g.turnId).toBe(W);
    // black asks on white's turn: back to black's move, one ply
    chessModule.move(g, B, { type: 'takeback' });
    chessModule.move(g, W, { type: 'takeback', accept: true });
    expect(g.uci).toEqual(['e2e4']);
    // white asks now, on black's turn after one white move: one ply again; black says no
    chessModule.move(g, W, { type: 'takeback' });
    expect(chessModule.move(g, B, { type: 'takeback', accept: false })[0]).toMatchObject({ ev: { answer: 'no' } });
    expect(g.uci).toEqual(['e2e4']);
    mv(g, 'e7e5');
    chessModule.move(g, W, { type: 'takeback' });
    chessModule.move(g, B, { type: 'takeback', accept: true });
    // white asked on white's turn: two plies, back to the start
    expect(g.uci).toEqual([]);
    expect(g.view().fen).toBe(g.initialFen);
    const r = table({ rated: 'yes', time: '5+0' }).g;
    expect(r.rated).toBe(true);
    mv(r, 'e2e4');
    expect(() => chessModule.move(r, W, { type: 'takeback' })).toThrow('No takebacks in rated games');
  });

  it('a bot answers: takebacks yes, draws no', () => {
    const { g } = table({}, undefined, [B]);
    playAll(g, 'e2e4 e7e5');
    chessModule.move(g, W, { type: 'draw', offer: true });
    const step = chessModule.auto(g)!;
    expect(step).not.toBeNull();
    step.run();
    expect(g.drawOffer).toBeNull();
    chessModule.move(g, W, { type: 'takeback' });
    chessModule.auto(g)!.run();
    expect(g.uci).toEqual([]);
    expect(chessModule.auto(g)).toBeNull();
  });

  it('resign, leaving and kicks', () => {
    const a = table().g;
    playAll(a, 'e2e4 e7e5');
    expect(chessModule.move(a, B, { type: 'resign' }).at(-1)).toEqual({ kind: 'gameOver', loserId: B });
    expect(a.result).toEqual({ winner: 'w', reason: 'resign' });
    const b = table().g;
    mv(b, 'e2e4');
    b.leave(B);
    expect(b.result?.reason).toBe('abort');
    const c = table().g;
    playAll(c, 'e2e4 e7e5');
    c.leave(W);
    expect(c.result).toEqual({ winner: 'b', reason: 'resign' });
    expect(c.losers()).toEqual([W]);
    const d = table().g;
    playAll(d, 'e2e4 e7e5');
    d.removePlayer(B);
    expect(d.aborted).toBe(true);
    expect(d.winners()).toEqual([]);
  });
});

describe('chess variant endings through the module', () => {
  const cases: { variant: string; fen?: string; moves: string; result: { winner: 'w' | 'b' | null; reason: string } }[] = [
    { variant: 'kingOfTheHill', moves: 'e2e4 a7a6 e1e2 a6a5 e2d3 a5a4 d3d4', result: { winner: 'w', reason: 'kingOfTheHill' } },
    { variant: 'threeCheck', moves: 'e2e4 e7e5 d1h5 b8c6 h5f7 e8f7 f1c4 d7d5 c4d5', result: { winner: 'w', reason: 'threeCheck' } },
    { variant: 'crazyhouse', fen: 'k7/8/1K6/8/8/8/8/8[Q] w - - 0 1', moves: 'Q@a7', result: { winner: 'w', reason: 'checkmate' } },
    { variant: 'atomic', fen: 'k7/1p6/8/8/8/8/8/KR6 w - - 0 1', moves: 'b1b7', result: { winner: 'w', reason: 'atomicExplosion' } },
    { variant: 'antichess', fen: '8/8/8/8/8/8/p7/1R6 b - - 0 1', moves: 'a2b1q', result: { winner: 'w', reason: 'variantWin' } },
    { variant: 'horde', fen: '4k3/8/8/8/8/8/3P4/4q3 b - - 0 1', moves: 'e1d2', result: { winner: 'b', reason: 'hordeDestroyed' } },
    { variant: 'racingKings', fen: '8/6K1/8/8/8/8/k7/8 w - - 0 1', moves: 'g7g8', result: { winner: 'w', reason: 'raceFinished' } },
  ];
  for (const c of cases) {
    it(`${c.variant}: ${c.result.reason}`, () => {
      const { g } = table({ variant: c.variant }, c.fen);
      playAll(g, c.moves);
      expect(g.over).toBe(true);
      expect(g.result).toEqual(c.result);
      expect(g.view().result).toEqual(c.result);
    });
  }

  it('Chess960 starts from a shuffled back rank and plays', () => {
    const { g } = table({ variant: 'chess960' });
    expect(g.initialFen).toMatch(/^[rnbqk]{8}\/p{8}\/8\/8\/8\/8\/P{8}\/[RNBQK]{8} w /);
    mv(g, g.position().uci(g.position().legalMoves()[0]));
    expect(g.uci).toHaveLength(1);
    expect(g.perf).toBe('chess960');
  });

  it('three-check and crazyhouse views carry checks and pockets', () => {
    const t = table({ variant: 'threeCheck' }).g;
    playAll(t, 'e2e4 e7e5 d1h5 b8c6 h5f7');
    expect(t.view().checks).toEqual({ w: 1, b: 0 });
    const z = table({ variant: 'crazyhouse' }).g;
    playAll(z, 'e2e4 d7d5 e4d5');
    expect(z.view().pockets?.w).toMatchObject({ p: 1 });
  });
});
