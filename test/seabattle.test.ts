import { describe, expect, it } from 'vitest';
import { decide } from '../src/games/seabattle/brain.js';
import { SeaGame } from '../src/games/seabattle/game.js';
import { parseSeaMove, seabattleModule } from '../src/games/seabattle/module.js';
import { SEA_FLEET, seaFleetError, seaRandomFleet, seaShipCells, type BotLevel, type GameConfig, type SeaShip, type SeaView } from '../src/types.js';

const rng = (seed: number) => () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
/** a fixed legal fleet: rows 0, 2, 4, 6, 8 from the left */
const FLEET: SeaShip[] = SEA_FLEET.map((len, i) => ({ x: 0, y: i * 2, len, v: false }));

function setup(ids: string[], opts: Record<string, unknown> = {}, bots: string[] = [], level: BotLevel = 'hard', seed = 1) {
  let t = 1e12;
  const r = rng(seed);
  const config = { game: 'seabattle', botLevel: level, opts } as unknown as GameConfig;
  const g = new SeaGame(ids, config, () => 0, bots, r, () => t);
  return { g, at: (ms: number) => (t = ms), now: () => t };
}

/** everyone places FLEET and readies; a goes first */
function battle(ids: string[], opts: Record<string, unknown> = {}) {
  const s = setup(ids, opts);
  for (const id of ids) {
    s.g.place(id, FLEET);
    s.g.markReady(id);
  }
  return s;
}

const seaOf = (g: SeaGame, me: string, seated = true): SeaView => {
  const v = seabattleModule.view(g, me, seated);
  if (v.kind !== 'seabattle') throw new Error('kind');
  return v.seabattle;
};

describe('Sea Battle placement', () => {
  it('fleet rules: the right lengths, on the sea, no overlap, no touching even at corners', () => {
    expect(seaFleetError(FLEET)).toBeNull();
    expect(seaFleetError(FLEET.slice(1))).toMatch(/whole fleet/);
    expect(seaFleetError([...FLEET.slice(0, 4), { x: 9, y: 9, len: 2, v: false }])).toMatch(/on the sea/);
    expect(seaFleetError([...FLEET.slice(0, 4), { x: 0, y: 1, len: 2, v: false }])).toMatch(/touch/);
    expect(seaFleetError([...FLEET.slice(0, 4), { x: 3, y: 7, len: 2, v: true }])).toMatch(/touch/);
    expect(seaFleetError([...FLEET.slice(0, 4), { x: 1, y: 6, len: 2, v: true }])).toMatch(/overlap|touch/);
    const r = rng(3);
    for (let i = 0; i < 300; i++) expect(seaFleetError(seaRandomFleet(r))).toBeNull();
  });

  it('place, ready, battle when all are ready; time up places the rest at random', () => {
    const { g } = setup(['a', 'b']);
    expect(() => g.place('a', FLEET.slice(1))).toThrow(/whole fleet/);
    g.place('a', FLEET);
    g.markReady('a');
    expect(g.phase).toBe('place');
    const ev = g.markReady('b');
    expect(g.phase).toBe('battle');
    expect(ev.some((e) => e.kind === 'seabattle' && e.ev.type === 'battle')).toBe(true);
    expect(seaFleetError(g.fleets.get('b')!)).toBeNull();
    const t = setup(['a', 'b', 'c']);
    const step = seabattleModule.auto(t.g)!;
    expect(step.delayMs).toBe(60_000);
    step.run();
    expect(t.g.phase).toBe('battle');
    for (const id of ['a', 'b', 'c']) expect(seaFleetError(t.g.fleets.get(id)!)).toBeNull();
  });
});

describe('Sea Battle hidden fleets', () => {
  it("no one's view holds another fleet until it sinks; watchers see none", () => {
    const { g } = battle(['a', 'b', 'c']);
    const cellsOf = (id: string) => g.fleets.get(id)!.flatMap(seaShipCells);
    for (const me of ['a', 'b', 'c']) {
      const v = seaOf(g, me);
      expect(v.seas[me].ships).toHaveLength(5);
      for (const other of ['a', 'b', 'c'].filter((o) => o !== me)) expect(v.seas[other].ships).toEqual([]);
    }
    const w = seaOf(g, 'zz', false);
    for (const id of ['a', 'b', 'c']) expect(w.seas[id].ships).toEqual([]);
    expect(seaOf(g, 'a', false).seas.a.ships).toEqual([]);
    // sink b's 2-ship (row 8): then everyone sees that one only
    g.fire('a', 'b', 0, 8);
    g.fire('a', 'b', 1, 8);
    for (const me of ['a', 'c']) {
      const ships = seaOf(g, me).seas.b.ships;
      expect(ships).toEqual([{ x: 0, y: 8, len: 2, v: false, sunk: true, hits: 2 }]);
    }
    expect(cellsOf('b')).toHaveLength(17);
  });

  it("a radar's count reaches only the scanner", () => {
    const { g } = battle(['a', 'b', 'c'], { powers: 'on' });
    g.held.get('a')!.push('radar');
    g.radar('a', 'b', 1, 1);
    expect(seaOf(g, 'a').radars).toEqual([{ target: 'b', x: 0, y: 0, count: 6 }]);
    expect(seaOf(g, 'a').last!.count).toBe(6);
    expect(seaOf(g, 'b').radars).toEqual([]);
    expect(seaOf(g, 'b').last!.count).toBeUndefined();
    expect(seaOf(g, 'zz', false).last!.count).toBeUndefined();
    // the turn goes on
    expect(g.turnId).toBe('a');
  });
});

