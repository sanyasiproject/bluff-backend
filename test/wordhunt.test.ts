import { describe, expect, it } from 'vitest';
import { BLOCKED_WORDS } from '../src/games/wordhunt/blocklist.js';
import { botWords, COMMON_TIER } from '../src/games/wordhunt/brain.js';
import { dictionary, isWord, tierOf } from '../src/games/wordhunt/dictionary.js';
import { WordHuntGame } from '../src/games/wordhunt/game.js';
import { makeGrid, rollGrid, seeded, solve, WORDHUNT_MIN_WORDS } from '../src/games/wordhunt/grid.js';
import { parseWordHuntMove, wordhuntModule } from '../src/games/wordhunt/module.js';
import { WORDHUNT_COUNTDOWN_MS, WORDHUNT_REVEAL_MS, wordHuntPoints, wordHuntTouches, type BotLevel } from '../src/types.js';
import { parseConfig } from '../src/validate.js';

const cfg = (opts: object = {}, botLevel: BotLevel = 'normal') => ({ ...parseConfig({ decks: 1, bluffRule: 'one', game: 'wordhunt', opts }), botLevel });

// c a t s / o r e d / qu i n g / p l y m
const FIXED = ['c', 'a', 't', 's', 'o', 'r', 'e', 'd', 'qu', 'i', 'n', 'g', 'p', 'l', 'y', 'm'];
const P = { cat: [0, 1, 2], cats: [0, 1, 2, 3], rat: [5, 1, 2], rate: [5, 1, 2, 6], rated: [5, 1, 2, 6, 7], tea: [2, 6, 1], quiet: [8, 9, 6, 2] };

/** a game on the fixed grid with a clock the test moves */
function setUp(ids = ['A', 'B'], bots: string[] = [], level: BotLevel = 'normal') {
  const clock = { t: 1_000 };
  let j = 0;
  const g = new WordHuntGame(ids, cfg({}, level), () => 0, bots, () => ((j = (j * 7 + 3) % 10) + 0.5) / 10, () => clock.t);
  g.grid = [...FIXED];
  g.solved = solve(g.dict, FIXED, 4);
  return { g, clock };
}

/** runs every timed step due by time t */
function runTo(g: WordHuntGame, clock: { t: number }, t: number): void {
  for (let step = g.nextStep(); step && step.at <= t; step = g.nextStep()) {
    clock.t = Math.max(clock.t, step.at);
    step.run();
  }
  clock.t = t;
}

