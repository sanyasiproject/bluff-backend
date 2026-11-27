import { describe, expect, it } from 'vitest';
import { RMCS_GUESS_MS, RMCS_RESULT_MS, RmcsGame } from '../src/games/rmcs/game.js';
import { rmcsModule } from '../src/games/rmcs/module.js';
import type { GameEvent } from '../src/models.js';
import { RMCS_OPEN_SEC, type RmcsRole } from '../src/types.js';
import { parseConfig } from '../src/validate.js';

const IDS = ['A', 'B', 'C', 'D'];
const ROLES: Record<string, RmcsRole> = { A: 'raja', B: 'mantri', C: 'chor', D: 'sipahi' };

/** a game on a clock the test moves, with known chits */
function game(rounds: 5 | 10 = 5, bots: string[] = []) {
  let t = 1_000_000;
  const clock = { now: () => t, add: (ms: number) => (t += ms) };
  const g = new RmcsGame(IDS, parseConfig({ decks: 1, bluffRule: 'one', game: 'rmcs', opts: { rounds } }), (max) => max - 1, bots, clock.now, () => 0);
  g.roles = new Map(Object.entries(ROLES));
  return { g, clock };
}

const kinds = (events: GameEvent[]) => events.map((e) => (e.kind === 'rmcs' ? `rmcs:${e.ev.type}` : e.kind));
const openAll = (g: RmcsGame) => IDS.flatMap((id) => g.open(id));

