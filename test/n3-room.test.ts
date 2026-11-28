import { describe, expect, it } from 'vitest';
import { Room } from '../src/rooms.js';
import { chatSetOf, gameInfo, isPlugged, speaksQuickChat, type GameKind, type SeaView } from '../src/types.js';
import { parseConfig } from '../src/validate.js';

const config = (game: GameKind, opts: object) => parseConfig({ decks: 1, bluffRule: 'one', game, opts });

function lobby(names: string[], games = ['carrom', 'bomb', 'seabattle']) {
  const r = new Room('N3ROOM');
  const people = names.map((n) => r.addMember(n));
  for (const p of people) p.games = games;
  return { r, people };
}

describe.each([
  ['carrom', { mode: 'freestyle', length: 'full' }, 'Carrom', { pocketed: 0, queens: 0, fouls: 0 }],
  ['bomb', { hearts: 2, speed: 'fast' }, 'Bomb Pass', { passes: 0, booms: 0, fastest: 0 }],
  ['seabattle', { powers: 'off' }, 'Sea Battle', { hits: 0, sunk: 0, shots: 0 }],
] as const)('%s in a room', (kind, opts, title, tallies) => {
  it('is a plugged game with its options, own chat set and voice', () => {
    expect(isPlugged(kind)).toBe(true);
    const info = gameInfo(kind);
    expect(info.name).toBe(title);
    expect([info.minPlayers, info.maxPlayers]).toEqual([2, 4]);
    expect(info.category).toBe(kind === 'bomb' ? 'arcade' : 'board');
    expect(speaksQuickChat(kind)).toBe(true);
    expect(chatSetOf(kind).voice).toHaveLength(chatSetOf(kind).messages.length);
  });

  it('every seat and watcher gets a table; options reach the game', () => {
    const { r, people } = lobby(['Asha', 'Ravi', 'Meena']);
    r.setConfig(people[0].id, config(kind, opts));
    expect(r.config.opts).toEqual(opts);
    r.start(people[0].id);
    const watcher = r.addMember('Zoya');
    for (const m of [...people, watcher]) {
      const v = r.view(m.id);
      expect(v.plugged?.kind).toBe(kind);
      expect(v.hand).toEqual([]);
    }
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
    expect(rec.players[0].stats.tallies).toEqual(tallies);
  });
});

describe('room rules for the new games', () => {
  it('Classic carrom refuses 3 players before the start; Freestyle takes them', () => {
    const { r, people } = lobby(['Asha', 'Ravi', 'Meena']);
    r.setConfig(people[0].id, config('carrom', { mode: 'classic', length: 'quick' }));
    expect(() => r.start(people[0].id)).toThrow(/Freestyle/);
    expect(r.phase).toBe('lobby');
    r.setConfig(people[0].id, config('carrom', { mode: 'freestyle', length: 'quick' }));
    r.start(people[0].id);
    expect(r.plugged!.config.game).toBe('carrom');
  });

  it("Sea Battle: each seat's view holds only its own fleet; a watcher's holds none", () => {
    const { r, people } = lobby(['Asha', 'Ravi', 'Meena']);
    r.setConfig(people[0].id, config('seabattle', { powers: 'on' }));
    r.start(people[0].id);
    const watcher = r.addMember('Zoya');
    const sea = (id: string) => (r.view(id).plugged as { kind: 'seabattle'; seabattle: SeaView }).seabattle;
    // people place at random and get ready
    for (const p of people) {
      (r.plugged as unknown as { markReady(id: string): void }).markReady(p.id);
    }
    for (const p of people) {
      const v = sea(p.id);
      expect(v.phase).toBe('battle');
      expect(v.seas[p.id].ships).toHaveLength(5);
      for (const o of people.filter((x) => x !== p)) expect(v.seas[o.id].ships).toEqual([]);
    }
    for (const p of people) expect(sea(watcher.id).seas[p.id].ships).toEqual([]);
  });
});

describe('places only once a player finishes or is out', () => {
  it.each([
    ['carrom', { mode: 'classic', length: 'quick' }],
    ['bomb', { hearts: 2, speed: 'fast' }],
    ['seabattle', { powers: 'on' }],
  ] as const)('%s: no seat shows a place at the start', (kind, opts) => {
    const { r, people } = lobby(['Asha', 'Ravi']);
    r.setConfig(people[0].id, config(kind, opts));
    r.start(people[0].id);
    for (const p of r.view(people[0].id).players) expect(p.place).toBeNull();
    expect(Object.keys((r.view(people[0].id).plugged as unknown as Record<string, { places: object }>)[kind].places)).toEqual([]);
  });

  it('Bomb Pass: bots play on after the only person is out; one winner, the rest by when they went out', () => {
    const { r, people } = lobby(['Asha']);
    r.setConfig(people[0].id, config('bomb', { hearts: 2, speed: 'fast' }));
    const b1 = r.addBot(people[0].id, 'Bot One').bot;
    const b2 = r.addBot(people[0].id, 'Bot Two').bot;
    r.start(people[0].id);
    const g = r.plugged as unknown as import('../src/games/bomb/game.js').BombGame;
    // the person goes out first
    g.hearts.set(people[0].id, 0);
    g.outOrder.push(people[0].id);
    expect(r.endIfOnlyBots()).toEqual([]);
    expect(g.over).toBe(false);
    expect(r.view(people[0].id).players.find((p) => p.id === people[0].id)!.place).toBe(3);
    for (const p of r.view(people[0].id).players.filter((p) => p.id !== people[0].id)) expect(p.place).toBeNull();
    // then a bot on its last heart holds the bomb when it blows
    g.phase = 'play';
    g.hearts.set(b1.id, 1);
    (g as unknown as { holder: string }).holder = b1.id;
    (g as unknown as { boom(): unknown }).boom();
    expect(g.over).toBe(true);
    expect(g.winners()).toEqual([b2.id]);
    const places = Object.fromEntries(r.view(people[0].id).players.map((p) => [p.id, p.place]));
    expect(places).toEqual({ [people[0].id]: 3, [b1.id]: 2, [b2.id]: 1 });
  });

  it('an out person who walks away lets the bots-only game close', () => {
    const { r, people } = lobby(['Asha']);
    r.setConfig(people[0].id, config('bomb', { hearts: 2, speed: 'fast' }));
    r.addBot(people[0].id, 'Bot One');
    r.addBot(people[0].id, 'Bot Two');
    r.start(people[0].id);
    const g = r.plugged as unknown as import('../src/games/bomb/game.js').BombGame;
    g.hearts.set(people[0].id, 0);
    g.outOrder.push(people[0].id);
    g.leave(people[0].id);
    expect(g.forfeited.has(people[0].id)).toBe(false);
    expect(r.endIfOnlyBots().some((e) => e.kind === 'gameOver')).toBe(true);
  });
});
