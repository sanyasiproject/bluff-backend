import { describe, expect, it } from 'vitest';
import { chooseTurn, decideCall, suspicion, type Peek, type Situation } from '../src/bots/brain.js';
import { skillOf } from '../src/bots/levels.js';
import { BotMemory } from '../src/bots/memory.js';
import type { BotStyle, PileEntry, Rand } from '../src/bots/models.js';
import { BOT_STYLES, makePersonality } from '../src/bots/personality.js';
import { Game } from '../src/game.js';
import type { GameEvent } from '../src/models.js';
import { Room } from '../src/rooms.js';
import { backsClaim, claimsAllowed, type BotLevel, type Card, type GameConfig, type Rank, type Suit } from '../src/types.js';
import { parseConfig } from '../src/validate.js';

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

const noPeek: Peek = () => null;
let seq = 0;
const card = (rank: Rank, suit: Suit = 'S'): Card => ({ id: `${rank}${suit}t${++seq}`, rank, suit });
/** the last choice every time: the Kismat card is K (the last rank) */
const last = (max: number) => max - 1;

/** a room of one person and bots on these settings; the deal comes from `deal` (and so does the Kismat rank) */
function table(players: number, config: Partial<GameConfig>, deal: (max: number) => number) {
  const room = new Room('TEST');
  const host = room.addMember('Asha');
  for (let i = 1; i < players; i++) room.addBot(host.id, `Bot${i}`);
  room.setConfig(host.id, { ...parseConfig({ decks: 1, bluffRule: 'one' }), ...config });
  host.hasTwists = true;
  room.start(host.id);
  const ids = room.players().map((m) => m.id);
  room.game = new Game(room.game!.order, room.game!.config, deal, ids.slice(1));
  return { room, g: room.game, ids };
}

/** plays one whole game, every seat by the engine; a move the rules refuse throws and fails the test */
function playGame(styles: BotStyle[], config: Partial<GameConfig>, seed: number) {
  const rand = seeded(seed);
  const { room, g } = table(styles.length, config, (max) => Math.floor(rand() * max));
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
  const feed = (events: GameEvent[]) => seats.forEach((s) => s.mem.observe(events, room.view(s.id), s.me.tilt));
  let moves = 0;
  let follows = 0;
  let switched = 0;
  let wildLies = 0;
  while (!g.over && moves < 4000) {
    moves++;
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
    if (move.kind === 'play') {
      const cards = move.cardIds.map((id) => g.hand(s.id).find((c) => c.id === id)!);
      s.mem.pendingMine = cards;
      // a Kismat card never goes down among fakes, except to go out
      const claimed = move.rank ?? g.roundRank!;
      if (cards.length < g.hand(s.id).length && cards.some((c) => c.rank === g.kismat) && cards.some((c) => !backsClaim(c, claimed, g.kismat))) wildLies++;
      if (g.roundRank) {
        // every follow claims a rank the round allows
        const claim = move.rank ?? g.roundRank;
        expect(claimsAllowed(g.roundRank, g.config.seedhi)).toContain(claim);
        follows++;
        if (claim !== g.roundRank) switched++;
      }
    }
    feed(move.kind === 'call' ? g.callBluff(s.id, g.lastPlay!.id, move.cardIndex, 0) : move.kind === 'pass' ? g.pass(s.id) : g.play(s.id, move.cardIds, move.rank));
  }
  return { over: g.over, moves, follows, switched, wildLies };
}

describe('bots with the twists', () => {
  it('play whole games by the rules with Kismat, Seedhi or both', () => {
    const configs: Partial<GameConfig>[] = [
      { kismat: true, decks: 1, bluffRule: 'one' },
      { seedhi: true, decks: 2, bluffRule: 'all', peeks: 2 },
      { kismat: true, seedhi: true, decks: 1, bluffRule: 'one', peeks: 1 },
      { kismat: true, seedhi: true, decks: 2, bluffRule: 'all', teams: true },
    ];
    const levels: BotLevel[] = ['normal', 'hard', 'expert'];
    let seed = 500;
    let follows = 0;
    let switched = 0;
    for (const config of configs) {
      for (let i = 0; i < 9; i++) {
        const styles = [...BOT_STYLES].sort(() => seeded(seed)() - 0.5).slice(0, config.teams ? 4 : 2 + (i % 4));
        const r = playGame(styles, { ...config, botLevel: levels[i % 3] }, seed++);
        expect(r.over).toBe(true);
        expect(r.moves).toBeLessThan(4000);
        expect(r.wildLies).toBe(0);
        if (config.seedhi) {
          follows += r.follows;
          switched += r.switched;
        }
      }
    }
    // with Seedhi they really use the neighbouring ranks
    expect(switched / follows).toBeGreaterThan(0.3);
  });
});

