import { describe, expect, it } from 'vitest';
import { CHESS_VARIANTS, ChessGame, Position, chess960BackRank, parseSquare, type ChessVariant, type Move } from '../src/chess/index.js';
import { parseFen } from '../src/chess/core/fen.js';
import { perft } from '../src/chess/core/perft.js';
import { variantNum } from '../src/chess/variants.js';

function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PERFT: [ChessVariant, string, number[]][] = [
  ['standard', 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', [20, 400, 8902, 197281]],
  ['standard', 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1', [48, 2039, 97862]],
  ['standard', '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1', [14, 191, 2812, 43238]],
  ['standard', 'r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1', [6, 264, 9467]],
  ['standard', 'rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8', [44, 1486, 62379]],
  ['standard', 'r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 10', [46, 2079, 89890]],
  ['chess960', 'bqnb1rkr/pp3ppp/3ppn2/2p5/5P2/P2P4/NPP1P1PP/BQ1BNRKR w HFhf - 2 9', [21, 528, 12189]],
  ['chess960', '2nnrbkr/p1qppppp/8/1ppb4/6PP/3PP3/PPP2P2/BQNNRBKR w HEhe - 1 9', [21, 807, 18002]],
  ['chess960', 'b1q1rrkb/pppppppp/3nn3/8/P7/1PPP4/4PPPP/BQNNRKRB w GE - 1 9', [20, 479, 10471]],
  ['crazyhouse', 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR[] w KQkq - 0 1', [20, 400, 8902, 197281]],
  ['crazyhouse', '2k5/8/8/8/8/8/8/4K3[QRBNPqrbnp] w - - 0 1', [301, 75353]],
  ['atomic', 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', [20, 400, 8902, 197326]],
  ['atomic', '8/8/8/8/8/8/2k5/rR4KR w KQ - 0 1', [18, 180, 4364]],
  ['antichess', 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w - - 0 1', [20, 400, 8067, 153299]],
  ['antichess', '8/1p6/8/8/8/8/P7/8 w - - 0 1', [2, 4, 4, 3, 1, 0]],
  ['horde', 'rnbqkbnr/pppppppp/8/1PP2PP1/PPPPPPPP/PPPPPPPP/PPPPPPPP/PPPPPPPP w kq - 0 1', [8, 128, 1274, 23310]],
  ['horde', '4k3/pp4q1/3P2p1/8/P3PP2/PPP2r2/PPP5/PPPP4 b - - 0 1', [30, 241, 6633]],
  ['racingKings', '8/8/8/8/8/8/krbnNBRK/qrbnNBRQ w - - 0 1', [21, 421, 11264]],
  ['racingKings', '4brn1/2K2k2/8/8/8/8/8/8 w - - 0 1', [6, 33, 178, 3151]],
  ['threeCheck', 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 1+1 0 1', [48, 2039, 97848]],
  ['kingOfTheHill', 'rnbq1bnr/ppp2ppp/3k4/4p2Q/3PK3/8/PPP2PPP/RNB2BNR b - - 0 1', [0]],
];

describe('chess perft', () => {
  for (const [v, fen, counts] of PERFT) {
    it(`${v} ${fen}`, () => {
      const b = parseFen(fen, variantNum(v));
      counts.forEach((n, i) => expect(perft(b, i + 1)).toBe(n));
    });
  }
});

describe('chess960 starts', () => {
  it('numbers the standard setup 518 and every start is valid', () => {
    expect(chess960BackRank(518)).toBe('RNBQKBNR');
    const seen = new Set<string>();
    for (let i = 0; i < 960; i++) {
      const r = chess960BackRank(i);
      seen.add(r);
      expect(r.indexOf('R')).toBeLessThan(r.indexOf('K'));
      expect(r.lastIndexOf('R')).toBeGreaterThan(r.indexOf('K'));
      expect((r.indexOf('B') + r.lastIndexOf('B')) % 2).toBe(1);
    }
    expect(seen.size).toBe(960);
  });
  it('castles king-takes-rook in UCI and king to the g-file', () => {
    const p = Position.fromFen('bqnbrkrn/pppppppp/8/8/8/8/PPPPPPPP/BQNBRKRN w GEge - 0 1', 'chess960');
    const q = p;
    const c = q.parseUci('f1g1');
    expect(c).toBeDefined();
    expect(q.isCastle(c as Move)).toBe(true);
    expect(q.uci(c as Move)).toBe('f1g1');
    const after = q.play(c as Move);
    expect(after.pieceAt(parseSquare('g1') as number)?.role).toBe('k');
    expect(after.pieceAt(parseSquare('f1') as number)?.role).toBe('r');
  });
});

function randomGame(v: ChessVariant, rand: () => number, plies: number): ChessGame {
  const g = new ChessGame(v, v === 'chess960' ? Position.start(v, Math.floor(rand() * 960)).fen() : undefined);
  for (let i = 0; i < plies && !g.outcome(); i++) {
    const moves = g.position().legalMoves();
    g.play(moves[Math.floor(rand() * moves.length)]);
  }
  return g;
}

describe('round trips', () => {
  for (const { id } of CHESS_VARIANTS) {
    it(`FEN, SAN and UCI round-trip in ${id}`, () => {
      const rand = seeded(variantNum(id) + 7);
      for (let n = 0; n < 12; n++) {
        const g = randomGame(id, rand, 80);
        const sans = g.sanList(), ucis = g.uciList();
        let p = g.positionAt(0);
        for (let i = 0; i < g.moves.length; i++) {
          const fen = p.fen();
          const re = Position.fromFen(fen, id);
          expect(re.fen()).toBe(fen);
          expect(re.key()).toBe(p.key());
          expect(p.parseSan(sans[i])).toEqual(g.moves[i]);
          expect(p.parseUci(ucis[i])).toEqual(g.moves[i]);
          p = p.play(g.moves[i]);
        }
        const back = ChessGame.fromPgn(g.pgn({ White: 'a', Black: 'b' }));
        expect(back.game.variant).toBe(id);
        expect(back.game.uciList()).toEqual(ucis);
      }
    });
  }
});

const play = (p: Position, ...sans: string[]): Position =>
  sans.reduce((q, s) => {
    const m = q.parseSan(s);
    if (!m) throw new Error(`bad ${s} in ${q.fen()}`);
    return q.play(m);
  }, p);

describe('outcomes', () => {
  it('standard mate, stalemate and insufficient material', () => {
    const p = play(Position.start('standard'), 'f3', 'e5', 'g4', 'Qh4#');
    expect(p.outcome()).toEqual({ winner: 'b', reason: 'checkmate' });
    expect(Position.fromFen('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1', 'standard').outcome()).toEqual({ winner: null, reason: 'stalemate' });
    expect(Position.fromFen('8/8/8/4k3/8/8/8/4K2N w - - 0 1', 'standard').outcome()?.reason).toBe('insufficient');
    expect(Position.fromFen('8/8/8/4k3/8/8/8/4K2R w - - 0 1', 'standard').outcome()).toBeNull();
    expect(Position.fromFen('8/8/8/4k3/8/8/8/4K2R w - - 0 1', 'standard').hasInsufficientMaterial('b')).toBe(true);
  });
  it('threefold and fifty-move draws', () => {
    const g = new ChessGame('standard');
    for (const s of ['Nf3', 'Nf6', 'Ng1', 'Ng8', 'Nf3', 'Nf6', 'Ng1', 'Ng8']) g.play(g.position().parseSan(s) as Move);
    expect(g.outcome()).toEqual({ winner: null, reason: 'threefold' });
    const f = new ChessGame('standard', '8/8/8/4k3/8/8/8/4K2R w - - 99 80');
    f.play(f.position().parseSan('Rh2') as Move);
    expect(f.outcome()?.reason).toBe('fiftyMove');
  });
  it('king of the hill', () => {
    const p = play(Position.fromFen('8/8/8/8/8/3K4/8/7k w - - 0 1', 'kingOfTheHill'), 'Kd4');
    expect(p.outcome()).toEqual({ winner: 'w', reason: 'kingOfTheHill' });
    expect(p.legalMoves()).toHaveLength(0);
  });
  it('three-check', () => {
    const p = Position.fromFen('4k3/8/8/8/8/8/8/R3K3 w - - 0 1 +2+0', 'threeCheck');
    expect(p.checks()).toEqual({ w: 2, b: 0 });
    const q = play(p, 'Ra8+');
    expect(q.outcome()).toEqual({ winner: 'w', reason: 'threeCheck' });
    expect(q.fen().endsWith('+3+0')).toBe(true);
  });
  it('antichess forced captures, king promotion and losing everything wins', () => {
    const p = Position.fromFen('8/8/8/8/8/1p6/P7/8 w - - 0 1', 'antichess');
    expect(p.legalMoves().map((m) => p.san(m))).toEqual(['axb3']);
    expect(play(p, 'axb3').outcome()).toEqual({ winner: 'b', reason: 'variantWin' });
    const k = Position.fromFen('8/P7/8/8/8/8/8/7k w - - 0 1', 'antichess');
    expect(k.legalMoves().map((m) => k.san(m))).toContain('a8=K');
  });
  it('atomic explosions', () => {
    const p = Position.fromFen('4k3/4q3/8/8/8/8/4R3/4K3 w - - 0 1', 'atomic');
    const q = play(p, 'Rxe7');
    expect(q.outcome()).toEqual({ winner: 'w', reason: 'atomicExplosion' });
    const own = Position.fromFen('4k3/8/8/8/8/8/3qK3/8 w - - 0 1', 'atomic');
    expect(own.legalMoves().some((m) => own.isCapture(m))).toBe(false);
    const reloaded = Position.fromFen(q.fen(), 'atomic');
    expect(reloaded.fen()).toBe(q.fen());
    expect(reloaded.legalMoves()).toHaveLength(0);
    expect(reloaded.outcome()).toEqual({ winner: 'w', reason: 'atomicExplosion' });
    expect(() => Position.fromFen('8/8/8/8/8/8/8/8 w - - 0 1', 'atomic')).toThrow();
    expect(() => Position.fromFen('4k3/8/8/8/8/8/8/8 w - - 0 1', 'standard')).toThrow();
    expect(Position.fromFen('8/8/8/8/8/1p6/P7/8 w - - 0 1', 'antichess').legalMoves()).toHaveLength(1);
    expect(Position.start('horde').legalMoves()).toHaveLength(8);
    const touch = Position.fromFen('8/8/8/8/3kK3/8/8/r7 w - - 0 1', 'atomic');
    expect(touch.inCheck()).toBe(false);
  });
  it('horde: black wins by capturing every white piece', () => {
    const p = Position.fromFen('4k3/8/8/8/8/8/1Pr5/8 b - - 0 1', 'horde');
    expect(play(p, 'Rxb2').outcome()).toEqual({ winner: 'b', reason: 'hordeDestroyed' });
    const first = Position.fromFen('4k3/8/8/8/8/8/8/P7 w - - 0 1', 'horde');
    expect(first.legalMoves().map((m) => first.san(m)).sort()).toEqual(['a2', 'a3']);
  });
  it('racing kings goal, black reply and draw', () => {
    const win = play(Position.fromFen('8/1K6/8/8/8/8/k7/8 w - - 0 1', 'racingKings'), 'Kb8');
    expect(win.outcome()).toEqual({ winner: 'w', reason: 'raceFinished' });
    const reply = play(Position.fromFen('8/1K4k1/8/8/8/8/8/8 w - - 0 1', 'racingKings'), 'Kb8');
    expect(reply.outcome()).toBeNull();
    expect(play(reply, 'Kg8').outcome()).toEqual({ winner: null, reason: 'raceFinished' });
    const noCheck = Position.fromFen('8/8/8/8/8/8/k7/R6K w - - 0 1', 'racingKings');
    expect(noCheck.legalMoves().map((m) => noCheck.san(m))).not.toContain('Ra2');
  });
  it('crazyhouse drops block checks and pawns stay off the back ranks', () => {
    const p = Position.fromFen('4k3/8/8/8/8/8/8/r3K3[N] w - - 0 1', 'crazyhouse');
    const sans = p.legalMoves().map((m) => p.san(m));
    expect(sans).toContain('N@d1');
    const q = Position.fromFen('4k3/8/8/8/8/8/8/4K3[P] w - - 0 1', 'crazyhouse');
    const drops = q.legalMoves().filter((m) => m.drop);
    expect(drops).toHaveLength(48);
    const promo = play(Position.fromFen('4k3/P7/8/8/8/8/8/4K3[] w - - 0 1', 'crazyhouse'), 'a8=Q+');
    expect(promo.fen()).toContain('Q~');
    const after = play(Position.fromFen('4k3/Q~7/1r6/8/8/8/8/4K3[] b - - 0 1', 'crazyhouse'), 'Rb7', 'Qxb7');
    expect(after.pockets()?.w).toEqual({ r: 1 });
    const back = play(Position.fromFen('4k3/rQ~6/8/8/8/8/8/4K3[] b - - 0 1', 'crazyhouse'), 'Rxb7');
    expect(back.pockets()?.b).toEqual({ p: 1 });
  });
});
