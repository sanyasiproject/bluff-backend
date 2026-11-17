import { afterEach, describe, expect, it, vi } from 'vitest';
import { chooseTurn, decideCall, suspicion, type Peek, type Situation } from '../src/bots/brain.js';
import { BotDriver } from '../src/bots/driver.js';
import { skillOf } from '../src/bots/levels.js';
import { BotMemory } from '../src/bots/memory.js';
import type { BotStyle, Rand } from '../src/bots/models.js';
import { BOT_STYLES, makePersonality } from '../src/bots/personality.js';
import { Game } from '../src/game.js';
import { emptyHabits } from '../src/habits.js';
import type { GameEvent, Habits } from '../src/models.js';
import { Room } from '../src/rooms.js';
import type { BotLevel, Card, GameConfig, Rank } from '../src/types.js';

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

/** one person ("Asha") and bots, the person's habits saved from past games */
function table(bots: number, config: Partial<GameConfig>, rand: Rand, habits: Habits | null = null) {
  const room = new Room('TEST');
  const host = room.addMember('Asha');
  for (let i = 0; i < bots; i++) room.addBot(host.id, `Bot${i}`);
  room.setConfig(host.id, { ...CONFIG, ...config });
  room.start(host.id);
  // dealt again from the seed, so every run plays the same cards
  room.game = new Game(room.game!.order, room.game!.config, (max) => Math.floor(rand() * max));
  const g = room.game;
  const [person, ...botIds] = room.players().map((m) => m.id);
  const styles = [...BOT_STYLES].sort(() => rand() - 0.5);
  const seats = botIds.map((id, i) => ({
    id,
    me: makePersonality(styles[i % styles.length] as BotStyle, rand),
    mem: new BotMemory(id, new Map(), new Map(), new Map([[person, habits]])),
  }));
  type Seat = (typeof seats)[number];
  const sit = (s: Seat, level: BotLevel = room.config.botLevel): Situation => ({ view: room.view(s.id), mem: s.mem, me: s.me, rand, skill: skillOf(level) });
  const feed = (events: GameEvent[]) => seats.forEach((s) => s.mem.observe(events, room.view(s.id), s.me.tilt));
  return { room, g, person, seats, sit, feed };
}

/** the rank the person holds most of, and their cards of it */
function biggest(hand: Card[]): { rank: Rank; cards: Card[] } {
  const groups = new Map<Rank, Card[]>();
  for (const c of hand) groups.set(c.rank, [...(groups.get(c.rank) ?? []), c]);
  const [rank, cards] = [...groups.entries()].sort((a, b) => b[1].length - a[1].length)[0];
  return { rank, cards };
}

/** a heavy liar's saved record: fakes in most plays, usually the last card */
function liarHabits(): Habits {
  const h = emptyHabits();
  Object.assign(h, {
    followPlays: 200, followLies: 170, openPlays: 60, openLies: 50, pushes: 90, passNone: 5, lies: 310, lieCards: 420,
    slotFirst: 120, fakeFirst: 6, slotMid: 60, fakeMid: 10, slotLast: 120, fakeLast: 110, endTurns: 30, endFakes: 27,
  });
  return h;
}

/** how often the first bot calls the person's opening play, over many deals (at most `realMax` of the cards are real) */
function callShare(level: BotLevel, decks: 1 | 2, claimSize: number, realMax = 4, bots = 3): number {
  let calls = 0;
  const runs = 40;
  for (let seed = 1; seed <= runs; seed++) {
    const rand = seeded(seed * 97);
    const { g, person, seats, sit, feed } = table(bots, { decks, botLevel: level }, rand);
    g.turnId = person;
    const { rank, cards } = biggest(g.hand(person));
    const real = cards.slice(0, Math.min(claimSize, realMax));
    const fakes = g.hand(person).filter((c) => c.rank !== rank).slice(0, claimSize - real.length);
    feed(g.play(person, [...real, ...fakes].map((c) => c.id), rank));
    if (decideCall(sit(seats[0]), false, noPeek)) calls++;
  }
  return calls / runs;
}