/** one person and one bot on these settings, every hand set by the test; the Kismat card (when on) is K */
function headsUp(config: Partial<GameConfig>, rand: Rand, person: Card[], bot: Card[], level: BotLevel = 'expert') {
  const { room, g, ids } = table(2, { ...config, botLevel: level }, last);
  const [p, b] = ids;
  g.hands.set(p, person);
  g.hands.set(b, bot);
  g.turnId = p;
  const mem = new BotMemory(b, new Map(), new Map());
  const me = makePersonality('shark', rand);
  const sit = (): Situation => ({ view: room.view(b), mem, me, rand, skill: skillOf(level) });
  const feed = (events: GameEvent[]) => mem.observe(events, room.view(b), me.tilt);
  return { room, g, p, b, mem, sit, feed };
}

describe('Seedhi claims', () => {
  it('follow with a rank the round allows, mostly the one the bot can back up', () => {
    let plays = 0;
    let eights = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const rand = seeded(seed);
      const seven = card('7');
      const t = headsUp({ seedhi: true }, rand, [seven, card('7', 'H'), card('2'), card('4'), card('5'), card('9')], [card('8'), card('8', 'H'), card('3'), card('J'), card('Q'), card('K')]);
      t.feed(t.g.play(t.p, [seven.id], '7'));
      const move = chooseTurn(t.sit(), noPeek);
      if (move.kind !== 'play') continue;
      plays++;
      // the rank always goes with the play, and it's one Seedhi allows
      expect(['6', '7', '8']).toContain(move.rank);
      const cards = move.cardIds.map((id) => t.g.hand(t.b).find((c) => c.id === id)!);
      // its two Eights go down as Eights (maybe with fakes, like any claim)
      if (move.rank === '8' && cards.filter((c) => c.rank === '8').length === 2) eights++;
      expect(() => t.g.play(t.b, move.cardIds, move.rank)).not.toThrow();
    }
    expect(plays).toBeGreaterThan(20);
    expect(eights / plays).toBeGreaterThan(0.7);
  });

  it("count only the round's claims of the same rank against the copies", () => {
    const mem = new BotMemory('me', new Map(), new Map());
    const entry = (rank: Rank, count: number, sure: number | null = null): PileEntry => ({
      id: `${rank}${count}`, playerId: 'p', count, rank, mine: null, opening: false, left: 5, knownBefore: 0,
      realEst: null, seen: [], seenAt: [], read: null, fakes: null, sure, trapped: false,
    });
    const after = entry('8', 2, 1);
    // three Sevens then two Eights: fine with Seedhi
    mem.pile = [entry('7', 3), after];
    expect(mem.clash(after, 1, null)).toBe(false);
    // three Eights then two more: one of them is a lie
    mem.pile = [entry('8', 3), after];
    expect(mem.clash(after, 1, null)).toBe(true);
    // unless the Kismat cards make up the rest
    expect(mem.clash(after, 1, 'K')).toBe(false);
  });
});

