import { describe, expect, it } from 'vitest';
import { chooseTurn, decideCall, fakeSpots, pushRate, suspicion, type Situation } from '../src/bots/brain.js';
import { BotMemory } from '../src/bots/memory.js';
import type { BotStyle, Personality, Rand, Read } from '../src/bots/models.js';
import { BOT_NAMES, BOT_STYLES, makePersonality, pickName, pickStyle } from '../src/bots/personality.js';
import type { PlayerStats } from '../src/models.js';
import { Room } from '../src/rooms.js';
import type { Card, GameConfig, LifetimeStats, Rank } from '../src/types.js';

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

const CONFIG: GameConfig = { decks: 1, bluffRule: 'one', stake: 0, peeks: 0, bets: false, teams: false };

/** a room with one person and bots, every seat played by the engine through the real rules */
function table(styles: BotStyle[], config: Partial<GameConfig>, rand: Rand) {
  const room = new Room('TEST');
  const host = room.addMember('Asha');
  styles.slice(1).forEach((_, i) => room.addBot(host.id, `Bot${i}`));
  room.setConfig(host.id, { ...CONFIG, ...config });
  room.start(host.id);
  const g = room.game!;
  const seats = room.players().map((m, i) => ({ id: m.id, me: makePersonality(styles[i], rand), mem: new BotMemory(m.id, new Map(), new Map()) }));
  type Seat = (typeof seats)[number];
  const sit = (s: Seat): Situation => ({ view: room.view(s.id), mem: s.mem, me: s.me, rand });
  const peek = (s: Seat) => (i: number) => {
    try {
      return g.peek(s.id, g.lastPlay!.id, i);
    } catch {
      return null;
    }
  };
  const feed = (events: ReturnType<typeof g.pass>) => seats.forEach((s) => s.mem.observe(events, room.view(s.id), s.me.tilt));
  return { room, g, seats, sit, peek, feed };
}

/** plays one whole game; any move the rules refuse throws and fails the test */
function playGame(styles: BotStyle[], config: Partial<GameConfig>, seed: number) {
  const rand = seeded(seed);
  const { g, seats, sit, peek, feed } = table(styles, config, rand);
  let moves = 0;
  while (!g.over && moves < 4000) {
    moves++;
    // anyone may call the last play before the next move
    if (g.lastPlay) {
      for (const s of [...seats].sort(() => rand() - 0.5)) {
        if (s.id === g.turnId || g.hand(s.id).length === 0 || !g.lastPlay) continue;
        const call = decideCall(sit(s), false, peek(s));
        if (call) {
          feed(g.callBluff(s.id, g.lastPlay.id, call.cardIndex, 0));
          break;
        }
      }
    }
    if (g.over) break;
    const s = seats.find((x) => x.id === g.turnId)!;
    const move = chooseTurn(sit(s), peek(s));
    if (move.kind === 'play') s.mem.pendingMine = move.cardIds.map((id) => g.hand(s.id).find((c) => c.id === id)!);
    feed(
      move.kind === 'call'
        ? g.callBluff(s.id, g.lastPlay!.id, move.cardIndex, 0)
        : move.kind === 'pass'
          ? g.pass(s.id)
          : g.play(s.id, move.cardIds, move.rank),
    );
  }
  return { over: g.over, moves, stats: seats.map((s) => ({ style: s.me.style, ...g.stats.get(s.id)! })) };
}

