import { afterEach, describe, expect, it } from 'vitest';
import { BotDriver } from '../src/bots/driver.js';
import { Crazy7Bots } from '../src/crazy7/driver.js';
import type { GameEvent } from '../src/models.js';
import { Room } from '../src/rooms.js';
import { TurnClock } from '../src/turnClock.js';
import { TURN_TIMER, type Announcement, type GameConfig } from '../src/types.js';
import { parseConfig } from '../src/validate.js';

// 1 s on the clock is 10 ms here: turns show 300 ms, the hidden grace is 50 ms
const SPEED = 0.01;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** waits for a condition; a busy machine can make timers late */
async function until(check: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await wait(10);
  }
}
const clocks: TurnClock[] = [];

afterEach(() => clocks.splice(0).forEach((c) => c.stop()));

/** a dealt room with the turn timer on; every move is "broadcast" by waking the clock again, as the server does */
function table(config: Partial<GameConfig> = {}) {
  const r = new Room('TIME');
  const people = ['Asha', 'Ravi', 'Meena'].map((n) => r.addMember(n));
  people.forEach((m) => (m.socketId = `s-${m.id}`));
  r.setConfig(people[0].id, parseConfig({ decks: 1, bluffRule: 'one', turnTimer: true, ...config }));
  r.start(people[0].id);
  const moves: { events: GameEvent[]; notes: string[] }[] = [];
  const clock = new TurnClock(
    (room, events, notes: Announcement[]) => {
      moves.push({ events, notes: notes.map((n) => n.text) });
      clock.wake(room);
    },
    () => true,
    SPEED,
  );
  clocks.push(clock);
  clock.wake(r);
  return { r, people, clock, moves };
}

describe('turn timer', () => {
  it('is off unless the host turns it on (older apps send nothing)', () => {
    expect(parseConfig({ decks: 1, bluffRule: 'one' }).turnTimer).toBe(false);
    expect(new Room('OFFF').config.turnTimer).toBe(false);
    const { r, moves } = table({ turnTimer: false });
    expect(r.turnClock).toBeNull();
    expect(r.view(r.members[0].id).turnMsLeft).toBeNull();
    expect(moves).toEqual([]);
  });

  it('shows the time left and plays a safe move only after the hidden grace', async () => {
    const { r, moves } = table();
    const first = r.game!.turnId!;
    const left = r.view(first).turnMsLeft!;
    expect(left).toBeGreaterThan(250);
    expect(left).toBeLessThanOrEqual(TURN_TIMER.turnSec * 1000 * SPEED);
    // the shown clock is over, the grace isn't: nothing yet
    await wait(310);
    expect(moves).toEqual([]);
    await wait(80);
    expect(moves).toHaveLength(1);
    // nobody played yet this round: one card, said truthfully
    expect(moves[0].events).toMatchObject([{ kind: 'play', playerId: first, count: 1 }]);
    expect(moves[0].notes[0]).toMatch(/ran out of time/);
    expect(r.game!.turnId).not.toBe(first);
    expect(r.turnMisses.get(first)).toBe(1);
  });

  it('passes when it can, marks a player away after 2 missed turns, and their own move brings them back', async () => {
    const { r, moves } = table();
    const g = r.game!;
    // a already let one turn run out
    const [a, b] = g.order;
    r.turnMisses.set(a, 1);
    g.turnId = a;
    r.turnClock = null;
    const clock = clocks[0];
    clock.wake(r);
    await until(() => moves.length >= 1);
    expect(moves[0].events[0]).toMatchObject({ kind: 'play', playerId: a });
    expect(moves[0].notes.some((n) => n.includes('is away'))).toBe(true);
    expect(r.isAway(a)).toBe(true);
    expect(r.view(b).players.find((p) => p.id === a)!.away).toBe(true);
    // the next player passes on the last play when their time runs out
    await until(() => moves.length >= 2);
    expect(moves[1].events[0]).toMatchObject({ kind: 'pass' });
    r.markActive(a);
    expect(r.isAway(a)).toBe(false);
  });

  it('gives an away player the short clock', () => {
    const { r } = table();
    const id = r.game!.turnId!;
    r.turnMisses.set(id, TURN_TIMER.missesToAway);
    r.turnClock = null;
    clocks[0].wake(r);
    expect(r.view(id).turnMsLeft!).toBeLessThanOrEqual(TURN_TIMER.awaySec * 1000 * SPEED);
  });

  it('waits again when the server was stuck, so a move sent meanwhile still counts', async () => {
    const { r, moves } = table();
    const g = r.game!;
    const id = g.turnId!;
    // the server is stuck past the deadline; the player's move was sent and lands right after
    const end = Date.now() + 420;
    while (Date.now() < end) {
      // busy: no timers, no messages
    }
    setImmediate(() => {
      r.markActive(id);
      g.play(id, [g.hand(id)[0].id], g.hand(id)[0].rank);
      clocks[0].wake(r);
    });
    await wait(30);
    expect(moves).toEqual([]);
    expect(r.turnMisses.has(id)).toBe(false);
  });

  it('never runs for bots or while nobody is connected', () => {
    const { r } = table();
    for (const m of r.members) m.socketId = null;
    clocks[0].wake(r);
    expect(r.turnClock).toBeNull();
  });

  it('plays Crazy 7 too: a matching card, else a pick', async () => {
    const { r, moves } = table({ game: 'crazy7' });
    // automatic picks play themselves; the clock waits for a real choice
    if (r.c7!.autoDue) return;
    const id = r.c7!.turnId!;
    await until(() => moves.length > 0);
    expect(moves.length).toBeGreaterThan(0);
    expect(moves[0].events.some((e) => 'playerId' in e && e.playerId === id)).toBe(true);
  });
});

