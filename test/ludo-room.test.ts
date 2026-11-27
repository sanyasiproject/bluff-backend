import { describe, expect, it } from 'vitest';
import type { LudoGame } from '../src/games/ludo/game.js';
import { MAX_PLAYERS, Room } from '../src/rooms.js';
import { LUDO_HOME } from '../src/types.js';
import { parseConfig } from '../src/validate.js';

const LUDO = parseConfig({ decks: 1, bluffRule: 'one', game: 'ludo', opts: { mode: 'classic' } });

/** a lobby with these people (the first is host); app: whether their app has Ludo */
function lobby(names: string[], app = true) {
  const r = new Room('LUDO');
  const people = names.map((n) => r.addMember(n));
  for (const p of people) p.games = app ? ['ludo'] : [];
  return { r, people };
}

describe('Ludo in a room', () => {
  it('every seat and watcher sees the same board, with no cards and no secret card', () => {
    const { r, people } = lobby(['Asha', 'Ravi', 'Meena']);
    r.setConfig(people[0].id, LUDO);
    r.start(people[0].id);
    const watcher = r.addMember('Zoya');
    const views = [...people, watcher].map((m) => r.view(m.id));
    for (const v of views) {
      expect(v.phase).toBe('playing');
      expect(v.plugged?.kind).toBe('ludo');
      expect(v.plugged).toEqual(views[0].plugged);
      expect(v.hand).toEqual([]);
      expect(v.secret).toBeNull();
      expect(v.rang).toBeNull();
      expect(v.crazy7).toBeNull();
      expect(v.watch).toBeNull();
      expect(v.players.every((p) => p.cardCount === 0)).toBe(true);
    }
    const lv = views[0].plugged!.ludo;
    expect(lv.seats.map((s) => s.playerId)).toEqual(people.map((p) => p.id));
    expect(lv.turnId).toBe(views[0].turnId);
    expect(lv.movable).toEqual([]);
    expect(r.replay).toBeNull();
  });

  it("a person whose app doesn't have Ludo can't start it", () => {
    const { r, people } = lobby(['Asha', 'Ravi']);
    people[1].games = [];
    r.setConfig(people[0].id, LUDO);
    expect(() => r.start(people[0].id)).toThrow('Ravi must update the app (reload it) to play Ludo');
    people[1].games = ['ludo'];
    r.start(people[0].id);
    expect(r.plugged).not.toBeNull();
  });

  it('Ludo seats at most 4: switching with 5 seated is refused, and a 5th newcomer watches', () => {
    const { r, people } = lobby(['A', 'B', 'C', 'D', 'E']);
    expect(MAX_PLAYERS).toBe(5);
    expect(() => r.setConfig(people[0].id, LUDO)).toThrow('Ludo is for 2 to 4 players. Move 1 to watching first');
    r.setWatching(people[4].id, people[4].id, true);
    r.setConfig(people[0].id, LUDO);
    const f = r.addMember('F');
    expect(f.watching).toBe(true);
    expect(() => r.setWatching(f.id, f.id, false)).toThrow('All 4 seats are taken');
    expect(() => r.addBot(people[0].id, 'Bot')).toThrow('All 4 seats are taken');
    // back to Bluff: the one waiting gets the 5th seat
    r.setConfig(people[0].id, { ...LUDO, game: 'bluff' });
    expect(f.watching).toBe(false);
  });

  it('2v2 Ludo needs exactly 4 and seats partners opposite', () => {
    const { r, people } = lobby(['A', 'B', 'C']);
    r.setConfig(people[0].id, { ...LUDO, teams: true });
    expect(() => r.start(people[0].id)).toThrow('Teams need exactly 4 players');
    const d = r.addMember('D');
    d.games = ['ludo'];
    r.start(people[0].id);
    const g = r.plugged as LudoGame;
    expect(g.teams).not.toBeNull();
    expect(g.seats[0].color).toBe('red');
    expect(g.partnerOf(g.order[0])).toBe(g.order[2]);
  });

  it('host End game is refused; leaving is a forfeit; the game ends once only bots still race', () => {
    const { r, people } = lobby(['Asha', 'Ravi']);
    const bot = r.addBot(people[0].id, 'Bot').bot;
    r.setConfig(people[0].id, LUDO);
    r.start(people[0].id);
    expect(() => r.endGame(people[0].id)).toThrow('Ludo plays to the end. Use Stop game instead');
    expect(r.endIfOnlyBots()).toEqual([]);
    r.removeMember(people[1].id);
    const g = r.plugged as LudoGame;
    expect(g.forfeited.has(people[1].id)).toBe(true);
    // Asha finishes: only the bot still races
    g.seatOf(people[0].id).tokens = [LUDO_HOME, LUDO_HOME, LUDO_HOME, LUDO_HOME];
    g.seatOf(people[0].id).home = 4;
    g.places.push(people[0].id);
    expect(r.endIfOnlyBots().map((e) => e.kind)).toEqual(['gameOver']);
    expect(r.phase).toBe('over');
    const rec = r.snapshot('finished')!;
    expect(rec.players.find((p) => p.memberId === people[0].id)!.won).toBe(true);
    expect(rec.players.find((p) => p.memberId === people[1].id)!.loser).toBe(true);
    expect(rec.players.find((p) => p.memberId === bot.id)!.stats.tallies).toEqual({ kills: 0, killed: 0, home: 0, sixes: 0 });
    expect(rec.replay).toBeNull();
    r.backToLobby(people[0].id);
    expect(r.plugged).toBeNull();
    expect(r.view(people[0].id).plugged).toBeNull();
  });
});