describe('Sea Battle shots', () => {
  it('a hit fires again, a miss ends the turn; no firing twice at a cell or at yourself', () => {
    const { g } = battle(['a', 'b', 'c']);
    expect(g.turnId).toBe('a');
    expect(() => g.fire('b', 'a', 0, 0)).toThrow('Not your turn');
    expect(() => g.fire('a', 'a', 0, 0)).toThrow('own fleet');
    g.fire('a', 'b', 0, 0);
    expect(g.turnId).toBe('a');
    expect(() => g.fire('a', 'b', 0, 0)).toThrow('Already fired');
    g.fire('a', 'c', 9, 9);
    expect(g.turnId).toBe('b');
    expect(seaOf(g, 'b').seas.c.shots[99]).toBe(1);
    expect(seabattleModule.tallies(g, 'a')).toEqual({ hits: 1, sunk: 0, shots: 2 });
  });

  it('sinking every ship puts a fleet out; the last afloat wins', () => {
    const { g } = battle(['a', 'b'], { powers: 'off' });
    for (const s of FLEET) for (const [x, y] of seaShipCells(s)) g.fire('a', 'b', x, y);
    expect(g.over).toBe(true);
    expect(g.winners()).toEqual(['a']);
    expect(seaOf(g, 'b').places).toEqual({ a: 1, b: 2 });
    expect(seabattleModule.tallies(g, 'a')).toMatchObject({ hits: 17, sunk: 5, shots: 17 });
    expect(g.held.get('a')).toEqual([]);
  });

  it('powers: a sink earns one (at most 2 held); salvo, torpedo', () => {
    const { g } = battle(['a', 'b'], { powers: 'on' });
    g.fire('a', 'b', 0, 8);
    g.fire('a', 'b', 1, 8);
    expect(g.held.get('a')).toHaveLength(1);
    expect(seaOf(g, 'b').last!.earned).not.toBeNull();
    g.held.set('a', ['salvo', 'torpedo']);
    expect(() => g.salvo('a', 'b', [[5, 5], [5, 5], [6, 6]])).toThrow('3 different');
    g.salvo('a', 'b', [[9, 9], [0, 6], [9, 7]]);
    expect(g.turnId).toBe('a');
    expect(seaOf(g, 'b').seas.b.shots.filter((s) => s > 0)).toHaveLength(5);
    // the torpedo runs along row 0 to the first unhit ship cell
    g.torpedo('a', 'b', 0);
    expect(seaOf(g, 'a').last).toMatchObject({ kind: 'torpedo', row: 0, cells: [{ x: 0, y: 0, hit: true }] });
    expect(() => g.torpedo('a', 'b', 1)).toThrow('no torpedo');
    g.held.set('a', ['torpedo']);
    g.torpedo('a', 'b', 1);
    expect(seaOf(g, 'a').last).toMatchObject({ kind: 'torpedo', row: 1, cells: [] });
    expect(g.turnId).toBe('b');
  });

  it('time out: a random shot at a fleet still afloat', () => {
    const { g } = battle(['a', 'b']);
    const step = seabattleModule.auto(g)!;
    expect(step.delayMs).toBe(20_000);
    step.run();
    expect(g.last).toMatchObject({ by: 'a', target: 'b', auto: true });
  });

  it('walking out mid-battle: the turn moves on; the last one left wins', () => {
    const { g } = battle(['a', 'b', 'c']);
    g.leave('a');
    expect(g.turnId).toBe('b');
    g.leave('c');
    expect(g.over).toBe(true);
    expect(g.winners()).toEqual(['b']);
  });

  it('moves are parsed strictly', () => {
    expect(parseSeaMove({ type: 'fire', target: 'b', x: 1, y: 2 })).toEqual({ type: 'fire', target: 'b', x: 1, y: 2 });
    expect(parseSeaMove({ type: 'place' })).toEqual({ type: 'place' });
    expect(() => parseSeaMove({ type: 'fire', target: 'b', x: 1.5, y: 2 })).toThrow();
    expect(() => parseSeaMove({ type: 'salvo', target: 'b', cells: [[1, 2, 3]] })).toThrow();
  });
});

describe('Sea Battle bots', () => {
  function playOut(ids: string[], levels: BotLevel[], powers: string, seed: number) {
    const s = setup(ids, { powers }, ids, 'hard', seed);
    const r = rng(seed * 7);
    for (const id of ids) s.g.markReady(id);
    let n = 0;
    while (!s.g.over && n++ < 2000) {
      const id = s.g.turnId!;
      const m = decide(seaOf(s.g, id), id, levels[ids.indexOf(id)], r);
      seabattleModule.move(s.g, id, m);
    }
    return { g: s.g, n };
  }

  it('finish hundreds of games, with and without powers', () => {
    for (let i = 0; i < 300; i++) {
      const ids = ['a', 'b', 'c', 'd'].slice(0, 2 + (i % 3));
      const lv: BotLevel[] = ['normal', 'hard', 'expert'];
      const { g } = playOut(ids, ids.map((_, k) => lv[(i + k) % 3]), i % 2 ? 'on' : 'off', i + 1);
      expect(g.over).toBe(true);
      expect(g.winners()).toHaveLength(1);
    }
  }, 120_000);

  it('levels are ordered: fewer shots to sink a fleet from Normal to Expert', () => {
    const shots = (lv: BotLevel) => {
      let total = 0;
      for (let i = 0; i < 40; i++) {
        const { g } = playOut(['a', 'b'], [lv, lv], 'off', 500 + i);
        // the winner's shots: what it took to sink a whole fleet
        total += (g.stats.get(g.winners()[0])!.tallies as { shots: number }).shots;
      }
      return total / 40;
    };
    const [n, h, e] = [shots('normal'), shots('hard'), shots('expert')];
    expect(h).toBeLessThan(n);
    expect(e).toBeLessThan(h);
  }, 120_000);
});
