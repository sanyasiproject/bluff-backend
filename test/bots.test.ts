import { describe, expect, it } from 'vitest';
import { chooseTurn, decideCall, suspicion, type Situation } from '../src/bots/brain.js';
import { BotMemory } from '../src/bots/memory.js';
import type { BotStyle, Personality, Rand } from '../src/bots/models.js';
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
  });
});