describe('bot engine', () => {
  it('plays whole games by the rules with every setting', () => {
    const configs: Partial<GameConfig>[] = [
      { decks: 1, bluffRule: 'one' },
      { decks: 1, bluffRule: 'all' },
      { decks: 2, bluffRule: 'one', peeks: 2 },
      { decks: 2, bluffRule: 'all', peeks: 3 },
      { decks: 1, bluffRule: 'one', teams: true },
      { decks: 2, bluffRule: 'all', teams: true, peeks: 1 },
    ];
    let seed = 1;
    for (const config of configs) {
      for (let i = 0; i < 12; i++) {
        const styles = [...BOT_STYLES].sort(() => seeded(seed)() - 0.5).slice(0, config.teams ? 4 : 2 + (i % 4));
        const r = playGame(styles, config, seed++);
        expect(r.over).toBe(true);
        expect(r.moves).toBeLessThan(4000);
      }
    }
  });

  it('gives each style its own way of playing', () => {
    const total = new Map<BotStyle, PlayerStats>();
    for (let seed = 100; seed < 160; seed++) {
      for (const s of playGame(['shark', 'maniac', 'rock', 'detective'], { decks: 1, bluffRule: 'one' }, seed).stats) {
        const t = total.get(s.style) ?? { bluffs: 0, caught: 0, goodCalls: 0, wrongCalls: 0, pickedUp: 0, plays: 0, chances: 0 };
        for (const k of Object.keys(t) as (keyof PlayerStats)[]) t[k] += s[k];
        total.set(s.style, t);
      }
    }
    const lies = (st: BotStyle) => total.get(st)!.bluffs / total.get(st)!.plays;
    const calls = (st: BotStyle) => (total.get(st)!.goodCalls + total.get(st)!.wrongCalls) / total.get(st)!.chances;
    expect(lies('maniac')).toBeGreaterThan(lies('rock') + 0.15);
    expect(calls('maniac')).toBeGreaterThan(calls('rock') * 1.5);
    expect(calls('detective')).toBeGreaterThan(calls('rock'));
  });

  it('catches a claim its own cards prove false', () => {
    let calls = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const rand = seeded(seed);
      const { g, seats, sit, peek, feed } = table(['shark', 'rock'], { bluffRule: 'all' }, rand);
      const [person, bot] = seats;
      const k = (suit: Card['suit']): Card => ({ id: `K${suit}x`, rank: 'K', suit });
      const other = (rank: Rank, n: number): Card => ({ id: `${rank}x${n}`, rank, suit: 'S' });
      g.hands.set(person.id, [other('3', 1), other('4', 2), other('5', 3)]);
      g.hands.set(bot.id, [k('S'), k('H'), k('D'), other('9', 4)]);
      g.turnId = person.id;
      // only one King is left, so two can't be real
      feed(g.play(person.id, [other('3', 1).id, other('4', 2).id], 'K'));
      bot.me = { ...bot.me, memory: 1 } as Personality;
      if (decideCall(sit(bot), false, peek(bot))) calls++;
    }
    expect(calls).toBeGreaterThanOrEqual(18);
  });

  it('suspects a player with a lying record more than an honest one', () => {
    const life = (bluffs: number): LifetimeStats => ({
      gamesPlayed: 40, wins: 10, losses: 10, bluffs, bluffsCaught: 0, goodCalls: 0, wrongCalls: 0, cardsPickedUp: 0, plays: 400, chances: 800,
    });
    const average = (bluffs: number) => {
      let sum = 0;
      for (let seed = 1; seed <= 40; seed++) {
        const rand = seeded(seed);
        const { g, seats, sit, feed } = table(['detective', 'detective'], {}, rand);
        const [person, bot] = seats;
        bot.mem = new BotMemory(bot.id, new Map(), new Map([[person.id, life(bluffs)]]));
        if (g.turnId !== person.id) g.turnId = person.id;
        feed(g.play(person.id, [g.hand(person.id)[0].id], 'Q'));
        sum += suspicion(sit(bot)).p;
      }
      return sum / 40;
    };
    expect(average(240)).toBeGreaterThan(average(20) + 0.15);
  });

  it('gives bots at one table different styles and names', () => {
    const rand = seeded(7);
    const styles: BotStyle[] = [];
    for (let i = 0; i < 4; i++) styles.push(pickStyle(styles, rand));
    expect(new Set(styles).size).toBe(4);
    const names: string[] = ['raju'];
    for (let i = 0; i < 5; i++) names.push(pickName(names, rand)!);
    expect(new Set(names.map((n) => n.toLowerCase())).size).toBe(6);
    expect(names.slice(1)).not.toContain('Raju');
    expect(pickName([...BOT_NAMES], rand)).toBeNull();
    expect(BOT_NAMES).toEqual(expect.arrayContaining(['Isha', 'Vihu', 'Ningu']));
    expect(BOT_NAMES).not.toContain('Sweety');
  });
});

/** what a bot has seen of one player, with blanks filled in */
const readOf = (r: Partial<Read>): Read => ({
  caught: 0,
  honest: 0,
  goodCalls: 0,
  wrongCalls: 0,
  chances: 0,
  lack: 0,
  passes: 0,
  firstTried: 0,
  firstFound: 0,
  lastTried: 0,
  lastFound: 0,
  midTried: 0,
  midFound: 0,
  openCaught: 0,
  openHonest: 0,
  followCaught: 0,
  followHonest: 0,
  ...r,
});