describe('Word Grid Hunt dictionary', () => {
  it('loads once, small and fast (figures printed for the report)', () => {
    const d = dictionary();
    // eslint-disable-next-line no-console
    console.log(`[wordhunt] dictionary: ${d.words} words, ${d.nodes} nodes, ${Math.round(d.bytes / 1024)} KB of arrays, loaded in ${d.loadMs} ms, heap +${d.heapMb} MB while loading`);
    expect(d.words).toBeGreaterThan(100_000);
    expect(d.bytes).toBeLessThan(8 * 1024 * 1024);
    expect(d.loadMs).toBeLessThan(3_000);
    expect(dictionary()).toBe(d);
  });

  it('knows plurals and verb forms, lowercase a–z only, 3–16 letters', () => {
    const d = dictionary();
    for (const w of ['cat', 'cats', 'running', 'quiet', 'colour', 'color', 'rated', 'tea']) expect(isWord(d, w)).toBe(true);
    for (const w of ['ca', 'Cat', 'cae', 'qzxv', 'abcdefghijklmnopq', '']) expect(isWord(d, w)).toBe(false);
    expect(tierOf(d, 'the')).toBe(1);
    expect(tierOf(d, 'zebra')).toBeGreaterThan(1);
  });

  it('never knows a blocklisted word', () => {
    const d = dictionary();
    for (const w of BLOCKED_WORDS) expect(isWord(d, w)).toBe(false);
    for (const w of ['fucking', 'motherfucker', 'bullshit']) expect(isWord(d, w)).toBe(false);
    // the solver and bots never see them either
    const words = solve(d, ['s', 'h', 'i', 't', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l'], 4);
    expect(words.has('shit')).toBe(false);
    expect(words.has('hit')).toBe(true);
  });
});

describe('Word Grid Hunt grid and solver', () => {
  it('tiles touch in 8 directions only', () => {
    expect(wordHuntTouches(4, 5, 0)).toBe(true);
    expect(wordHuntTouches(4, 5, 10)).toBe(true);
    expect(wordHuntTouches(4, 3, 4)).toBe(false);
    expect(wordHuntTouches(4, 5, 5)).toBe(false);
    expect(wordHuntTouches(5, 4, 5)).toBe(false);
  });

  it('finds known words in a fixed grid, with Qu as one tile', () => {
    const words = solve(dictionary(), FIXED, 4);
    for (const [w, path] of Object.entries(P)) {
      expect(words.has(w)).toBe(true);
      expect(words.get(w)!.path.map((i) => FIXED[i]).join('')).toBe(w);
      expect(path.map((i) => FIXED[i]).join('')).toBe(w);
    }
    expect([...words.keys()].every((w) => w.length >= 3)).toBe(true);
    expect(solve(dictionary(), FIXED, 4, 4).has('cat')).toBe(false);
  });

  it('only deals grids above the word threshold, the same grid for the same seed', () => {
    const d = dictionary();
    for (const size of [4, 5]) {
      for (let seed = 0; seed < 40; seed++) {
        const g = makeGrid(d, size, seed);
        expect(g.grid).toHaveLength(size * size);
        expect(g.words.size).toBeGreaterThanOrEqual(WORDHUNT_MIN_WORDS[size]);
        if (size === 5) expect([...g.words.keys()].every((w) => w.length >= 4)).toBe(true);
      }
    }
    expect(makeGrid(d, 4, 9).grid).toEqual(makeGrid(d, 4, 9).grid);
    // a poor roll is thrown away: some rolls fall below the threshold
    const r = seeded(3);
    const counts = Array.from({ length: 200 }, () => solve(d, rollGrid(4, r), 4).size);
    expect(Math.min(...counts)).toBeLessThan(WORDHUNT_MIN_WORDS[4]);
  });
});

describe('Word Grid Hunt play', () => {
  it('scores by length: 3 and 4 → 1, 5 → 2, 6 → 3, 7 → 5, 8+ → 11', () => {
    expect([3, 4, 5, 6, 7, 8, 12].map(wordHuntPoints)).toEqual([1, 1, 2, 3, 5, 11, 11]);
  });

  it('checks every word at once: the path, the length, the dictionary, repeats and the round', () => {
    const { g, clock } = setUp();
    expect(g.view('A', true).grid).toEqual([]);
    expect(g.word('A', 1, P.cat)).toEqual([]);
    expect(g.tries.get('A')).toMatchObject({ verdict: 'late', points: 0 });
    runTo(g, clock, 1_000 + WORDHUNT_COUNTDOWN_MS);
    expect(g.phase).toBe('play');
    expect(g.view('A', true).grid).toEqual(FIXED);
    const verdict = (path: number[], round = 1) => {
      g.word('A', round, path);
      clock.t += 300;
      return g.view('A', true).lastTry!;
    };
    expect(verdict(P.cat)).toMatchObject({ word: 'cat', verdict: 'ok', points: 1, seq: 2 });
    expect(verdict(P.cat)).toMatchObject({ verdict: 'again' });
    expect(verdict([0, 1])).toMatchObject({ word: 'ca', verdict: 'short' });
    expect(verdict([0, 1, 6])).toMatchObject({ word: 'cae', verdict: 'unknown' });
    expect(verdict([0, 2, 3])).toMatchObject({ verdict: 'path' });
    expect(verdict([2, 6, 2])).toMatchObject({ verdict: 'path' });
    expect(verdict([0, 1, 99])).toMatchObject({ verdict: 'path' });
    expect(verdict(P.cats, 2)).toMatchObject({ verdict: 'late' });
    expect(verdict(P.quiet)).toMatchObject({ word: 'quiet', verdict: 'ok', points: 2 });
    expect(verdict(P.rated)).toMatchObject({ verdict: 'ok', points: 2 });
    expect(g.view('A', true).mine).toEqual([{ word: 'cat', points: 1 }, { word: 'quiet', points: 2 }, { word: 'rated', points: 2 }]);
    expect(() => parseWordHuntMove({ type: 'word', round: 1, path: [] })).toThrow('Trace a word through touching tiles');
    expect(() => parseWordHuntMove({ type: 'word', round: 1, path: [0.5] })).toThrow('Trace a word through touching tiles');
    expect(() => parseWordHuntMove({ type: 'word', path: [1] })).toThrow('Invalid move');
  });

  it('limits a player to 4 words a second', () => {
    const { g, clock } = setUp();
    runTo(g, clock, 1_000 + WORDHUNT_COUNTDOWN_MS);
    for (const p of [P.cat, P.cats, P.rat, P.tea]) g.word('A', 1, p);
    expect(() => g.word('A', 1, P.rate)).toThrow('Slow down a little');
    g.word('B', 1, P.rate);
    clock.t += 1_001;
    g.word('A', 1, P.rate);
    expect(g.view('A', true).mine).toHaveLength(5);
  });

  it('hides other players’ words until the reveal, and watchers see counts only', () => {
    const { g, clock } = setUp(['A', 'B', 'C']);
    runTo(g, clock, 1_000 + WORDHUNT_COUNTDOWN_MS);
    g.word('A', 1, P.cat);
    g.word('B', 1, P.tea);
    g.word('B', 1, P.rat);
    const a = g.view('A', true);
    expect(a.mine.map((w) => w.word)).toEqual(['cat']);
    expect(a.counts).toEqual({ A: 1, B: 2, C: 0 });
    expect(a.reveal).toBeNull();
    expect(JSON.stringify(a)).not.toContain('tea');
    const w = g.view('W', false);
    expect(w.mine).toEqual([]);
    expect(w.lastTry).toBeNull();
    expect(w.counts).toEqual({ A: 1, B: 2, C: 0 });
    expect(JSON.stringify(w)).not.toMatch(/"(cat|tea|rat)"/);
    // the server's events never carry the word
    expect(JSON.stringify(g.word('C', 1, P.rate))).not.toContain('rate');
  });

  it('a word only you found scores double; reveal shows everyone’s words, the best word and missed words', () => {
    const { g, clock } = setUp();
    const start = 1_000 + WORDHUNT_COUNTDOWN_MS;
    runTo(g, clock, start);
    g.word('A', 1, P.cat);
    g.word('A', 1, P.rate);
    g.word('B', 1, P.cat);
    g.word('B', 1, P.tea);
    clock.t += 1_000;
    g.word('B', 1, P.rated);
    runTo(g, clock, start + 120_000);
    expect(g.phase).toBe('reveal');
    const r = g.view('A', true).reveal!;
    expect(r.words.A).toEqual([{ word: 'cat', points: 1, unique: false }, { word: 'rate', points: 2, unique: true }]);
    expect(r.words.B).toEqual([{ word: 'cat', points: 1, unique: false }, { word: 'tea', points: 2, unique: true }, { word: 'rated', points: 4, unique: true }]);
    expect(r.points).toEqual({ A: 3, B: 7 });
    expect(r.best).toEqual({ playerId: 'B', word: 'rated', points: 4 });
    expect(r.missed).toHaveLength(5);
    expect(r.missed.every((w) => !['cat', 'rate', 'tea', 'rated'].includes(w))).toBe(true);
    expect(r.missed[0].length).toBeGreaterThanOrEqual(r.missed[4].length);
    expect(r.total).toBe(g.solved.size);
    expect(g.view('W', false).reveal).toEqual(r);
    expect(g.view('A', true).scores).toEqual({ A: 3, B: 7 });
    expect(wordhuntModule.tallies(g, 'B')).toEqual({ words: 3, uniqueWords: 2, longWords: 0 });
  });

  it('plays 3 rounds with a countdown, the round time and a reveal, then ends; the higher total wins and ties share', () => {
    const { g, clock } = setUp();
    expect(g.view('A', true)).toMatchObject({ phase: 'countdown', round: 1, rounds: 3, size: 4, minLen: 3, time: 120, startsAt: 4_000, endsAt: 124_000 });
    for (let round = 1; round <= 3; round++) {
      runTo(g, clock, g.startsAt);
      expect(g.phase).toBe('play');
      expect(g.round).toBe(round);
      const words = [...g.solved.entries()];
      g.word('A', round, words[0][1].path);
      g.word('B', round, words[round === 2 ? 1 : 0][1].path);
      runTo(g, clock, g.endsAt);
      if (round < 3) {
        expect(g.phase).toBe('reveal');
        expect(g.nextAt).toBe(g.endsAt + WORDHUNT_REVEAL_MS);
        runTo(g, clock, g.nextAt!);
        expect(g.phase).toBe('countdown');
        expect(g.view('A', true).grid).toEqual([]);
        expect(g.startsAt).toBe(clock.t + WORDHUNT_COUNTDOWN_MS);
      }
    }
    expect(g.over).toBe(true);
    expect(g.phase).toBe('over');
    expect(g.view('A', true).reveal?.round).toBe(3);
    const [a, b] = [g.scores.get('A')!, g.scores.get('B')!];
    expect(g.winners()).toEqual(a === b ? ['A', 'B'] : [a > b ? 'A' : 'B']);
    if (a === b) expect([g.placeOf('A'), g.placeOf('B')]).toEqual([1, 1]);
  });

  it('5 × 5 grids need 4+ letters, and the round time follows the option', () => {
    const g = new WordHuntGame(['A', 'B'], cfg({ grid: 5, time: 90 }), () => 1);
    expect(g.view('A', true)).toMatchObject({ size: 5, minLen: 4, time: 90 });
    expect([...g.solved.keys()].every((w) => w.length >= 4)).toBe(true);
  });
});

describe('Word Grid Hunt bots', () => {
  it.each([['normal', 10, 22], ['expert', 26, 42]] as const)('%s finds words at its pace (%i–%i a round), all real and not blocked', (level, lo, hi) => {
    const { g, clock } = setUp(['A', 'Bot'], ['Bot'], level);
    g.grid = makeGrid(g.dict, 4, 5).grid;
    g.solved = solve(g.dict, g.grid, 4);
    runTo(g, clock, g.endsAt - 1);
    const found = g.found.get('Bot')!.map((f) => f.word);
    expect(found.length).toBeGreaterThanOrEqual(Math.min(lo, g.solved.size));
    expect(found.length).toBeLessThanOrEqual(hi);
    expect(found.every((w) => g.solved.has(w) && isWord(g.dict, w))).toBe(true);
    expect(new Set(found).size).toBe(found.length);
  });

  it.each([['normal', 10, 15], ['hard', 14, 19], ['expert', 22, 30]] as const)('%s finds %i–%i words in a 90 s round, mostly common ones (Normal: 3–5 letters)', (level, lo, hi) => {
    let short = 0;
    let all = 0;
    let common = 0;
    let rare = 0;
    for (let seed = 1; seed <= 12; seed++) {
      const clock = { t: 0 };
      const r = seeded(seed);
      const g = new WordHuntGame(['A', 'Bot'], cfg({ time: 90 }, level), (m) => Math.floor(r() * m), ['Bot'], r, () => clock.t);
      for (let s = g.nextStep(); s && !g.reveal; s = g.nextStep()) {
        clock.t = s.at;
        s.run();
      }
      const words = g.reveal!.words.Bot;
      expect(words.length).toBeGreaterThanOrEqual(lo);
      expect(words.length).toBeLessThanOrEqual(hi);
      all += words.length;
      short += words.filter((w) => w.word.length <= 5).length;
      common += words.filter((w) => tierOf(g.dict, w.word) <= COMMON_TIER).length;
      rare += words.filter((w) => tierOf(g.dict, w.word) >= 4).length;
      // missed words are plain ones while any are left
      for (const m of g.reveal!.missed) expect(tierOf(g.dict, m) <= 4 || [...g.solved.entries()].every(([w, x]) => x.tier > 4 || words.some((f) => f.word === w) || g.reveal!.missed.includes(w))).toBe(true);
    }
    if (level === 'normal') expect(short / all).toBeGreaterThanOrEqual(0.9);
    expect(common / all).toBeGreaterThanOrEqual(level === 'normal' ? 0.9 : level === 'hard' ? 0.8 : 0.6);
    expect(rare / all).toBeLessThanOrEqual(level === 'normal' ? 0 : 0.05);
  });

  it('Normal bots pick shorter, commoner words than Expert ones', () => {
    const d = dictionary();
    const { words } = makeGrid(d, 4, 11);
    const r = seeded(1);
    const avg = (xs: string[]) => xs.reduce((s, w) => s + w.length, 0) / xs.length;
    const normal = botWords(words, 'normal', r).slice(0, 15);
    const expert = botWords(words, 'expert', r).slice(0, 15);
    expect(Math.max(...normal.map((w) => w.length))).toBeLessThanOrEqual(5);
    expect(avg(expert)).toBeGreaterThan(avg(normal));
  });
});
