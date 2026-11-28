import { describe, expect, it } from 'vitest';
import { computeAwards } from '../src/awards.js';
import { Room } from '../src/rooms.js';
import { chatSetOf, LUDO_QUICK_MESSAGES, type GameKind } from '../src/types.js';
import { parseConfig } from '../src/validate.js';

const config = (game: GameKind, opts: object) => parseConfig({ decks: 1, bluffRule: 'one', game, opts });

function lobby(names: string[], games = ['darts', 'dots', 'colorwar']) {
  const r = new Room('ARCADE');
  const people = names.map((n) => r.addMember(n));
  for (const p of people) p.games = games;
  return { r, people };
}

describe.each([
  ['darts', { start: 501 }, 'Darts'],
  ['dots', { size: 6 }, 'Dots and Boxes'],
  ['colorwar', { size: 7 }, 'Colour Wars'],
] as const)('%s in a room', (kind, opts, title) => {
  it('every seat and watcher sees the same table, with no cards', () => {
    const { r, people } = lobby(['Asha', 'Ravi', 'Meena']);
    r.setConfig(people[0].id, config(kind, opts));
    expect(r.config.opts).toEqual(opts);
    r.start(people[0].id);
    const watcher = r.addMember('Zoya');
    const views = [...people, watcher].map((m) => r.view(m.id));
    for (const v of views) {
      expect(v.plugged?.kind).toBe(kind);
      expect(v.plugged).toEqual(views[0].plugged);
      expect(v.hand).toEqual([]);
    }
    const t = views[0].plugged as unknown as Record<string, { turnId: string | null }>;
    expect(t[kind].turnId).toBe(views[0].turnId);
  });

  it("an app without the game can't start it; a walk-out forfeits; tallies reach the record", () => {
    const { r, people } = lobby(['Asha', 'Ravi']);
    people[1].games = ['ludo'];
    r.setConfig(people[0].id, config(kind, opts));
    expect(() => r.start(people[0].id)).toThrow(`Ravi must update the app (reload it) to play ${title}`);
    people[1].games = [kind];
    r.start(people[0].id);
    r.removeMember(people[1].id);
    expect(r.plugged!.over).toBe(true);
    const rec = r.snapshot('finished')!;
    expect(rec.players.find((p) => p.memberId === people[0].id)!.won).toBe(true);
    expect(rec.players.find((p) => p.memberId === people[1].id)!.loser).toBe(true);
    const tallies = { darts: { t180: 0, bulls: 0, checkouts: 0 }, dots: { boxes: 0 }, colorwar: { captures: 0, bursts: 0 } }[kind];
    expect(rec.players[0].stats.tallies).toEqual(tallies);
  });

  it('uses its own chat set', () => {
    expect(chatSetOf(kind).messages).not.toBe(LUDO_QUICK_MESSAGES);
    expect(chatSetOf(kind).voice?.length).toBe(chatSetOf(kind).messages.length);
  });
});

describe('arcade awards', () => {
  it('reads each game’s tallies', () => {
    const stats = (tallies: Record<string, number>) => ({ bluffs: 0, caught: 0, goodCalls: 0, wrongCalls: 0, pickedUp: 0, plays: 0, chances: 0, tallies });
    expect(computeAwards(new Map([['a', stats({ t180: 1, bulls: 2 })], ['b', stats({ t180: 0, bulls: 2 })]]), 'darts')).toEqual([
      { emoji: '🎯', title: 'Maximum!', playerIds: ['a'], detail: 'threw 1 × 180' },
      { emoji: '🐂', title: 'Bull hunter', playerIds: ['a', 'b'], detail: 'hit 2 bullseyes' },
    ]);
    expect(computeAwards(new Map([['a', stats({ boxes: 9 })]]), 'dots')[0].detail).toBe('closed 9 boxes');
    expect(computeAwards(new Map([['a', stats({ captures: 1, bursts: 3 })]]), 'colorwar').map((a) => a.detail)).toEqual(['took 1 cell', '3 bursts']);
  });
});