describe('the Kismat card', () => {
  it("backs up the bot's own claims: one rank and Kismat cards go out honestly", () => {
    const t = headsUp({ kismat: true }, seeded(1), [card('2'), card('3')], [card('K'), card('5'), card('K', 'H'), card('5', 'H')]);
    expect(t.g.kismat).toBe('K');
    t.g.turnId = t.b;
    const move = chooseTurn(t.sit(), noPeek);
    expect(move).toMatchObject({ kind: 'play', rank: '5' });
    expect(move.kind === 'play' && move.cardIds.length).toBe(4);
  });

  it('goes out with a Kismat card when following, and keeps it for later otherwise', () => {
    let out = 0;
    let spent = 0;
    let plays = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const seven = card('7');
      const a = headsUp({ kismat: true }, seeded(seed), [seven, card('2'), card('4'), card('9')], [card('K'), card('7', 'H'), card('7', 'D')]);
      a.feed(a.g.play(a.p, [seven.id], '7'));
      const end = chooseTurn(a.sit(), noPeek);
      if (end.kind === 'play' && end.cardIds.length === 3) out++;
      // a long way from the end, the Kismat card is mostly kept back
      const eight = card('8');
      const b = headsUp({ kismat: true }, seeded(seed), [eight, card('2'), card('4'), card('9'), card('10')], [card('K'), card('8', 'H'), card('8', 'D'), card('3'), card('5'), card('9', 'H'), card('J')]);
      b.feed(b.g.play(b.p, [eight.id], '8'));
      const move = chooseTurn(b.sit(), noPeek);
      if (move.kind !== 'play') continue;
      plays++;
      if (move.cardIds.some((id) => id.startsWith('K'))) spent++;
    }
    expect(out).toBeGreaterThanOrEqual(34);
    expect(plays).toBeGreaterThan(20);
    expect(spent / plays).toBeLessThan(0.5);
  });

  it('counts as a real card when reading a claim', () => {
    const minFake = (kismat: boolean, person: Card[], bot: Card[], n: number) => {
      const t = headsUp({ kismat }, seeded(3), person, bot);
      t.feed(t.g.play(t.p, person.slice(0, n).map((c) => c.id), '7'));
      return suspicion(t.sit()).minFake;
    };
    // I hold three Sevens, so two more can be real only with Kismat cards out there
    const two = () => minFake(false, [card('4'), card('5'), card('6')], [card('7'), card('7', 'H'), card('7', 'D'), card('2')], 2);
    expect(two()).toBe(1);
    expect(minFake(true, [card('4'), card('5'), card('6')], [card('7'), card('7', 'H'), card('7', 'D'), card('2')], 2)).toBe(0);
    // my own Kismat cards are copies nobody else can have
    const five = (bot: Card[]) => minFake(true, ['2', '3', '4', '5', '6', '9'].map((r) => card(r as Rank)), bot, 5);
    expect(five([card('7'), card('7', 'H'), card('K'), card('K', 'H'), card('3', 'D')])).toBe(1);
    expect(five([card('7'), card('7', 'H'), card('Q'), card('Q', 'H'), card('3', 'D')])).toBe(0);
  });

  it('counts as a real card when the bot peeks at it', () => {
    let peeked = 0;
    let called = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const [k, k2] = [card('K'), card('K', 'H')];
      // Normal bots peek on a whim when unsure (two Sevens claimed while it holds three)
      const t = headsUp({ kismat: true, peeks: 3, bluffRule: 'all' }, seeded(seed), [k, k2, card('2'), card('4'), card('9')], [card('7'), card('7', 'H'), card('7', 'D'), card('J'), card('Q')], 'normal');
      // a big pile, so a look is worth it
      t.g.pile.push(...['2', '3', '4', '5', '6', '8', '9', '10'].map((r) => card(r as Rank, 'C')));
      t.feed(t.g.play(t.p, [k.id, k2.id], '7'));
      let looked = false;
      const call = decideCall(t.sit(), false, (i) => {
        looked = true;
        return t.g.peek(t.b, t.g.lastPlay!.id, i);
      });
      if (!looked) continue;
      peeked++;
      // a fake seen would be a sure call; a real one leaves only a little doubt
      if (call) called++;
    }
    expect(peeked).toBeGreaterThan(5);
    expect(called / peeked).toBeLessThan(0.3);
  });

  it('it already peeked at is real when it weighs the call again on its turn', () => {
    const calls = (kismat: boolean) => {
      let n = 0;
      for (let seed = 1; seed <= 20; seed++) {
        const k = card('K');
        const t = headsUp({ kismat, peeks: 3 }, seeded(seed), [k, card('2'), card('4'), card('9')], [card('7'), card('3'), card('5'), card('J'), card('Q')]);
        t.feed(t.g.play(t.p, [k.id], '7'));
        const entry = t.mem.entryOf(t.g.lastPlay!.id)!;
        entry.seen.push(k);
        entry.seenAt.push(0);
        t.g.turnId = t.b;
        if (chooseTurn(t.sit(), noPeek).kind === 'call') n++;
      }
      return n;
    };
    expect(calls(true)).toBe(0);
    // a King that isn't wild is a sure call
    expect(calls(false)).toBeGreaterThanOrEqual(18);
  });
});
