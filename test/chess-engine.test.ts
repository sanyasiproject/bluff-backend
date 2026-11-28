import { describe, expect, it } from 'vitest';
import {
  BOT_LEVELS, CHESS_VARIANTS, ChessGame, Position, botMove, botThinkMs, clearEngine, openingCount, openingOf,
  reviewGame, search, winPercent, type BotLevel, type ChessVariant, type Move,
} from '../src/chess/index.js';
import { OPENINGS_A } from '../src/chess/openings-a.js';
import { OPENINGS_B } from '../src/chess/openings-b.js';
import { OPENINGS_C } from '../src/chess/openings-c.js';

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

// Brute force: can the side to move force a win within n moves?
function forcesWin(p: Position, n: number): boolean {
  for (const m of p.legalMoves()) {
    const q = p.play(m);
    const o = q.outcome();
    if (o && o.winner === p.turn) return true;
    if (o || n === 1) continue;
    const all = q.legalMoves().every((r) => {
      const z = q.play(r);
      const oz = z.outcome();
      return oz ? oz.winner === p.turn : forcesWin(z, n - 1);
    });
    if (all) return true;
  }
  return false;
}

const MATES: [string, number, string][] = [
  ['6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1', 1, 'Rd8#'],
  ['r1b2k1r/ppp1bppp/8/1B1Q4/5q2/2P5/PPP2PPP/R3R1K1 w - - 1 1', 2, 'Qd8+'],
  ['6k1/pp4p1/2p5/2bp4/8/P5Pb/1P3rrP/2BRRN1K b - - 0 1', 2, 'Rg1+'],
  ['kbK5/pp6/1P6/8/8/8/8/R7 w - - 0 1', 2, 'Ra6'],
  ['2r3k1/p4p2/3Rp2p/1p2P1pK/8/1P4P1/P3Q2P/1q6 b - - 0 1', 3, 'Qg6+'],
];

describe('search', () => {
  for (const [fen, n, san] of MATES) {
    it(`finds mate in ${n}: ${fen}`, () => {
      clearEngine();
      const p = Position.fromFen(fen, 'standard');
      const [top] = search(p, [], { maxMs: 4000 });
      expect(top.mate).toBe(n);
      expect(p.san(top.moves[0])).toBe(san);
      expect(forcesWin(p, n)).toBe(true);
      if (n > 1) expect(forcesWin(p, n - 1)).toBe(false);
    }, 20000);
  }

  it('does not leave pieces hanging', () => {
    const fens = [
      'rnbqkbnr/ppp1pppp/8/3p4/4Q3/8/PPPP1PPP/RNB1KBNR w KQkq - 0 3',
      'rnbqkb1r/pppppppp/5n2/4P3/8/8/PPPP1PPP/RNBQKBNR b KQkq - 0 2',
      'r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/8/PPPP1PPP/RNBQK1NR w KQkq - 2 3',
      'r2qkbnr/ppp2ppp/2np4/4p3/2B1P1b1/2N2N2/PPPP1PPP/R1BQK2R w KQkq - 2 5',
    ];
    for (const fen of fens) {
      clearEngine();
      const p = Position.fromFen(fen, 'standard');
      const [top] = search(p, [], { maxMs: 400 });
      const q = p.play(top.moves[0]);
      clearEngine();
      const [reply] = search(q, [], { maxDepth: 4 });
      expect(reply.scoreCp ?? 0).toBeLessThan(150);
    }
  });

  it('respects time and node limits, multi-PV and progress callbacks', () => {
    clearEngine();
    const p = Position.start('standard');
    const t = Date.now();
    const depths: number[] = [];
    const lines = search(p, [], { maxMs: 200, multiPv: 3 }, (ls) => depths.push(ls[0].depth));
    expect(Date.now() - t).toBeLessThan(600);
    expect(lines).toHaveLength(3);
    expect(new Set(lines.map((l) => p.uci(l.moves[0]))).size).toBe(3);
    expect(depths.length).toBeGreaterThan(1);
    expect(depths).toEqual([...depths].sort((a, b) => a - b));
    const capped = search(p, [], { nodes: 3000 });
    expect(capped[0].moves.length).toBeGreaterThan(0);
  });

  it('plays legal moves at every level in every variant', () => {
    const rand = seeded(5);
    for (const { id } of CHESS_VARIANTS) {
      const g = new ChessGame(id, id === 'chess960' ? Position.start(id, 77).fen() : undefined);
      for (let i = 0; i < 16 && !g.outcome(); i++) {
        const level = ((i % 8) + 1) as BotLevel;
        const m = botMove(g.position(), g.keys(), level, rand, { maxMs: 40 });
        expect(g.position().isLegal(m)).toBe(true);
        g.play(m);
      }
    }
  });

  it('caps bot think time by the clock', () => {
    expect(botThinkMs(8)).toBe(BOT_LEVELS[7].ms);
    expect(botThinkMs(8, { clockMs: 60000, incMs: 0 })).toBeLessThanOrEqual(2000);
    expect(botThinkMs(8, { clockMs: 1500, incMs: 0 })).toBeLessThanOrEqual(30);
    expect(botThinkMs(1, { clockMs: 600000, incMs: 5000 })).toBe(BOT_LEVELS[0].ms);
  });

  it('level 8 beats level 1', () => {
    const variants: ChessVariant[] = ['standard', 'atomic', 'kingOfTheHill'];
    for (const v of variants) {
      const rand = seeded(v.length);
      const g = new ChessGame(v);
      while (!g.outcome() && g.ply < 300) {
        const level: BotLevel = g.position().turn === 'w' ? 8 : 1;
        g.play(botMove(g.position(), g.keys(), level, rand, { maxMs: 120 }));
      }
      expect(g.outcome()?.winner).toBe('w');
    }
  }, 120000);
});