describe('turn timer: bot brain and turn length', () => {
  it('takes 15, 30 or 45 seconds (older apps: 30) and the clock uses it', () => {
    expect(parseConfig({ decks: 1, bluffRule: 'one' }).turnSec).toBe(30);
    expect(parseConfig({ decks: 1, bluffRule: 'one', turnSec: 15 }).turnSec).toBe(15);
    expect(() => parseConfig({ decks: 1, bluffRule: 'one', turnSec: 20 })).toThrow();
    const { r } = table({ turnSec: 45 });
    expect(r.view(r.members[0].id).turnMsLeft!).toBeGreaterThan(30 * 1000 * SPEED);
  });

  it("plays the bot brain's move when it has one", async () => {
    const r = new Room('BRNA');
    const people = ['Asha', 'Ravi'].map((n) => r.addMember(n));
    people.forEach((m) => (m.socketId = `s-${m.id}`));
    r.setConfig(people[0].id, parseConfig({ decks: 1, bluffRule: 'one', turnTimer: true }));
    r.start(people[0].id);
    const bots = new BotDriver({ onMove: () => undefined, onPeek: () => undefined, onChat: () => undefined }, () => true, SPEED);
    bots.wake(r);
    const asked: string[] = [];
    const moves: GameEvent[][] = [];
    const clock = new TurnClock(
      (room, events) => {
        moves.push(events);
        bots.observe(room, events);
      },
      () => true,
      SPEED,
      (room, id) => {
        asked.push(id);
        return bots.playFor(room, id);
      },
    );
    clocks.push(clock);
    const first = r.game!.turnId!;
    clock.wake(r);
    await until(() => moves.length >= 1);
    bots.stop();
    expect(asked).toEqual([first]);
    // a real opening play by the brain: any number of cards, any claim
    expect(moves[0].some((e) => e.kind === 'play' && e.playerId === first)).toBe(true);
  });

  it('lets the Crazy 7 brain play a person too', () => {
    const r = new Room('BRNC');
    const people = ['Asha', 'Ravi'].map((n) => r.addMember(n));
    people.forEach((m) => (m.socketId = `s-${m.id}`));
    r.setConfig(people[0].id, parseConfig({ decks: 1, bluffRule: 'one', game: 'crazy7', turnTimer: true }));
    r.start(people[0].id);
    const c7 = new Crazy7Bots({ onMove: () => undefined, onChat: () => undefined }, () => true, SPEED);
    c7.wake(r);
    if (r.c7!.autoDue) return;
    const id = r.c7!.turnId!;
    const events = c7.playFor(r, id);
    c7.stop();
    expect(events.length).toBeGreaterThan(0);
    expect(r.c7!.moveSeq).toBeGreaterThan(0);
  });
});
