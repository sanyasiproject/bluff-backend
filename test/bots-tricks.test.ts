import { describe, expect, it } from 'vitest';
import { chooseTurn, decideCall, type Peek, type Situation } from '../src/bots/brain.js';
import { skillOf } from '../src/bots/levels.js';
import { BotMemory } from '../src/bots/memory.js';
import type { PlanMode, Rand, Read } from '../src/bots/models.js';
import { BOT_STYLES, makePersonality } from '../src/bots/personality.js';
import { Game } from '../src/game.js';
import { emptyHabits, HABIT_KEYS } from '../src/habits.js';
import type { GameEvent, Habits } from '../src/models.js';
import { Room } from '../src/rooms.js';
import { RANKS, type BotLevel, type Card, type GameConfig, type Rank } from '../src/types.js';

/** small seeded random numbers, so every run plays the same games */
function seeded(seed: number): Rand {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CONFIG: GameConfig = { game: 'bluff', decks: 1, bluffRule: 'one', stake: 0, peeks: 0, bets: false, teams: false, handSize: 7, maxPicks: 1, stack7: true, botLevel: 'expert' };
const noPeek: Peek = () => null;
const count = (cards: Card[], r: Rank) => cards.filter((c) => c.rank === r).length;

/** one person and one bot dealt from the seed; the person's saved habits, and what the bot already learned about them in this room */
function headsUp(level: BotLevel, rand: Rand, habits: Habits | null, read?: Read, config: Partial<GameConfig> = {}) {
  const room = new Room('TEST');
  const host = room.addMember('Asha');
  room.addBot(host.id, 'Bot');
  room.setConfig(host.id, { ...CONFIG, ...config, botLevel: level });
  room.start(host.id);
  const [person, bot] = room.players().map((m) => m.id);
  room.game = new Game(room.game!.order, room.game!.config, (max) => Math.floor(rand() * max), [bot]);
  const g = room.game;
  const reads = new Map<string, Read>(read ? [[person, read]] : []);
  const mem = new BotMemory(bot, reads, new Map(), new Map([[person, habits]]));
  const me = makePersonality('shark', rand);
  const sit = (): Situation => ({ view: room.view(bot), mem, me, rand, skill: skillOf(level) });
  const feed = (events: GameEvent[]) => mem.observe(events, room.view(bot), me.tilt);
  return { room, g, person, bot, mem, sit, feed };
}

/** saved habits of someone who sets traps: fakes a rank while keeping the real cards, then plays them when the claim looks impossible */
const trapperHabits = (): Habits =>
  Object.assign(emptyHabits(), {
    openPlays: 60, openLies: 40, followPlays: 80, followLies: 20, lies: 60, lieCards: 100,
    heldLies: 50, liesKept: 46, heldHonest: 20, heldKept: 2, overPlays: 30, overLies: 4,
  });

/**
 * The trap from the table: I hold two of a rank and the bot holds the other two. I claim "two" with junk and keep mine; the bot
 * follows with its real two; then I put down my real two, which looks impossible. Whether the bot calls that (null: no such rank dealt).
 */
function trap(t: ReturnType<typeof headsUp>): boolean | null {
  if (!setTrap(t)) return null;
  const call = decideCall(t.sit(), true, noPeek);
  if (call) t.feed(g(t).callBluff(t.bot, g(t).lastPlay!.id, call.cardIndex ?? 0, 0));
  return call !== null;
}

const g = (t: ReturnType<typeof headsUp>) => t.g;

/** everything up to the impossible-looking real cards, which are left as the last play; false when no such rank was dealt */
function setTrap(t: ReturnType<typeof headsUp>): boolean {
  const { g, person, bot } = t;
  const rank = RANKS.find((r) => count(g.hand(person), r) === 2 && count(g.hand(bot), r) === 2);
  if (!rank) return false;
  g.turnId = person;
  t.feed(g.play(person, g.hand(person).filter((c) => c.rank !== rank).slice(0, 2).map((c) => c.id), rank));
  // the bot weighs the fake opening as it would at the table, then follows with its real cards
  decideCall(t.sit(), false, noPeek);
  const mine = g.hand(bot).filter((c) => c.rank === rank);
  t.mem.pendingMine = mine;
  t.feed(g.play(bot, mine.map((c) => c.id)));
  t.feed(g.play(person, g.hand(person).filter((c) => c.rank === rank).map((c) => c.id)));
  return true;
}

describe('the fake-then-real trap', () => {
  it("stops working once Hard and Expert know the player's saved habits", () => {
    for (const level of ['hard', 'expert'] as BotLevel[]) {
      let tables = 0;
      let stranger = 0;
      let known = 0;
      for (let seed = 1; tables < 30; seed++) {
        const a = trap(headsUp(level, seeded(seed * 31), null));
        if (a === null) continue;
        tables++;
        if (a) stranger++;
        if (trap(headsUp(level, seeded(seed * 31), trapperHabits()))) known++;
      }
      // a stranger's impossible-looking claim is most likely a lie; a known trapper's is most likely real
      expect(stranger / tables, level).toBeGreaterThan(0.7);
      expect(known / tables, level).toBeLessThan(0.15);
    }
  });

  it('is remembered in the room: after being trapped a few times the bot stops calling', () => {
    let read: Read | undefined;
    const calls: boolean[] = [];
    for (let seed = 1; calls.length < 20; seed++) {
      const t = headsUp('expert', seeded(seed * 17), null, read);
      const called = trap(t);
      if (called === null) continue;
      calls.push(called);
      read = t.mem.reads.get(t.person);
    }
    // a few traps in, it hardly ever calls (a rare call keeps it unpredictable)
    expect(calls.slice(6).filter(Boolean).length).toBeLessThanOrEqual(3);
  });

  it("learns a trap seen through a peek, without that peek making the trapper look more honest", () => {
    let tables = 0;
    for (let seed = 1; tables < 20; seed++) {
      const t = headsUp('expert', seeded(seed * 23), null, undefined, { peeks: 3 });
      const { g, person, bot } = t;
      const rank = RANKS.find((r) => count(g.hand(person), r) === 2 && count(g.hand(bot), r) === 2);
      if (!rank) continue;
      tables++;
      // the person's real pair ends up as their last cards, which a good bot always peeks at under "pick one"
      const real = g.hand(person).filter((c) => c.rank === rank);
      g.hands.set(person, [...real, ...g.hand(person).filter((c) => c.rank !== rank).slice(0, 2)]);
      g.turnId = person;
      t.feed(g.play(person, g.hand(person).filter((c) => c.rank !== rank).map((c) => c.id), rank));
      decideCall(t.sit(), false, noPeek);
      const mine = g.hand(bot).filter((c) => c.rank === rank);
      t.mem.pendingMine = mine;
      t.feed(g.play(bot, mine.map((c) => c.id)));
      t.feed(g.play(person, real.map((c) => c.id)));
      const before = { ...t.mem.read(person) };
      let peeks = 0;
      decideCall(t.sit(), true, (i) => {
        peeks++;
        return g.peek(bot, g.lastPlay!.id, i);
      });
      expect(peeks).toBe(1);
      const after = t.mem.read(person);
      // an over-claim is about the round, so the real card it saw doesn't make this player look more honest...
      expect(after.expected).toBe(before.expected);
      expect(after.found).toBe(before.found);
      // ...but it proves their earlier claim was the fake one
      expect(after.keptLies).toBe(before.keptLies + 1);
    }
  });

  it("doesn't take a lying over-claim for a trap when the one card turned over happens to be real", () => {
    let tables = 0;
    for (let seed = 1; tables < 20; seed++) {
      const t = headsUp('expert', seeded(seed * 11), null);
      const { g, person, bot } = t;
      // the person holds three of a rank and the bot the fourth
      const rank = RANKS.find((r) => count(g.hand(person), r) === 3 && count(g.hand(bot), r) === 1);
      if (!rank) continue;
      tables++;
      const mine = g.hand(person).filter((c) => c.rank === rank);
      const junk = g.hand(person).find((c) => c.rank !== rank)!;
      g.turnId = person;
      // two real ones, the bot's real one, then a real one and a fake: five claimed of four, and the last play is the lie
      t.feed(g.play(person, mine.slice(0, 2).map((c) => c.id), rank));
      decideCall(t.sit(), false, noPeek);
      const its = g.hand(bot).filter((c) => c.rank === rank);
      t.mem.pendingMine = its;
      t.feed(g.play(bot, its.map((c) => c.id)));
      t.feed(g.play(person, [mine[2].id, junk.id]));
      decideCall(t.sit(), false, noPeek);
      // the call turns over the real card: it holds up, but nothing proves an earlier claim was fake
      t.feed(g.callBluff(bot, g.lastPlay!.id, 0, 0));
      const read = t.mem.reads.get(person)!;
      expect(read.keptLies).toBe(0);
      expect(read.overHonest).toBeCloseTo(0.5, 9);
    }
  });
});

/** two people (P, then Q) and a bot after them, dealt from the seed; what the bot already learned about P in this room */
function threeWay(rand: Rand, read?: Read, config: Partial<GameConfig> = {}) {
  const room = new Room('TEST');
  const host = room.addMember('Asha');
  room.addMember('Ravi');
  room.addBot(host.id, 'Bot');
  room.setConfig(host.id, { ...CONFIG, ...config });
  room.start(host.id);
  const [p, q, bot] = room.players().map((m) => m.id);
  room.game = new Game(room.game!.order, room.game!.config, (max) => Math.floor(rand() * max), [bot]);
  const g = room.game;
  const mem = new BotMemory(bot, new Map<string, Read>(read ? [[p, read]] : []), new Map(), new Map());
  const me = makePersonality('shark', rand);
  const sit = (): Situation => ({ view: room.view(bot), mem, me, rand, skill: skillOf('expert') });
  const feed = (events: GameEvent[]) => mem.observe(events, room.view(bot), me.tilt);
  return { g, p, q, bot, mem, sit, feed };
}

describe('traps only the bot can see', () => {
  /**
   * P holds two of a rank and the bot the other two, which it keeps. P claims one with junk, Q pushes one, the bot passes holding its
   * pair, and P puts down the real pair: only 4 claimed in all, but with the bot's pair that's 6. Returns whether the bot calls it.
   */
  function privateTrap(t: ReturnType<typeof threeWay>, forceCall: boolean): boolean | null {
    const { g, p, q, bot } = t;
    const rank = RANKS.find((r) => count(g.hand(p), r) === 2 && count(g.hand(bot), r) === 2);
    if (!rank) return null;
    g.turnId = p;
    t.feed(g.play(p, [g.hand(p).find((c) => c.rank !== rank)!.id], rank));
    t.feed(g.play(q, [g.hand(q).find((c) => c.rank !== rank)!.id]));
    t.feed(g.pass(bot));
    t.feed(g.play(p, g.hand(p).filter((c) => c.rank === rank).map((c) => c.id)));
    const call = decideCall(t.sit(), false, noPeek);
    if (call || forceCall) t.feed(g.callBluff(bot, g.lastPlay!.id, call?.cardIndex ?? 0, 0));
    return call !== null;
  }

  it('learns it the right way: a sprung trap, not a more honest player', () => {
    let tables = 0;
    for (let seed = 1; tables < 20; seed++) {
      const t = threeWay(seeded(seed * 41), undefined, { bluffRule: 'all' });
      const before = { ...t.mem.read(t.p) };
      if (privateTrap(t, true) === null) continue;
      tables++;
      const after = t.mem.read(t.p);
      expect(after.keptLies).toBe(before.keptLies + 1);
      expect(after.overHonest).toBe(before.overHonest + 1);
      expect(after.expected).toBe(before.expected);
    }
  });

  it('stops working within a room', () => {
    let read: Read | undefined;
    const calls: boolean[] = [];
    for (let seed = 1; calls.length < 20; seed++) {
      const t = threeWay(seeded(seed * 43), read, { bluffRule: 'all' });
      const called = privateTrap(t, false);
      if (called === null) continue;
      calls.push(called);
      read = t.mem.reads.get(t.p);
    }
    expect(calls.slice(6).filter(Boolean).length).toBeLessThanOrEqual(3);
  });
});

describe('peeks', () => {
  it('never look at the same card twice when a bot weighs a play again on its turn, and credit no trap the cards do not prove', () => {
    let peeks = 0;
    for (let seed = 1; seed <= 120; seed++) {
      const t = threeWay(seeded(seed * 47), undefined, { bluffRule: 'all', peeks: 3 });
      const { g, p, q, bot } = t;
      // P and the bot hold two each; P plays one real, Q pushes a fake, the bot plays its real two, P plays the last real one
      const rank = RANKS.find((r) => count(g.hand(p), r) === 2 && count(g.hand(bot), r) === 2);
      if (!rank) continue;
      g.turnId = p;
      const real = g.hand(p).filter((c) => c.rank === rank);
      t.feed(g.play(p, [real[0].id], rank));
      t.feed(g.play(q, [g.hand(q).find((c) => c.rank !== rank)!.id]));
      const mine = g.hand(bot).filter((c) => c.rank === rank);
      t.mem.pendingMine = mine;
      t.feed(g.play(bot, mine.map((c) => c.id)));
      t.feed(g.play(p, [real[1].id]));
      const looked: number[] = [];
      const look: Peek = (i) => {
        looked.push(i);
        return g.peek(bot, g.lastPlay!.id, i);
      };
      // weighed once while Q is on turn, then again on its own turn
      decideCall(t.sit(), false, look);
      t.feed(g.pass(q));
      decideCall(t.sit(), true, look);
      peeks += looked.length;
      expect(new Set(looked).size).toBe(looked.length);
      // P's first claim was honest: 2 sure + 1 real + 1 earlier is exactly 4
      expect(t.mem.read(p).keptLies).toBe(0);
    }
    expect(peeks).toBeGreaterThan(5);
  });
});

describe('slow play', () => {
  it('never passes up a play that goes out', () => {
    let passes = 0;
    for (let seed = 1; seed <= 300; seed++) {
      const t = headsUp('expert', seeded(seed * 53), null, undefined, { decks: 2 });
      const { g, person, bot } = t;
      // two decks: the bot holds five Kings and nothing else; the person opens Kings with plenty of cards left
      const kings = [...g.hand(person), ...g.hand(bot)].filter((c) => c.rank === 'K').slice(0, 5);
      if (kings.length < 5) continue;
      g.hands.set(person, g.hand(person).filter((c) => !kings.includes(c)));
      g.hands.set(bot, kings);
      g.turnId = person;
      t.feed(g.play(person, [g.hand(person).find((c) => c.rank !== 'K')!.id], 'K'));
      if (chooseTurn(t.sit(), noPeek).kind === 'pass') passes++;
    }
    expect(passes).toBe(0);
  });
});

/** every seat played by the engine at one level, with every bot move tallied */
function engineGames(level: BotLevel, games: number, seats: number) {
  const tally = { plays: 0, lies: 0, holdingTurns: 0, keptBack: 0, holdPasses: 0, modes: [] as number[], switches: [] as number[] };
  for (let i = 0; i < games; i++) {
    const rand = seeded(9000 + i * 13);
    const room = new Room('TEST');
    const host = room.addMember('Host');
    for (let k = 1; k < seats; k++) room.addBot(host.id, `B${k}`);
    room.setConfig(host.id, { ...CONFIG, botLevel: level });
    room.start(host.id);
    room.game = new Game(room.game!.order, room.game!.config, (max) => Math.floor(rand() * max));
    const g = room.game;
    const bots = room.players().map((m, k) => ({ id: m.id, me: makePersonality(BOT_STYLES[(i + k) % BOT_STYLES.length], rand), mem: new BotMemory(m.id, new Map(), new Map()), modes: new Set<PlanMode>(), plans: 0 }));
    const sit = (b: (typeof bots)[number]): Situation => ({ view: room.view(b.id), mem: b.mem, me: b.me, rand, skill: skillOf(level) });
    const feed = (events: GameEvent[]) => bots.forEach((b) => b.mem.observe(events, room.view(b.id), b.me.tilt));
    for (let moves = 0; !g.over && g.places.length === 0 && moves < 4000; moves++) {
      if (g.lastPlay) {
        const caller = bots.find((b) => b.id !== g.turnId && g.hand(b.id).length > 0 && g.lastPlay!.playerId !== b.id && decideCall(sit(b), false, noPeek));
        if (caller) {
          feed(g.callBluff(caller.id, g.lastPlay.id, decideCall(sit(caller), false, noPeek)?.cardIndex ?? 0, 0));
          continue;
        }
      }
      const b = bots.find((x) => x.id === g.turnId)!;
      const hand = [...g.hand(b.id)];
      const rank = g.roundRank;
      const plan = b.mem.plan;
      const move = chooseTurn(sit(b), noPeek);
      if (b.mem.plan && b.mem.plan !== plan) {
        b.plans++;
        b.modes.add(b.mem.plan.mode);
      }
      const held = rank ? count(hand, rank) : 0;
      if (rank && held > 0 && hand.length > held) tally.holdingTurns++;
      if (move.kind === 'play') {
        const cards = move.cardIds.map((id) => hand.find((c) => c.id === id)!);
        const claim = (rank ?? move.rank) as Rank;
        b.mem.pendingMine = cards;
        tally.plays++;
        if (cards.some((c) => c.rank !== claim)) tally.lies++;
        if (rank && held > 0 && count(cards, rank) < held && hand.length > held) tally.keptBack++;
        feed(g.play(b.id, move.cardIds, move.rank));
      } else if (move.kind === 'pass') {
        if (held > 0 && hand.length > held) {
          tally.keptBack++;
          tally.holdPasses++;
        }
        feed(g.pass(b.id));
      } else feed(g.callBluff(b.id, g.lastPlay!.id, move.cardIndex, 0));
    }
    for (const b of bots) {
      tally.modes.push(b.modes.size);
      tally.switches.push(b.plans);
    }
  }
  return tally;
}

describe('bots that are hard to read', () => {
  it('lie in a large share of their plays at every level, so a claim can never be taken on trust', () => {
    for (const level of ['normal', 'hard', 'expert'] as BotLevel[]) {
      const t = engineGames(level, 12, 3);
      expect(t.lies / t.plays, level).toBeGreaterThan(0.3);
    }
  });

  it('change plans every few rounds and sometimes keep their real cards back, even by passing while holding the rank', () => {
    const t = engineGames('expert', 12, 3);
    const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    // several plans a game, and more than one kind of plan
    expect(avg(t.switches)).toBeGreaterThan(3);
    expect(avg(t.modes)).toBeGreaterThan(1.8);
    expect(t.keptBack / t.holdingTurns).toBeGreaterThan(0.05);
    expect(t.holdPasses).toBeGreaterThan(0);
  });

  it('lie more to someone who never calls bots than to someone who calls them a lot (saved habits)', () => {
    const lieRate = (habits: Habits, bluffRule: 'one' | 'all') => {
      let lies = 0;
      let plays = 0;
      for (let seed = 1; seed <= 80; seed++) {
        const t = headsUp('expert', seeded(seed * 7), habits, undefined, { bluffRule });
        t.g.turnId = t.bot;
        const move = chooseTurn(t.sit(), noPeek);
        if (move.kind !== 'play') continue;
        plays++;
        const cards = move.cardIds.map((id) => t.g.hand(t.bot).find((c) => c.id === id)!);
        if (cards.some((c) => c.rank !== move.rank)) lies++;
      }
      return lies / plays;
    };
    const base = { openPlays: 50, followPlays: 80, pushes: 20, passNone: 20, lies: 30, lieCards: 40 };
    const trusting = Object.assign(emptyHabits(), base, { botSeen: 300, botCalls: 3, botLieSeen: 150, botLieCalls: 2 });
    const suspicious = Object.assign(emptyHabits(), base, { botSeen: 300, botCalls: 150, botLieSeen: 150, botLieCalls: 110 });
    // under "show all" a call shows every fake, so a caller gets far fewer; under "pick one" padding stays cheap, but still less
    expect(lieRate(trusting, 'all')).toBeGreaterThan(lieRate(suspicious, 'all') + 0.15);
    expect(lieRate(trusting, 'one')).toBeGreaterThan(lieRate(suspicious, 'one') + 0.05);
  });
});

/**
 * A person who plays around the bots the way people found worked on the old ones: never calls a bot except its last cards,
 * fakes a rank they hold while keeping the real cards, plays those real cards once the claims look impossible, otherwise honest,
 * and never goes out on fakes. Their habits are saved after each game, as the server does.
 */
function trapperVsBot(level: BotLevel, games: number): number {
  let wins = 0;
  const saved = emptyHabits();
  let read: Read | undefined;
  for (let i = 0; i < games; i++) {
    const rand = seeded(500 + i * 29);
    const t = headsUp(level, rand, i > 0 ? { ...saved } : null, read);
    const { g, person, bot } = t;
    let armed: Rank | null = null;
    const play = (cards: Card[], rank?: Rank) => t.feed(g.play(person, cards.map((c) => c.id), g.roundRank ? undefined : rank));
    for (let moves = 0; !g.over && g.places.length === 0 && moves < 3000; moves++) {
      const lp = g.lastPlay;
      // only the bot's last cards get called
      if (lp && lp.playerId === bot && g.hand(bot).length === 0) {
        t.feed(g.callBluff(person, lp.id, Math.floor(rand() * lp.cards.length), 0));
        continue;
      }
      if (g.turnId === bot) {
        const move = chooseTurn(t.sit(), noPeek);
        if (move.kind === 'play') t.mem.pendingMine = move.cardIds.map((id) => g.hand(bot).find((c) => c.id === id)!);
        t.feed(move.kind === 'call' ? g.callBluff(bot, g.lastPlay!.id, move.cardIndex, 0) : move.kind === 'pass' ? g.pass(bot) : g.play(bot, move.cardIds, move.rank));
        continue;
      }
      const hand = g.hand(person);
      const rank = g.roundRank;
      if (rank) {
        const real = hand.filter((c) => c.rank === rank);
        if (real.length > 0 && (armed === rank || real.length === hand.length)) {
          armed = null;
          play(real);
        } else if (real.length > 0) play(real);
        else if (lp) t.feed(g.pass(person));
        else play(hand.slice(0, 1));
        continue;
      }
      armed = null;
      const groups = RANKS.map((r) => ({ r, cards: hand.filter((c) => c.rank === r) })).filter((x) => x.cards.length > 0);
      if (groups.length === 1) {
        play(hand, hand[0].rank);
        continue;
      }
      // the trap: claim a rank I hold one or two of, with as many junk cards, and keep the real ones
      const small = groups.find((x) => x.cards.length <= 2 && hand.length - x.cards.length > x.cards.length);
      if (small) {
        armed = small.r;
        play(hand.filter((c) => c.rank !== small.r).slice(0, small.cards.length), small.r);
      } else {
        const big = groups.sort((a, b) => b.cards.length - a.cards.length)[0];
        play(big.cards, big.r);
      }
    }
    if (g.places[0] === person) wins++;
    const h = g.stats.get(person)!.habits!;
    for (const k of HABIT_KEYS) saved[k] += h[k];
    read = t.mem.reads.get(person);
  }
  return wins / games;
}

describe('a player who plays around the bots', () => {
  it('rarely beats a Hard or Expert bot heads-up with fake-first-real-later', () => {
    // an even game is 50%; this trick used to beat Expert bots most of the time
    expect(trapperVsBot('expert', 30)).toBeLessThan(0.3);
    expect(trapperVsBot('hard', 30)).toBeLessThan(0.3);
  });
});