describe('bot lie detector', () => {
  it('calls big claims that card counting makes near impossible, by the number of decks', () => {
    // one deck has 4 of a rank: 6 cards of one rank is a lie, and the bots know it
    expect(callShare('expert', 1, 6)).toBeGreaterThanOrEqual(0.9);
    expect(callShare('hard', 1, 6)).toBeGreaterThanOrEqual(0.8);
    expect(callShare('normal', 1, 6)).toBeGreaterThanOrEqual(0.6);
    // two decks have 8: 6 of a rank can be true, but 7 with only a few real ones gets called
    expect(callShare('expert', 2, 7, 3)).toBeGreaterThanOrEqual(0.8);
  });

  it('leaves a small honest-looking opening alone', () => {
    expect(callShare('expert', 1, 1)).toBeLessThanOrEqual(0.1);
  });

  it('checks a player who goes out on a likely lie', () => {
    let calls = 0;
    for (let seed = 1; seed <= 30; seed++) {
      const rand = seeded(seed * 31);
      const { g, person, seats, sit, feed } = table(1, {}, rand);
      const bot = seats[0];
      // the bot opens a round; the person answers with their last card, which isn't that rank
      g.turnId = bot.id;
      const open = g.hand(bot.id)[0];
      g.hands.set(person, [{ id: 'X1', rank: open.rank === '5' ? '6' : '5', suit: 'S' }]);
      bot.mem.pendingMine = [open];
      feed(g.play(bot.id, [open.id], open.rank));
      feed(g.play(person, ['X1']));
      if (decideCall(sit(bot), true, noPeek)) calls++;
    }
    expect(calls).toBeGreaterThanOrEqual(26);
  });

  it('turns over the card a player usually fakes, from their saved habits', () => {
    let calls = 0;
    let last = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const rand = seeded(seed * 13);
      const { g, person, seats, sit, feed } = table(3, {}, rand, liarHabits());
      g.turnId = person;
      const { rank, cards } = biggest(g.hand(person));
      const fake = g.hand(person).find((c) => c.rank !== rank)!;
      // real cards first, the fake tapped last
      const play = [...cards.slice(0, 2), fake];
      feed(g.play(person, play.map((c) => c.id), rank));
      const call = decideCall(sit(seats[0]), false, noPeek);
      if (!call) continue;
      calls++;
      if (call.cardIndex === play.length - 1) last++;
    }
    expect(calls).toBeGreaterThanOrEqual(20);
    expect(last / calls).toBeGreaterThanOrEqual(0.9);
  });

  it('reads a habitual liar from saved habits at Expert; Normal ignores saved habits', () => {
    // the same table, read with and without the person's saved record
    const compare = (level: BotLevel) => {
      let known = 0;
      let unknown = 0;
      for (let seed = 1; seed <= 20; seed++) {
        const { room, g, person, seats, feed } = table(2, {}, seeded(seed * 7), liarHabits());
        g.turnId = person;
        const { rank, cards } = biggest(g.hand(person));
        feed(g.play(person, cards.slice(0, 2).map((c) => c.id), rank));
        const bot = seats[0];
        const at = (rand: Rand): Situation => ({ view: room.view(bot.id), mem: bot.mem, me: bot.me, rand, skill: skillOf(level) });
        known += suspicion(at(seeded(seed))).p;
        bot.mem.habits.set(person, null);
        unknown += suspicion(at(seeded(seed))).p;
      }
      return { known: known / 20, unknown: unknown / 20 };
    };
    const expert = compare('expert');
    expect(expert.known).toBeGreaterThan(expert.unknown + 0.2);
    const normal = compare('normal');
    expect(normal.known).toBeCloseTo(normal.unknown, 9);
  });

  it('peeks only when it pays: never on a sure lie, and at the likeliest fake on a big unsure pile', () => {
    // a sure lie under "show all": it just calls
    const rand = seeded(5);
    const sure = table(3, { bluffRule: 'all', peeks: 2 }, rand);
    sure.g.turnId = sure.person;
    const { rank } = biggest(sure.g.hand(sure.person));
    const lie = sure.g.hand(sure.person).filter((c) => c.rank !== rank).slice(0, 5);
    sure.feed(sure.g.play(sure.person, lie.map((c) => c.id), rank));
    let peeked = 0;
    const call = decideCall(sure.sit(sure.seats[0]), false, () => {
      peeked++;
      return null;
    });
    expect(call).not.toBeNull();
    expect(peeked).toBe(0);

    // a big pile and a play that may or may not hide a fake: when it peeks, it looks at the last card, where this player hides fakes
    let peeks = 0;
    let atLast = 0;
    for (let seed = 1; seed <= 30; seed++) {
      const r = seeded(seed * 211);
      const t = table(3, { peeks: 1 }, r, liarHabits());
      t.g.turnId = t.person;
      const { rank: rk, cards } = biggest(t.g.hand(t.person));
      const other = t.g.hand(t.person).find((c) => c.rank !== rk)!;
      // a pile of 14 face-down cards already in the middle
      for (let i = 0; i < 14; i++) t.g.pile.push({ id: `P${i}`, rank: 'K', suit: 'C' });
      const play = [cards[0], other];
      t.feed(t.g.play(t.person, play.map((c) => c.id), rk));
      decideCall(t.sit(t.seats[0]), false, (i) => {
        peeks++;
        if (i === play.length - 1) atLast++;
        return t.g.lastPlay!.cards[i];
      });
    }
    expect(peeks).toBeGreaterThanOrEqual(10);
    expect(atLast / peeks).toBeGreaterThanOrEqual(0.8);
  });

  it('never sees the cards of the play itself: the same table gives the same decision, lie or truth', () => {
    for (let seed = 1; seed <= 25; seed++) {
      const { room, g, person, seats, feed } = table(2, {}, seeded(seed));
      g.turnId = person;
      const hand = g.hand(person);
      const { rank, cards } = biggest(hand);
      const fakes = hand.filter((c) => c.rank !== rank).slice(0, 2);
      feed(g.play(person, [cards[0], ...fakes].map((c) => c.id), rank));
      const view = room.view(seats[0].id);
      // nothing about the real cards reaches the bot's seat
      expect(view.watch).toBeNull();
      for (const c of g.lastPlay!.cards) expect(JSON.stringify(view)).not.toContain(`"${c.id}"`);
      const decide = () => {
        const mem = new BotMemory(seats[0].id, new Map(), new Map());
        mem.observe([{ kind: 'play', playerId: person, count: 3, rank }], room.view(seats[0].id), 0);
        return decideCall({ view: room.view(seats[0].id), mem, me: seats[0].me, rand: seeded(seed * 3), skill: skillOf('expert') }, false, noPeek);
      };
      const asLie = decide();
      // swap the hidden cards for real ones of the rank: everything the bot can see stays the same
      g.lastPlay!.cards = g.lastPlay!.cards.map((c, i) => ({ id: `R${i}`, rank, suit: c.suit }));
      expect(decide()).toEqual(asLie);
    }
  });
});