/** one person against bots for a few games in a row (bots keep what they learned), the person slipping a fake into every play */
function pusherSession(bots: number, games: number, seed: number) {
  const rand = seeded(seed);
  const styles = [...BOT_STYLES].sort(() => rand() - 0.5).slice(0, bots);
  const mes = styles.map((st) => makePersonality(st, rand));
  // what each bot learned about the person, kept from game to game
  const learned: Read[] = styles.map(() => readOf({}));
  let wins = 0;
  for (let game = 0; game < games; game++) {
    const room = new Room('TEST');
    const host = room.addMember('Asha');
    styles.forEach((_, i) => room.addBot(host.id, `Bot${i}`));
    room.setConfig(host.id, { ...CONFIG });
    room.start(host.id);
    const g = room.game!;
    const [person, ...botIds] = room.players().map((m) => m.id);
    const seats = botIds.map((id, i) => ({ id, me: mes[i], mem: new BotMemory(id, new Map([[person, learned[i]]]), new Map()) }));
    const sit = (st: (typeof seats)[number]): Situation => ({ view: room.view(st.id), mem: st.mem, me: st.me, rand });
    const feed = (events: ReturnType<typeof g.pass>) => seats.forEach((st) => st.mem.observe(events, room.view(st.id), st.me.tilt));
    const noPeek = () => null;
    for (let moves = 0; !g.over && moves < 3000; moves++) {
      if (g.lastPlay) {
        const caller = seats.find((st) => st.id !== g.turnId && g.hand(st.id).length > 0 && g.lastPlay && decideCall(sit(st), false, noPeek));
        if (caller) {
          feed(g.callBluff(caller.id, g.lastPlay!.id, decideCall(sit(caller), false, noPeek)?.cardIndex ?? 0, 0));
          continue;
        }
      }
      if (g.turnId === person) {
        const hand = g.hand(person);
        const rank = g.roundRank ?? hand[0].rank;
        const real = hand.filter((c) => c.rank === rank);
        const fake = hand.filter((c) => c.rank !== rank).slice(0, 1);
        feed(g.play(person, [...real, ...fake].map((c) => c.id), g.roundRank ? undefined : rank));
      } else {
        const st = seats.find((x) => x.id === g.turnId)!;
        const move = chooseTurn(sit(st), noPeek);
        if (move.kind === 'play') st.mem.pendingMine = move.cardIds.map((id) => g.hand(st.id).find((c) => c.id === id)!);
        feed(move.kind === 'call' ? g.callBluff(st.id, g.lastPlay!.id, move.cardIndex, 0) : move.kind === 'pass' ? g.pass(st.id) : g.play(st.id, move.cardIds, move.rank));
      }
    }
    if (g.places[0] === person) wins++;
  }
  return wins / games;
}

describe('bots against a player who lies all the time', () => {
  it('reads a player who never passes as pushing fakes, and one who passes as honest', () => {
    const s = (r: Read) => ({ mem: { reads: new Map([['p', r]]) } }) as unknown as Situation;
    // eight turns where they likely had none of the rank half the time
    expect(pushRate(s(readOf({ lack: 4, passes: 0 })), 'p')).toBeGreaterThan(0.6);
    expect(pushRate(s(readOf({ lack: 4, passes: 4 })), 'p')).toBeLessThan(0.15);
  });

  it('learns where a person hides fakes; bots shuffle, so their cards stay even', () => {
    const s = (bot: boolean, r: Read) =>
      ({ view: { players: [{ id: 'p', bot }] }, mem: { reads: new Map([['p', r]]) } }) as unknown as Situation;
    // the first guess leans to the last card, the one people tend to tap last
    const fresh = fakeSpots(s(false, readOf({})), 'p', 3);
    expect(fresh[2]).toBeGreaterThan(fresh[0]);
    // after a few calls that found their fakes first, it looks there
    const first = fakeSpots(s(false, readOf({ firstTried: 3, firstFound: 3, lastTried: 3, lastFound: 0 })), 'p', 3);
    expect(first[0]).toBeGreaterThan(first[1]);
    expect(first[0]).toBeGreaterThan(first[2]);
    expect(fakeSpots(s(true, readOf({ lastTried: 5, lastFound: 5 })), 'p', 3)).toEqual([1 / 3, 1 / 3, 1 / 3]);
  });

  it('beats a player who slips a fake into every play', () => {
    let rate = 0;
    for (let seed = 1; seed <= 8; seed++) rate += pusherSession(1, 5, seed * 31) / 8;
    // one bot against one person: an even game is 50%
    expect(rate).toBeLessThan(0.2);
  });
});