describe('analysis and openings', () => {
  it('reviews a game with a blunder', () => {
    const g = new ChessGame('standard');
    for (const s of ['e4', 'e5', 'Qh5', 'Nc6', 'Bc4', 'Nf6', 'Qxf7#']) g.play(g.position().parseSan(s) as Move);
    const r = reviewGame(g, { msPerMove: 120 });
    expect(r.moves).toHaveLength(7);
    expect(r.moves[5].judgement).toBe('blunder');
    expect(r.moves[5].bestSan).not.toBe('Nf6');
    expect(r.moves[6].judgement).toBe('best');
    expect(r.evals).toHaveLength(8);
    expect(r.evals[7]).toBe(10000);
    expect(r.accuracy.w).toBeGreaterThan(r.accuracy.b);
    expect(r.acpl.b).toBeGreaterThan(r.acpl.w);
    expect(r.counts.b.blunder).toBe(1);
    expect(r.opening?.name).toBe("King's Pawn Game: Wayward Queen Attack");
  }, 30000);

  it('keeps accuracy and ACPL consistent per move and per side', () => {
    const games = [
      ['e4', 'e5', 'Qh5', 'Nc6', 'Bc4', 'Nf6', 'Qxf7#'],
      ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6', 'Bxc6', 'dxc6', 'Nxe5', 'Qd4', 'Nf3', 'Qxe4+', 'Kf1'],
      ['f3', 'e5', 'g4', 'Qh4#'],
    ];
    for (const sans of games) {
      const g = new ChessGame('standard');
      for (const s of sans) g.play(g.position().parseSan(s) as Move);
      const r = reviewGame(g, { msPerMove: 80 });
      for (const m of r.moves) {
        const white = m.ply % 2 === 1, sign = white ? 1 : -1;
        const clamp = (x: number) => Math.max(-1000, Math.min(1000, x));
        const loss = Math.max(0, clamp(sign * m.evalBefore) - clamp(sign * m.evalAfter));
        if (loss === 0) expect(m.accuracy).toBeGreaterThanOrEqual(99);
        if (loss >= 100) expect(m.accuracy).toBeLessThan(90);
        if (loss >= 300) expect(m.accuracy).toBeLessThan(60);
      }
      for (const side of ['w', 'b'] as const) {
        if (r.acpl[side] === 0) expect(r.accuracy[side]).toBeGreaterThanOrEqual(99);
        if (r.acpl[side] >= 50) expect(r.accuracy[side]).toBeLessThan(95);
        if (r.acpl[side] >= 200) expect(r.accuracy[side]).toBeLessThan(70);
      }
    }
  }, 60000);

  it('win percent is a centred logistic', () => {
    expect(winPercent(0)).toBe(50);
    expect(winPercent(300)).toBeGreaterThan(70);
    expect(winPercent(-300)).toBeLessThan(30);
    expect(winPercent(5000)).toBeCloseTo(winPercent(1000));
  });

  it('names openings by the longest known prefix', () => {
    expect(openingCount()).toBeGreaterThan(250);
    expect(openingOf(['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6'])).toEqual({ eco: 'C70', name: 'Ruy Lopez: Morphy Defense' });
    expect(openingOf(['e4', 'c5', 'Nf3', 'd6', 'd4', 'cxd4', 'Nxd4', 'Nf6', 'Nc3', 'a6', 'f3'])?.name).toBe('Sicilian Defense: Najdorf Variation');
    expect(openingOf(['d4', 'Nf6', 'c4', 'g6', 'Nc3', 'd5'])?.eco).toBe('D80');
    expect(openingOf([])).toBeUndefined();
  });

  it('every opening line is legal SAN', () => {
    for (const line of [OPENINGS_A, OPENINGS_B, OPENINGS_C].join('\n').split('\n')) {
      const moves = line.split('|')[2].split(' ');
      let p = Position.start('standard');
      for (const s of moves) {
        const m = p.parseSan(s);
        expect(m, `${line} at ${s}`).toBeDefined();
        expect(p.san(m as Move)).toBe(s);
        p = p.play(m as Move);
      }
    }
  });
});