describe('bots at the table', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('give people time to call a play before a bot moves', () => {
    vi.useFakeTimers();
    const room = new Room('TEST');
    const asha = room.addMember('Asha');
    const ravi = room.addMember('Ravi');
    asha.socketId = 'socket-a';
    ravi.socketId = 'socket-b';
    const moves: GameEvent[][] = [];
    const driver = new BotDriver({ onMove: (_room, events) => moves.push(events), onPeek: () => {}, onChat: () => {} }, () => true, 1, seeded(4));
    const { bot } = driver.add(room, asha.id);
    room.start(asha.id);
    const g = room.game!;
    // Ravi plays and the bot is next; Asha still has the chance to call Ravi
    const order = g.order;
    const before = order[(order.indexOf(bot.id) + order.length - 1) % order.length];
    g.turnId = before;
    const card = g.hand(before)[0];
    const events = g.play(before, [card.id], card.rank);
    driver.observe(room, events);
    driver.wake(room);
    vi.advanceTimersByTime(1950);
    expect(moves).toHaveLength(0);
    vi.advanceTimersByTime(8000);
    expect(moves.length).toBeGreaterThan(0);
    driver.stop();
  });

  it('beat a player who dumps 5 to 7 cards every turn', () => {
    let wins = 0;
    let games = 0;
    for (let seed = 1; seed <= 12; seed++) {
      const rand = seeded(seed * 59);
      const { g, person, seats, sit, feed } = table(1, {}, rand);
      for (let moves = 0; !g.over && moves < 3000; moves++) {
        if (g.lastPlay && g.lastPlay.playerId === person) {
          const call = decideCall(sit(seats[0]), false, noPeek);
          if (call && g.turnId !== seats[0].id) {
            feed(g.callBluff(seats[0].id, g.lastPlay.id, call.cardIndex, 0));
            continue;
          }
        }
        if (g.turnId === person) {
          const hand = g.hand(person);
          const rank = g.roundRank ?? biggest(hand).rank;
          const real = hand.filter((c) => c.rank === rank);
          const fakes = hand.filter((c) => c.rank !== rank).slice(0, Math.max(1, 5 + Math.floor(rand() * 3) - real.length));
          feed(g.play(person, [...real, ...fakes].map((c) => c.id), g.roundRank ? undefined : rank));
        } else {
          const st = seats[0];
          const move = chooseTurn(sit(st), noPeek);
          if (move.kind === 'play') st.mem.pendingMine = move.cardIds.map((id) => g.hand(st.id).find((c) => c.id === id)!);
          feed(move.kind === 'call' ? g.callBluff(st.id, g.lastPlay!.id, move.cardIndex, 0) : move.kind === 'pass' ? g.pass(st.id) : g.play(st.id, move.cardIds, move.rank));
        }
      }
      games++;
      if (g.places[0] === person) wins++;
    }
    expect(wins / games).toBeLessThan(0.1);
  });

  it('play better the higher their level', () => {
    const wins = { expert: 0, normal: 0 };
    let games = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const rand = seeded(seed * 104729);
      const room = new Room('TEST');
      const host = room.addMember('Host');
      for (let i = 0; i < 3; i++) room.addBot(host.id, `B${i}`);
      room.setConfig(host.id, { ...CONFIG, peeks: 1 });
      room.start(host.id);
      room.game = new Game(room.game!.order, room.game!.config, (max) => Math.floor(rand() * max));
      const g = room.game;
      // every seat (the host's too) is played by the engine; levels alternate round the table
      const seats = room.players().map((m, i) => ({
        id: m.id,
        level: (i + seed) % 2 === 0 ? ('expert' as const) : ('normal' as const),
        me: makePersonality(BOT_STYLES[(i + seed) % BOT_STYLES.length], rand),
        mem: new BotMemory(m.id, new Map(), new Map()),
      }));
      const sit = (st: (typeof seats)[number]): Situation => ({ view: room.view(st.id), mem: st.mem, me: st.me, rand, skill: skillOf(st.level) });
      const peek = (st: (typeof seats)[number]): Peek => (i) => {
        try {
          return g.peek(st.id, g.lastPlay!.id, i);
        } catch {
          return null;
        }
      };
      const feed = (events: GameEvent[]) => seats.forEach((st) => st.mem.observe(events, room.view(st.id), st.me.tilt));
      for (let moves = 0; !g.over && moves < 4000; moves++) {
        if (g.lastPlay) {
          const caller = seats.find((st) => st.id !== g.turnId && g.hand(st.id).length > 0 && g.lastPlay && decideCall(sit(st), false, peek(st)));
          if (caller && g.lastPlay) {
            const call = decideCall(sit(caller), false, peek(caller));
            if (call) {
              feed(g.callBluff(caller.id, g.lastPlay.id, call.cardIndex, 0));
              continue;
            }
          }
        }
        const st = seats.find((x) => x.id === g.turnId)!;
        const move = chooseTurn(sit(st), peek(st));
        if (move.kind === 'play') st.mem.pendingMine = move.cardIds.map((id) => g.hand(st.id).find((c) => c.id === id)!);
        feed(move.kind === 'call' ? g.callBluff(st.id, g.lastPlay!.id, move.cardIndex, 0) : move.kind === 'pass' ? g.pass(st.id) : g.play(st.id, move.cardIds, move.rank));
      }
      if (!g.over) continue;
      games++;
      const winner = seats.find((st) => st.id === g.places[0]);
      if (winner) wins[winner.level]++;
    }
    // two seats each: an even game would be 50%
    expect(wins.expert / games).toBeGreaterThan(0.6);
  });
});