describe('Raja Mantri rules', () => {
  it('needs exactly 4; rounds come from the options', () => {
    const config = parseConfig({ decks: 1, bluffRule: 'one', game: 'rmcs' });
    expect(() => new RmcsGame(['A', 'B', 'C'], config)).toThrow('Raja Mantri Chor Sipahi needs exactly 4 players. Add bots to fill the table');
    expect(new RmcsGame(IDS, config).rounds).toBe(5);
    expect(game(10).g.rounds).toBe(10);
  });

  it('deals each chit once per round and starts the open step with its time', () => {
    const g = new RmcsGame(IDS, parseConfig({ decks: 1, bluffRule: 'one', game: 'rmcs' }), undefined, [], () => 5_000);
    expect([...g.roles.values()].sort()).toEqual(['chor', 'mantri', 'raja', 'sipahi']);
    expect(g.view('A', true)).toMatchObject({ round: 1, rounds: 5, phase: 'open', opened: [], shown: {}, endsAt: 5_000 + RMCS_OPEN_SEC * 1000 });
    expect(g.turnId).toBeNull();
  });

  it('a seated player sees only their own chit; the Raja shows once opened, the Mantri at guessing, all at the result', () => {
    const { g, clock } = game();
    expect(g.view('C', true)).toMatchObject({ myRole: 'chor', shown: {} });
    expect(g.view('W', false).myRole).toBeNull();
    expect(kinds(g.open('C'))).toEqual(['rmcs:open']);
    expect(g.view('B', true).shown).toEqual({});
    expect(g.open('A')).toEqual([{ kind: 'rmcs', ev: { type: 'open', playerId: 'A', raja: true, auto: false } }]);
    expect(g.view('D', true).shown).toEqual({ A: 'raja' });
    expect(() => g.open('A')).toThrow('Your chit is already open');
    g.open('B');
    clock.add(1000);
    expect(kinds(g.open('D'))).toEqual(['rmcs:open', 'rmcs:guessing']);
    const v = g.view('C', true);
    expect(v).toMatchObject({ phase: 'guess', myRole: 'chor', shown: { A: 'raja', B: 'mantri' }, opened: IDS, endsAt: clock.now() + RMCS_GUESS_MS });
    expect(g.turnId).toBe('B');
    // a watcher sees no more than the table
    expect(g.view('W', false)).toMatchObject({ myRole: null, shown: { A: 'raja', B: 'mantri' } });
    g.guess('B', 'C');
    expect(g.view('W', false).shown).toEqual(ROLES);
  });

  it("a view never changes when only other players' chits do", () => {
    const { g } = game();
    g.open('A');
    for (const me of ['C', 'D']) {
      const before = JSON.stringify(g.view(me, true));
      const other = me === 'C' ? 'D' : 'C';
      // swap the Mantri's and the other hidden chit
      g.roles.set('B', g.roles.get(other)!);
      g.roles.set(other, 'mantri');
      expect(JSON.stringify(g.view(me, true))).toBe(before);
      g.roles.set(other, g.roles.get('B')!);
      g.roles.set('B', 'mantri');
    }
    expect(JSON.stringify(g.view('W', false))).not.toContain('chor');
  });

  it('the Mantri points at the Chor: a right guess keeps the points', () => {
    const { g } = game();
    expect(() => g.guess('B', 'C')).toThrow('Wait for everyone to open their chit');
    openAll(g);
    expect(() => g.guess('C', 'D')).toThrow('Only the Mantri finds the Chor');
    expect(() => g.guess('B', 'A')).toThrow('Pick one of the two players left');
    expect(() => g.guess('B', 'B')).toThrow('Pick one of the two players left');
    expect(() => rmcsModule.move(g, 'B', { type: 'guess' })).toThrow('Pick one of the two players left');
    expect(() => rmcsModule.move(g, 'B', { type: 'peek' })).toThrow('Invalid move');
    expect(g.suspects()).toEqual(['C', 'D']);
    const e = rmcsModule.move(g, 'B', { type: 'guess', target: 'C' });
    expect(e).toEqual([{ kind: 'rmcs', ev: { type: 'result', round: 1, mantriId: 'B', chorId: 'C', guess: 'C', correct: true } }]);
    expect(g.view('A', true)).toMatchObject({ phase: 'result', scores: { A: 1000, B: 800, C: 0, D: 500 } });
    expect(g.history[0]).toEqual({ round: 1, roles: ROLES, guess: 'C', correct: true, points: { A: 1000, B: 800, C: 0, D: 500 } });
    expect(() => g.guess('B', 'C')).toThrow('This round is over');
    expect(() => g.open('A')).toThrow('Your chit is already open');
    expect(rmcsModule.tallies(g, 'B')).toEqual({ caught: 1, escaped: 0, raja: 0 });
    expect(rmcsModule.tallies(g, 'A')).toEqual({ caught: 0, escaped: 0, raja: 1 });
  });

  it('a wrong guess or no guess in time swaps the Mantri and the Chor', () => {
    const { g } = game();
    openAll(g);
    g.guess('B', 'D');
    expect(g.history[0].points).toEqual({ A: 1000, B: 0, C: 800, D: 500 });
    expect(rmcsModule.tallies(g, 'C')).toEqual({ caught: 0, escaped: 1, raja: 0 });
    g.next();
    g.roles = new Map(Object.entries(ROLES));
    openAll(g);
    expect(kinds(g.guessTimeUp())).toEqual(['rmcs:result']);
    expect(g.history[1]).toMatchObject({ guess: null, correct: false, points: { B: 0, C: 800 } });
    expect(g.view('A', true).scores).toEqual({ A: 2000, B: 0, C: 1600, D: 1000 });
  });

  it('rounds run on, and the game ends after the last result; ties share first', () => {
    const { g } = game();
    for (let r = 1; r <= 5; r++) {
      expect(g.round).toBe(r);
      g.roles = new Map(Object.entries(r % 2 ? ROLES : { A: 'chor', B: 'mantri', C: 'raja', D: 'sipahi' }));
      openAll(g);
      g.guess('B', r % 2 ? 'C' : 'A');
      const after = g.next();
      expect(kinds(after)).toEqual(r < 5 ? ['rmcs:deal'] : ['gameOver']);
    }
    expect(g.over).toBe(true);
    expect(g.view('A', true)).toMatchObject({ phase: 'result', endsAt: null, scores: { A: 3000, B: 4000, C: 2000, D: 2500 } });
    expect(g.winners()).toEqual(['B']);
    expect(g.losers()).toEqual(['A', 'C', 'D']);
    expect([g.placeOf('B'), g.placeOf('A'), g.placeOf('D'), g.placeOf('C')]).toEqual([1, 2, 3, 4]);
    g.scores.set('A', 4000);
    expect(g.winners()).toEqual(['A', 'B']);
    expect(g.placeOf('A')).toBe(1);
    expect(g.placeOf('D')).toBe(3);
  });

  it('timed steps: bots open first, then the rest open at time up; the guess times out; the result moves on', () => {
    const { g, clock } = game(5, ['C', 'D']);
    g.open('A');
    let step = rmcsModule.auto(g)!;
    expect(step.delayMs).toBe(1_200);
    expect(kinds(step.run())).toEqual(['rmcs:open']);
    expect(kinds(rmcsModule.auto(g)!.run())).toEqual(['rmcs:open']);
    // B is a person: the step is the time up
    step = rmcsModule.auto(g)!;
    expect(step.delayMs).toBe(RMCS_OPEN_SEC * 1000);
    expect(kinds(step.run())).toEqual(['rmcs:open', 'rmcs:guessing']);
    expect(g.view('A', true).opened).toEqual(IDS);
    clock.add(5_000);
    step = rmcsModule.auto(g)!;
    expect(step.delayMs).toBe(RMCS_GUESS_MS - 5_000);
    step.run();
    expect(g.phase).toBe('result');
    step = rmcsModule.auto(g)!;
    expect(step.delayMs).toBe(RMCS_RESULT_MS);
    expect(kinds(step.run())).toEqual(['rmcs:deal']);
  });

  it('a bot Mantri points at one of the two after a pause', () => {
    const { g } = game(5, ['B']);
    g.open('A');
    g.open('C');
    g.open('D');
    // B is a bot: its own open comes first
    rmcsModule.auto(g)!.run();
    expect(g.phase).toBe('guess');
    const step = rmcsModule.auto(g)!;
    expect(step.delayMs).toBe(1_800);
    step.run();
    expect(['C', 'D']).toContain(g.history[0].guess);
    expect(rmcsModule.botMove(g, 'B', 'expert', () => 0.9)).toEqual({ type: 'open' });
  });

  it('turnKey moves with every step', () => {
    const { g } = game();
    const keys = new Set([rmcsModule.turnKey(g)]);
    for (const id of IDS) {
      g.open(id);
      keys.add(rmcsModule.turnKey(g));
    }
    g.guess('B', 'C');
    keys.add(rmcsModule.turnKey(g));
    expect(keys.size).toBe(6);
  });

  it('a walk-out forfeits; their chit and guess then play by themselves; one left wins', () => {
    const { g } = game();
    g.open('A');
    expect(g.leave('B')).toEqual([]);
    expect(g.inPlay('B')).toBe(false);
    expect(g.autoSeat('B')).toBe(true);
    expect(rmcsModule.auto(g)!.delayMs).toBe(400);
    rmcsModule.auto(g)!.run();
    g.open('C');
    g.open('D');
    // B was the Mantri: it points by itself
    expect(rmcsModule.auto(g)!.delayMs).toBe(400);
    rmcsModule.auto(g)!.run();
    expect(g.phase).toBe('result');
    g.leave('C');
    expect(kinds(g.leave('D'))).toEqual(['gameOver']);
    expect(g.winners()).toEqual(['A']);
    expect(g.losers()).toEqual(['B', 'C', 'D']);
  });

  it('closing (no person left) stops the game with no winner', () => {
    const { g } = game();
    g.leave('A');
    expect(kinds(g.close())).toEqual(['gameOver']);
    expect(g.winners()).toEqual([]);
    expect(g.losers()).toEqual(['A']);
    expect(g.placeOf('B')).toBeNull();
  });
});
