import { afterEach, describe, expect, it, vi } from 'vitest';
import { RangClock } from '../src/rang/clock.js';
import { Room } from '../src/rooms.js';
import { RANG_HAND_SIZE } from '../src/types.js';
import { parseConfig } from '../src/validate.js';

const RANG = parseConfig({ decks: 1, bluffRule: 'one', game: 'rang' });

/** a Rang room with these people (the first is host), dealt */
function room(names: string[]) {
  const r = new Room('RANG');
  const people = names.map((n) => r.addMember(n));
  // their app knows Rang
  for (const p of people) p.hasRang = true;
  r.setConfig(people[0].id, RANG);
  r.start(people[0].id);
  return { r, people };
}

describe('Rang in a room', () => {
  it('2v2: each player gets their partner\'s cards, never an opponent\'s', () => {
    const r = new Room('RTWO');
    const people = ['Asha', 'Ravi', 'Kiran', 'Meera'].map((n) => r.addMember(n));
    for (const p of people) p.hasRang = true;
    r.setConfig(people[0].id, { ...RANG, teams: true });
    r.start(people[0].id);
    const g = r.rang!;
    expect(g.teams).not.toBeNull();
    for (const p of people) {
      const v = r.view(p.id).rang!;
      const mate = g.partnerOf(p.id)!;
      expect(v.partner!.map((c) => c.id)).toEqual(g.hand(mate).map((c) => c.id));
      // the two opponents' cards appear nowhere in this player's view
      const others = people.map((x) => x.id).filter((id) => id !== p.id && id !== mate);
      const json = JSON.stringify(r.view(p.id));
      for (const o of others) expect(g.hand(o).some((c) => json.includes(`"${c.id}"`))).toBe(false);
    }
  });

  it('no partner cards outside 2v2', () => {
    const { r, people } = room(['Asha', 'Ravi']);
    expect(r.view(people[0].id).rang!.partner).toBeNull();
  });

  it('reads its settings with defaults for older apps', () => {
    expect(RANG).toMatchObject({ game: 'rang', rangPicks: 1, rangStack: true, rangChallenge: true, rangSwap: false, c7Power: false });
    expect(parseConfig({ decks: 1, bluffRule: 'one', game: 'rang', rangPicks: 7, rangSwap: true })).toMatchObject({ rangPicks: 7, rangSwap: true });
    expect(() => parseConfig({ decks: 1, bluffRule: 'one', game: 'rang', rangPicks: 8 })).toThrow('Invalid settings');
    expect(() => parseConfig({ decks: 1, bluffRule: 'one', rangStack: 'yes' })).toThrow('Invalid settings');
  });

  it('waits for players on an older app to update before dealing Rang or Crazy 7 power cards', () => {
    const r = new Room('OLDA');
    const [asha, ravi] = [r.addMember('Asha'), r.addMember('Ravi')];
    asha.hasRang = true;
    r.setConfig(asha.id, RANG);
    expect(() => r.start(asha.id)).toThrow('Ravi must update the app (reload it) to play Rang');
    r.setConfig(asha.id, { ...RANG, game: 'crazy7', c7Power: true });
    expect(() => r.start(asha.id)).toThrow('Ravi must update the app (reload it) to play with power cards');
    // plain Crazy 7 still works with an older app
    r.setConfig(asha.id, { ...RANG, game: 'crazy7', c7Power: false });
    expect(() => r.start(asha.id)).not.toThrow();
    void ravi;
  });

  it('deals a stepwise Rang game; each seat sees only its own hand in rang.hand, watchers see all', () => {
    const { r, people } = room(['Asha', 'Ravi']);
    const [asha, ravi] = people;
    expect(r.rang).not.toBeNull();
    expect(r.rang!.stepwise).toBe(true);
    expect(r.game).toBeNull();
    expect(r.c7).toBeNull();
    const v = r.view(asha.id);
    expect(v.phase).toBe('playing');
    expect(v.hand).toEqual([]);
    expect(v.crazy7).toBeNull();
    expect(v.rang!.hand).toHaveLength(RANG_HAND_SIZE);
    expect(v.rang!.watch).toBeNull();
    // never another player's cards
    const theirs = r.rang!.hand(ravi.id).map((c) => c.id);
    expect(theirs.some((id) => JSON.stringify(v).includes(`"${id}"`))).toBe(false);
    expect(v.rang!.color).toBe(r.rang!.top()!.color);
    expect(v.players.map((p) => p.cardCount)).toEqual([RANG_HAND_SIZE, RANG_HAND_SIZE]);

    const watcher = r.addMember('Meena');
    const w = r.view(watcher.id);
    expect(Object.keys(w.rang!.watch!)).toEqual([asha.id, ravi.id]);
    expect(w.rang!.hand).toEqual([]);
    expect(w.rang!.playable).toEqual([]);
  });

  it('announces plays, has no End game, and saves a replay with the top card and colour', () => {
    const { r, people } = room(['Asha', 'Ravi', 'Meena']);
    const g = r.rang!;
    expect(() => r.endGame(people[0].id)).toThrow('In Rang the first player out wins');
    // the player on turn plays a wild naming blue
    const id = g.turnId!;
    const wild = { id: 'rg-w-wild-1', color: null, value: 'wild' as const };
    for (const p of g.order) g.hands.set(p, g.hand(p).filter((c) => c.id !== wild.id));
    g.deck = g.deck.filter((c) => c.id !== wild.id);
    g.pile = g.pile.filter((c) => c.id !== wild.id);
    g.hand(id).push(wild);
    const events = g.play(id, wild.id, { color: 'blue' });
    const lines = r.announce(events).map((a) => a.text);
    expect(lines[0]).toBe(`${r.members.find((m) => m.id === id)!.name} played a wild. Blue next`);
    r.recordStep(lines, events);
    expect(r.view(id).rang!.color).toBe('blue');

    const rec = r.snapshot('ended_early')!;
    expect(rec.config.game).toBe('rang');
    expect(rec.replay!.game).toBe('rang');
    expect(rec.replay!.cards).toBe(false);
    expect(rec.replay!.steps.at(-1)).toMatchObject({ rangTop: { id: wild.id }, rangColor: 'blue' });
    // every person got a Rang secret card
    expect(rec.players.every((p) => p.secret && ['rgStack', 'rgWilds', 'rgLast'].includes(p.secret.id))).toBe(true);

    r.backToLobby(people[0].id);
    expect(r.rang).toBeNull();
    expect(r.view(people[0].id).rang).toBeNull();
  });

  describe('game time', () => {
    afterEach(() => vi.useRealTimers());

    it('sets the end with the deal, shows time left, and the clock ends the game when it runs out', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-11-22T10:00:00Z'));
      const r = new Room('TIME');
      const [asha, ravi] = [r.addMember('Asha'), r.addMember('Ravi')];
      asha.hasRang = ravi.hasRang = true;
      r.setConfig(asha.id, { ...RANG, rangTime: 3 });
      r.start(asha.id);
      expect(r.rang!.endsAt).toBe(Date.now() + 180_000);
      expect(r.view(asha.id).rang!.msLeft).toBe(180_000);
      const moves: string[][] = [];
      const clock = new RangClock(
        (room, events) => moves.push(room.announce(events).map((a) => a.text)),
        () => true,
      );
      clock.wake(r);
      vi.advanceTimersByTime(179_000);
      expect(r.rang!.over).toBe(false);
      vi.advanceTimersByTime(1_000);
      expect(r.rang!.over).toBe(true);
      expect(r.view(asha.id).rang!.timedOut).toBe(true);
      expect(moves[0][0]).toMatch(/^Time's up! .+ (wins with|share first with) \d+ points$/);
      clock.stop();
    });

    it('no limit by default', () => {
      const { r, people } = room(['Asha', 'Ravi']);
      expect(r.rang!.endsAt).toBeNull();
      expect(r.view(people[0].id).rang!.msLeft).toBeNull();
      expect(() => parseConfig({ decks: 1, bluffRule: 'one', game: 'rang', rangTime: 4 })).toThrow('Invalid settings');
    });
  });
});
