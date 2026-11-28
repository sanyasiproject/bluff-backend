import { describe, expect, it } from 'vitest';
import type { RmcsGame } from '../src/games/rmcs/game.js';
import type { SnakesGame } from '../src/games/snakes/game.js';
import { Room } from '../src/rooms.js';
import { RMCS_CHAT, SNAKES_CHAT, chatSetOf, speaksQuickChat } from '../src/types.js';
import { parseConfig } from '../src/validate.js';

const SNAKES = parseConfig({ decks: 1, bluffRule: 'one', game: 'snakes', opts: { exact: false } });
const RMCS = parseConfig({ decks: 1, bluffRule: 'one', game: 'rmcs', opts: { rounds: 10 } });

/** a lobby with these people (the first is host), whose apps have both games */
function lobby(names: string[]) {
  const r = new Room('PARTY');
  const people = names.map((n) => r.addMember(n));
  for (const p of people) p.games = ['ludo', 'snakes', 'rmcs'];
  return { r, people };
}

describe('Saanp Seedhi in a room', () => {
  it('every seat and watcher sees the same board, with no cards', () => {
    const { r, people } = lobby(['Asha', 'Ravi', 'Meena']);
    r.setConfig(people[0].id, SNAKES);
    expect(r.config.opts).toEqual({ exact: false });
    r.start(people[0].id);
    const watcher = r.addMember('Zoya');
    const views = [...people, watcher].map((m) => r.view(m.id));
    for (const v of views) {
      expect(v.plugged?.kind).toBe('snakes');
      expect(v.plugged).toEqual(views[0].plugged);
      expect(v.hand).toEqual([]);
      expect(v.secret).toBeNull();
    }
    const sv = views[0].plugged!.kind === 'snakes' ? views[0].plugged!.snakes : null;
    expect(sv!.seats.map((s) => s.playerId)).toEqual(people.map((p) => p.id));
    expect(sv!.rules).toEqual({ exact: false, six: true, bonus: true, bite: true });
    expect(sv!.turnId).toBe(views[0].turnId);
  });

  it("an app without the game can't start it; leaving forfeits; tallies reach the record", () => {
    const { r, people } = lobby(['Asha', 'Ravi']);
    people[1].games = ['ludo'];
    r.setConfig(people[0].id, SNAKES);
    expect(() => r.start(people[0].id)).toThrow('Ravi must update the app (reload it) to play Saanp Seedhi');
    people[1].games = ['snakes'];
    r.addBot(people[0].id, 'Bot');
    r.start(people[0].id);
    expect(() => r.endGame(people[0].id)).toThrow('Saanp Seedhi plays to the end. Use Stop game instead');
    r.removeMember(people[1].id);
    const g = r.plugged as SnakesGame;
    expect(g.forfeited.has(people[1].id)).toBe(true);
    g.seatOf(people[0].id).place = 1;
    g.places.push(people[0].id);
    expect(r.endIfOnlyBots().map((e) => e.kind)).toEqual(['gameOver']);
    const rec = r.snapshot('finished')!;
    expect(rec.players.find((p) => p.memberId === people[0].id)!.won).toBe(true);
    expect(rec.players.find((p) => p.memberId === people[1].id)!.loser).toBe(true);
    expect(rec.players[0].stats.tallies).toEqual({ ladders: 0, snakes: 0, bites: 0 });
  });

  it('uses its own chat set and voice', () => {
    expect(chatSetOf('snakes')).toBe(SNAKES_CHAT);
    expect(chatSetOf('rmcs')).toBe(RMCS_CHAT);
    for (const k of ['snakes', 'rmcs'] as const) {
      expect(chatSetOf(k).voice?.length).toBe(chatSetOf(k).messages.length);
      expect(speaksQuickChat(k)).toBe(true);
    }
    expect(speaksQuickChat('crazy7')).toBe(false);
  });
});

describe('Raja Mantri in a room', () => {
  it('needs exactly 4: fewer is refused until bots fill the table', () => {
    const { r, people } = lobby(['Asha', 'Ravi', 'Meena']);
    r.setConfig(people[0].id, RMCS);
    expect(() => r.start(people[0].id)).toThrow('Raja Mantri Chor Sipahi needs exactly 4 players. Add bots to fill the table');
    r.addBot(people[0].id, 'Bot');
    expect(() => r.addBot(people[0].id, 'Bot 2')).toThrow('All 4 seats are taken');
    r.start(people[0].id);
    expect((r.plugged as RmcsGame).rounds).toBe(10);
  });

  it('each seat sees only its own chit; a watcher sees none until the result', () => {
    const { r, people } = lobby(['Asha', 'Ravi', 'Meena', 'Kabir']);
    r.setConfig(people[0].id, RMCS);
    r.start(people[0].id);
    const g = r.plugged as RmcsGame;
    const watcher = r.addMember('Zoya');
    for (const p of people) {
      const v = r.view(p.id).plugged!;
      expect(v.kind).toBe('rmcs');
      const rv = v.kind === 'rmcs' ? v.rmcs : null;
      expect(rv!.myRole).toBe(g.roles.get(p.id));
      expect(rv!.shown).toEqual({});
      // no other role anywhere in this player's view
      const others = people.filter((o) => o.id !== p.id).map((o) => g.roles.get(o.id)!);
      const text = JSON.stringify(r.view(p.id));
      for (const role of others) expect(text).not.toContain(`"${role}"`);
    }
    const wv = r.view(watcher.id).plugged!;
    expect(wv.kind === 'rmcs' && wv.rmcs.myRole).toBeNull();
    expect(r.view(watcher.id).turnId).toBeNull();
    for (const p of people) g.open(p.id);
    const mantri = g.holderOf('mantri');
    expect(r.view(people[0].id).turnId).toBe(mantri);
    g.guess(mantri, g.suspects()[0]);
    const after = r.view(watcher.id).plugged!;
    expect(after.kind === 'rmcs' && Object.keys(after.rmcs.shown)).toHaveLength(4);
  });
});
