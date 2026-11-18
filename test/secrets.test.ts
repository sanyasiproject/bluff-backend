import { describe, expect, it } from 'vitest';
import type { RandomInt } from '../src/cards.js';
import { Crazy7Game } from '../src/crazy7/game.js';
import { Game } from '../src/game.js';
import type { PlayerStats } from '../src/models.js';
import { Room } from '../src/rooms.js';
import { dealSecrets, secretView } from '../src/secrets.js';
import { SECRET_MISSIONS, type Card, type GameConfig, type Rank, type Suit } from '../src/types.js';
import { parseConfig } from '../src/validate.js';

let seq = 0;
const card = (rank: Rank, suit: Suit = 'S'): Card => ({ id: `${rank}${suit}${++seq}`, rank, suit });
const ids = (...cards: Card[]) => cards.map((c) => c.id);
const BLUFF: GameConfig = parseConfig({ decks: 1, bluffRule: 'one' });
const CRAZY7: GameConfig = parseConfig({ decks: 1, bluffRule: 'one', game: 'crazy7' });
const BLUFF_CARDS = SECRET_MISSIONS.filter((m) => m.game === 'bluff').map((m) => m.id);
const CRAZY7_CARDS = SECRET_MISSIONS.filter((m) => m.game === 'crazy7').map((m) => m.id);

/** repeatable random numbers for the deal */
const seeded = (seed: number): RandomInt => {
  let s = seed;
  return (max) => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return Math.floor((s / 2147483648) * max);
  };
};

/** a Bluff game with these hands, in this seat order, the first to move */
function bluff(hands: Record<string, Card[]>, config: GameConfig = BLUFF) {
  const g = new Game(Object.keys(hands), config);
  for (const [id, h] of Object.entries(hands)) g.hands.set(id, h);
  g.turnId = Object.keys(hands)[0];
  return g;
}

/** a Crazy 7 game in a chosen position; the deck is picked from its end */
function crazy7(hands: Record<string, Card[]>, pile: Card[], turn: string, deck: Card[] = [], config: Partial<GameConfig> = {}) {
  return Crazy7Game.fromState({
    order: Object.keys(hands),
    config: { ...CRAZY7, ...config },
    hands: new Map(Object.entries(hands).map(([id, cards]) => [id, [...cards]])),
    deck,
    pile,
    turnId: turn,
    penalty: 0,
    picks: 0,
    picked: [],
    called: new Set(),
    missed: new Set(),
    atRisk: null,
    over: false,
    places: [],
  });
}

/** a player's card progress in a Bluff game */
const inBluff = (g: Game, id: string, cardId: string) => secretView(cardId, g.stats.get(id), g.playLogOf(id));
/** a player's card progress in a Crazy 7 game */
const inCrazy7 = (g: Crazy7Game, id: string, cardId: string) => secretView(cardId, g.stats.get(id));
const zero: PlayerStats = { bluffs: 0, caught: 0, goodCalls: 0, wrongCalls: 0, pickedUp: 0, plays: 0, chances: 0 };

describe('secret cards: the deal', () => {
  it('gives each person one card of the game being played, all different while there are enough', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const five = dealSecrets(['a', 'b', 'c', 'd', 'e'], 'bluff', seeded(seed));
      expect([...five.keys()]).toEqual(['a', 'b', 'c', 'd', 'e']);
      expect([...five.values()].sort()).toEqual([...BLUFF_CARDS].sort());

      const three = dealSecrets(['a', 'b', 'c'], 'crazy7', seeded(seed));
      expect([...three.values()].sort()).toEqual([...CRAZY7_CARDS].sort());
      // more people than Crazy 7 cards: every card goes out before any repeats, and none goes out three times
      const crowd = [...dealSecrets(['a', 'b', 'c', 'd', 'e'], 'crazy7', seeded(seed)).values()];
      expect(new Set(crowd.slice(0, 3)).size).toBe(3);
      for (const id of CRAZY7_CARDS) expect(crowd.filter((x) => x === id).length).toBeGreaterThanOrEqual(1);
      for (const id of CRAZY7_CARDS) expect(crowd.filter((x) => x === id).length).toBeLessThanOrEqual(2);
    }
    expect(dealSecrets([], 'bluff').size).toBe(0);
  });

  it('deals at random: every card turns up, and the same numbers give the same deal', () => {
    const seen = new Set<string>();
    for (let seed = 1; seed <= 60; seed++) seen.add(dealSecrets(['a'], 'bluff', seeded(seed)).get('a')!);
    expect([...seen].sort()).toEqual([...BLUFF_CARDS].sort());
    expect(dealSecrets(['a', 'b', 'c'], 'bluff', seeded(7))).toEqual(dealSecrets(['a', 'b', 'c'], 'bluff', seeded(7)));
  });

  it('knows how to count every card in the catalogue, and nothing else', () => {
    for (const m of SECRET_MISSIONS) expect(secretView(m.id, zero)).toEqual({ id: m.id, progress: 0, done: false });
    expect(secretView('nope', zero)).toBe(null);
    expect(secretView('toString', zero)).toBe(null);
    // no stats yet: nothing done
    expect(secretView('catch2', undefined)).toEqual({ id: 'catch2', progress: 0, done: false });
  });
});

describe('secret cards: Bluff progress, from the player own game only', () => {
  it('catch2: liars they caught, up to 2', () => {
    const [b1, b2, b3] = [card('2'), card('3'), card('4')];
    const [a1, a2] = [card('9'), card('10')];
    const g = bluff({ b: [b1, b2, b3, card('5')], a: [a1, a2, card('J'), card('Q')] });
    // b lies and a catches it; the caller starts the next round
    g.play('b', ids(b1), 'K');
    g.callBluff('a', g.lastPlay!.id, 0);
    expect(inBluff(g, 'a', 'catch2')).toEqual({ id: 'catch2', progress: 1, done: false });
    g.play('a', ids(a1), '9');
    g.play('b', ids(b2));
    g.callBluff('a', g.lastPlay!.id, 0);
    expect(inBluff(g, 'a', 'catch2')).toEqual({ id: 'catch2', progress: 2, done: true });
    g.play('a', ids(a2), '10');
    g.play('b', ids(b3));
    g.callBluff('a', g.lastPlay!.id, 0);
    expect(g.stats.get('a')!.goodCalls).toBe(3);
    expect(inBluff(g, 'a', 'catch2')).toEqual({ id: 'catch2', progress: 2, done: true });
    // the liar's own card doesn't move
    expect(inBluff(g, 'b', 'catch2')!.progress).toBe(0);
  });

  it('sneak2: lies nobody caught, up to 2; a caught lie takes nothing', () => {
    const [two, three, four, five] = [card('2'), card('3'), card('4'), card('5')];
    const [nine, ten] = [card('9'), card('10')];
    const g = bluff({ a: [two, three, four, five, card('K')], b: [nine, ten, card('J')] });
    g.play('a', ids(two), 'K');
    g.callBluff('b', g.lastPlay!.id, 0);
    expect(inBluff(g, 'a', 'sneak2')!.progress).toBe(0);
    // b starts; a follows with a fake and b lets it go
    g.play('b', ids(nine), '9');
    g.play('a', ids(three));
    g.pass('b');
    expect(inBluff(g, 'a', 'sneak2')).toEqual({ id: 'sneak2', progress: 1, done: false });
    g.play('a', ids(four), 'Q');
    g.pass('b');
    expect(inBluff(g, 'a', 'sneak2')).toEqual({ id: 'sneak2', progress: 2, done: true });
    g.play('a', ids(five), 'J');
    g.pass('b');
    expect(inBluff(g, 'a', 'sneak2')).toEqual({ id: 'sneak2', progress: 2, done: true });
  });
});

describe('secret cards: Bluff plays that count', () => {
  it('bigLie: a lie of 3 or more cards nobody caught, even after a call turned over a real card', () => {
    const [two, three, qs, qh, qd, four, five, six] = [card('2'), card('3'), card('Q'), card('Q', 'H'), card('Q', 'D'), card('4'), card('5'), card('6')];
    const [nineH, seven, eight, nineS] = [card('9', 'H'), card('7'), card('8'), card('9')];
    const g = bluff({ a: [two, three, qs, qh, qd, four, five, six, nineH, seven, eight, card('K')], b: [nineS, card('J'), card('10')] });
    // two cards only, then three real Queens
    g.play('a', ids(two, three), 'K');
    g.pass('b');
    g.play('a', ids(qs, qh, qd), 'Q');
    g.pass('b');
    expect(inBluff(g, 'a', 'bigLie')!.progress).toBe(0);
    // three fakes, caught
    g.play('a', ids(four, five, six), 'A');
    g.callBluff('b', g.lastPlay!.id, 1);
    expect(inBluff(g, 'a', 'bigLie')!.progress).toBe(0);
    // b starts; a hides two fakes behind a real Nine and b turns over the real one
    g.play('b', ids(nineS), '9');
    g.play('a', ids(nineH, seven, eight));
    g.callBluff('b', g.lastPlay!.id, 0);
    expect(g.reveal!.bluff).toBe(false);
    expect(inBluff(g, 'a', 'bigLie')).toEqual({ id: 'bigLie', progress: 1, done: true });
  });

  it('bait: an honest play that someone called', () => {
    const [king, two, nineH] = [card('K'), card('2'), card('9', 'H')];
    const nineS = card('9');
    const g = bluff({ a: [king, two, nineH, card('J')], b: [nineS, card('10'), card('Q')] });
    // the truth nobody called, then a lie that was called
    g.play('a', ids(king), 'K');
    g.pass('b');
    g.play('a', ids(two), 'Q');
    g.callBluff('b', g.lastPlay!.id, 0);
    expect(inBluff(g, 'a', 'bait')!.progress).toBe(0);
    g.play('b', ids(nineS), '9');
    g.play('a', ids(nineH));
    g.callBluff('b', g.lastPlay!.id, 0);
    expect(inBluff(g, 'a', 'bait')).toEqual({ id: 'bait', progress: 1, done: true });
    // b's call on the truth is no bait for b
    expect(inBluff(g, 'b', 'bait')!.progress).toBe(0);
  });

  it('bigDrop: 4 or more cards in one go, caught or not', () => {
    const three = [card('2'), card('3'), card('4')];
    const four = [card('5'), card('6'), card('7'), card('8')];
    const g = bluff({ a: [...three, ...four, card('K')], b: [card('9'), card('10'), card('J')] });
    g.play('a', ids(...three), 'K');
    g.pass('b');
    expect(inBluff(g, 'a', 'bigDrop')!.progress).toBe(0);
    g.play('a', ids(...four), 'A');
    g.callBluff('b', g.lastPlay!.id, 2);
    expect(g.reveal!.bluff).toBe(true);
    expect(inBluff(g, 'a', 'bigDrop')).toEqual({ id: 'bigDrop', progress: 1, done: true });
  });

  it('counts a lie only once it can no longer be called, so a card never ticks and then drops back', () => {
    const [two, three, four, nine] = [card('2'), card('3'), card('4'), card('9')];
    const g = bluff({ a: [two, three, four, card('K'), card('K', 'H')], b: [nine, card('J')] });
    g.play('a', ids(two, three, four), 'Q');
    // still open: b could call it
    expect(inBluff(g, 'a', 'bigLie')).toEqual({ id: 'bigLie', progress: 0, done: false });
    expect(inBluff(g, 'a', 'sneak2')!.progress).toBe(0);
    g.pass('b');
    // it stood: now it got past everyone
    expect(inBluff(g, 'a', 'bigLie')).toEqual({ id: 'bigLie', progress: 1, done: true });
    expect(inBluff(g, 'a', 'sneak2')!.progress).toBe(1);
  });

  it("reads one player's own plays with the true cards while the game runs, as a copy", () => {
    const [two, nine] = [card('2'), card('9')];
    const g = bluff({ a: [two, card('K')], b: [nine, card('J')] });
    g.play('a', ids(two), 'Q');
    // the last play can still be called, so it's open
    expect(g.playLogOf('a')).toEqual([{ rank: 'Q', cards: [two], called: false, caught: false, open: true }]);
    expect(g.playLogOf('b')).toEqual([]);
    // a copy: changing it changes nothing in the game
    g.playLogOf('a')[0].cards.push(nine);
    expect(g.playLogOf('a')[0].cards).toEqual([two]);
    expect(g.playsOf('a')).toBe(null);
  });
});

describe('secret cards: Crazy 7 counters', () => {
  it('counts every 7 played, and the 7s that answered a 7 that was waiting', () => {
    const [a7h, a7s, b7c] = [card('7', 'H'), card('7', 'S'), card('7', 'C')];
    const deck = [card('A', 'D'), card('Q', 'D'), card('J', 'D'), card('10', 'D'), card('2', 'D'), card('6', 'D')];
    const g = crazy7({ a: [a7h, a7s, card('3', 'C')], b: [b7c, card('5', 'C'), card('K', 'D')], c: [card('9', 'H'), card('4', 'C')] }, [card('5', 'H')], 'a', deck);
    expect(g.stats.get('a')).toMatchObject({ sevens: 0, stacks: 0, lastCalls: 0 });
    g.play('a', a7h.id);
    g.play('b', b7c.id);
    expect(g.penalty).toBe(4);
    g.pick('c');
    // nothing was waiting this time
    g.play('a', a7s.id);
    expect(g.stats.get('a')).toMatchObject({ sevens: 2, stacks: 0 });
    expect(g.stats.get('b')).toMatchObject({ sevens: 1, stacks: 1 });
    expect(inCrazy7(g, 'a', 'sevens2')).toEqual({ id: 'sevens2', progress: 2, done: true });
    expect(inCrazy7(g, 'a', 'stack7')).toEqual({ id: 'stack7', progress: 0, done: false });
    expect(inCrazy7(g, 'b', 'stack7')).toEqual({ id: 'stack7', progress: 1, done: true });
    expect(inCrazy7(g, 'b', 'sevens2')).toEqual({ id: 'sevens2', progress: 1, done: false });

    // stacking off: the next player just picks, so no 7 ever answers one
    const [o7h, o7c] = [card('7', 'H'), card('7', 'C')];
    const off = crazy7({ a: [o7h, card('K', 'S')], b: [o7c, card('3', 'C')], c: [card('9', 'H'), card('4', 'C')] }, [card('5', 'H')], 'a', [card('A', 'D'), card('Q', 'D'), card('J', 'D')], { stack7: false });
    off.play('a', o7h.id);
    expect(off.stats.get('b')!.stacks).toBe(0);
  });

  it('counts "last card" said in time, never a refused or missed one', () => {
    const [nine, jack] = [card('9', 'H'), card('J', 'H')];
    const g = crazy7({ a: [nine, jack], b: [card('5', 'H'), card('6', 'H'), card('8', 'H')] }, [card('2', 'H')], 'a');
    expect(() => g.call('b')).toThrow('Say it when you are down to your last card');
    g.call('a');
    expect(() => g.call('a')).toThrow('You already said it');
    expect(g.stats.get('a')!.lastCalls).toBe(1);
    expect(g.stats.get('b')!.lastCalls).toBe(0);
    expect(inCrazy7(g, 'a', 'lastCard')).toEqual({ id: 'lastCard', progress: 1, done: true });

    const late9 = card('9', 'H');
    const late = crazy7(
      { a: [late9, card('J', 'H')], b: [card('5', 'H'), card('6', 'H')], c: [card('4', 'H'), card('K', 'H')] },
      [card('2', 'H')],
      'a',
      [card('3', 'D')],
    );
    late.play('a', late9.id);
    late.play('b', late.hand('b')[0].id);
    expect(late.missed.has('a')).toBe(true);
    expect(() => late.call('a')).toThrow('Too late, you were caught');
    expect(inCrazy7(late, 'a', 'lastCard')!.progress).toBe(0);
  });
});

/** a room with these people (the first is host) and bots, dealt */
function room(config: GameConfig, names: string[], botNames: string[] = []) {
  const r = new Room('SCRT');
  const people = names.map((n) => r.addMember(n));
  const host = people[0];
  r.setConfig(host.id, config);
  const bots = botNames.map((n) => r.addBot(host.id, n).bot);
  r.start(host.id);
  return { r, people, bots, host };
}

describe('secret cards: lies that never had their chance', () => {
  it('a lie cut off by a walk-out never counts as getting past everyone', () => {
    const [two, three, four] = [card('2'), card('3'), card('4')];
    const g = bluff({ a: [two, three, four, card('K')], b: [card('9'), card('J')], c: [card('5'), card('6')] });
    g.play('a', ids(two, three, four), 'Q');
    // a walks out before anyone could call or pass
    g.leave('a');
    expect(inBluff(g, 'a', 'bigLie')).toEqual({ id: 'bigLie', progress: 0, done: false });
    expect(inBluff(g, 'a', 'sneak2')!.progress).toBe(0);
  });

  it("a lie cut off by the host's End game never counts either", () => {
    const [two, three, four] = [card('2'), card('3'), card('4')];
    const g = bluff({ a: [two, three, four, card('K')], b: [card('9')], c: [card('5'), card('6')] });
    // b goes out first, so End game is allowed
    g.turnId = 'b';
    g.play('b', ids(...g.hand('b')), '9');
    g.pass('c');
    g.pass('a');
    expect(g.places).toEqual(['b']);
    g.turnId = 'a';
    g.play('a', ids(two, three, four), 'Q');
    g.endEarly();
    expect(g.over).toBe(true);
    expect(inBluff(g, 'a', 'bigLie')!.done).toBe(false);
  });
});

describe('secret cards when lies are kept secret', () => {
  it("deals only cards that can't give a lie away", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 30; i++) {
      const { r } = room({ ...BLUFF, secretLies: true }, ['Asha', 'Ravi', 'Meena']);
      for (const c of r.secretCards.values()) seen.add(c);
    }
    expect([...seen].sort()).toEqual(['bigDrop', 'catch2']);
  });
});

describe('secret cards after the game', () => {
  it('keeps the name of a player the host removes after game over', () => {
    const { r, people, host } = room(BLUFF, ['Asha', 'Ravi']);
    const ravi = people[1];
    const g = r.game!;
    g.hands.set(host.id, [card('K')]);
    g.hands.set(ravi.id, [card('2'), card('3')]);
    g.turnId = host.id;
    g.play(host.id, ids(...g.hand(host.id)), 'K');
    g.pass(ravi.id);
    expect(r.phase).toBe('over');
    r.kick(host.id, ravi.id);
    expect(r.view(host.id).secrets.map((s) => s.name)).toEqual(['Asha', 'Ravi']);
    expect(r.view(host.id).lieRecap!.players.map((p) => p.name)).toEqual(['Asha', 'Ravi']);
  });
});

describe('secret cards and room settings', () => {
  it("never deals 'Answer a 7 with your own 7' when the room has Stack 7s off", () => {
    for (let seed = 1; seed <= 40; seed++) expect([...dealSecrets(['a', 'b', 'c'], 'crazy7', seeded(seed), ['stack7']).values()]).not.toContain('stack7');
    const seen = new Set<string>();
    for (let i = 0; i < 30; i++) {
      const { r } = room({ ...CRAZY7, stack7: false }, ['Asha', 'Ravi', 'Meena']);
      for (const card of r.secretCards.values()) seen.add(card);
    }
    expect(seen.has('stack7')).toBe(false);
    expect([...seen].sort()).toEqual(['lastCard', 'sevens2']);
  });
});

/** every string value in a view, as the app receives it */
const stringsIn = (value: unknown): string[] => {
  const walk = (v: unknown): string[] => (typeof v === 'string' ? [v] : v && typeof v === 'object' ? Object.values(v).flatMap(walk) : []);
  return walk(JSON.parse(JSON.stringify(value)));
};

describe('secret cards in a room', () => {
  it('deals a card to every person at the table when the game starts, never to a bot', () => {
    const { r, people, bots } = room(BLUFF, ['Asha', 'Ravi', 'Meena'], ['Bot1', 'Bot2']);
    expect([...r.secretCards.keys()].sort()).toEqual(people.map((p) => p.id).sort());
    const dealt = people.map((p) => r.view(p.id).secret!.id);
    expect(new Set(dealt).size).toBe(3);
    for (const id of dealt) expect(BLUFF_CARDS).toContain(id);
    for (const b of bots) expect(r.view(b.id).secret).toBe(null);

    // four people and three Crazy 7 cards: all three go out, one of them twice
    const c7 = room(CRAZY7, ['Asha', 'Ravi', 'Meena', 'Kiran'], ['Bot']);
    const c7dealt = c7.people.map((p) => c7.r.view(p.id).secret!.id);
    for (const id of c7dealt) expect(CRAZY7_CARDS).toContain(id);
    expect(new Set(c7dealt).size).toBe(3);
    expect(c7.r.view(c7.bots[0].id).secret).toBe(null);
  });

  it('shows each person only their own card while the game runs; watchers and bots see none', () => {
    const { r, people, bots } = room(BLUFF, ['Asha', 'Ravi', 'Meena'], ['Bot']);
    const watcher = r.addMember('Mira');
    expect(watcher.watching).toBe(true);
    const cardOf = new Map(people.map((p) => [p.id, r.secretCards.get(p.id)!]));
    for (const p of people) {
      const v = r.view(p.id);
      expect(v.secret).toEqual({ id: cardOf.get(p.id), progress: 0, done: false });
      expect(v.secrets).toEqual([]);
      const seen = stringsIn(v);
      for (const [id, cardId] of cardOf) if (id !== p.id) expect(seen).not.toContain(cardId);
    }
    // watchers see every hand, but no card
    for (const m of [watcher, ...bots]) {
      const v = r.view(m.id);
      expect(v.secret).toBe(null);
      expect(v.secrets).toEqual([]);
      for (const cardId of cardOf.values()) expect(stringsIn(v)).not.toContain(cardId);
    }
  });

  it("keeps a 2v2 partner's card hidden too, though partners see each other's hands", () => {
    const { r, people } = room({ ...BLUFF, teams: true }, ['Asha', 'Ravi', 'Meena', 'Kiran']);
    for (const p of people) {
      const v = r.view(p.id);
      expect(v.partnerHand).not.toBe(null);
      expect(stringsIn(v)).not.toContain(r.secretCards.get(r.game!.partnerOf(p.id)!));
    }
  });

  it('counts my card live, then turns every card over at game over, in seat order, for everyone in the room', () => {
    const { r, people, bots, host } = room(BLUFF, ['Asha', 'Ravi'], ['Bot']);
    const [asha, ravi] = people;
    const bot = bots[0];
    const watcher = r.addMember('Mira');
    r.secretCards.set(asha.id, 'bigDrop');
    r.secretCards.set(ravi.id, 'catch2');
    const g = r.game!;
    g.hands.set(asha.id, [card('K'), card('K', 'H'), card('K', 'D'), card('2')]);
    g.hands.set(ravi.id, [card('3'), card('4')]);
    g.hands.set(bot.id, [card('5'), card('6')]);
    g.turnId = asha.id;
    // Asha goes out with four cards, one of them fake, and nobody calls
    g.play(asha.id, ids(...g.hand(asha.id)), 'K');
    expect(r.view(asha.id).secret).toEqual({ id: 'bigDrop', progress: 1, done: true });
    expect(r.view(ravi.id).secret).toEqual({ id: 'catch2', progress: 0, done: false });
    expect(stringsIn(r.view(ravi.id))).not.toContain('bigDrop');
    g.pass(ravi.id);
    g.pass(bot.id);
    expect(g.places).toEqual([asha.id]);
    expect(r.view(asha.id).secrets).toEqual([]);
    r.endGame(host.id);
    expect(r.phase).toBe('over');

    const reveal = [
      { playerId: asha.id, name: 'Asha', id: 'bigDrop', done: true },
      { playerId: ravi.id, name: 'Ravi', id: 'catch2', done: false },
    ];
    for (const m of [asha, ravi, bot, watcher]) expect(r.view(m.id).secrets).toEqual(reveal);
    // my own card stays up at game over; watchers and bots still have none of their own
    expect(r.view(asha.id).secret).toEqual({ id: 'bigDrop', progress: 1, done: true });
    expect(r.view(watcher.id).secret).toBe(null);
    expect(r.view(bot.id).secret).toBe(null);
    // the saved game has each person's card and whether they did it; bots have none
    expect(r.snapshot('finished')!.players.map((p) => p.secret)).toEqual([{ id: 'bigDrop', done: true }, { id: 'catch2', done: false }, null]);
  });

  it("leaves a removed player's card out of the reveal, though the saved game keeps it", () => {
    const { r, people, host } = room(BLUFF, ['Asha', 'Ravi', 'Meena']);
    const [asha, ravi, meena] = people;
    r.secretCards.set(asha.id, 'catch2');
    r.secretCards.set(ravi.id, 'sneak2');
    r.secretCards.set(meena.id, 'bait');
    r.kick(host.id, meena.id);
    const g = r.game!;
    g.hands.set(asha.id, [card('K')]);
    g.hands.set(ravi.id, [card('2'), card('3')]);
    g.turnId = asha.id;
    g.play(asha.id, ids(...g.hand(asha.id)), 'K');
    g.pass(ravi.id);
    expect(r.phase).toBe('over');
    expect(r.view(ravi.id).secrets).toEqual([
      { playerId: asha.id, name: 'Asha', id: 'catch2', done: false },
      { playerId: ravi.id, name: 'Ravi', id: 'sneak2', done: false },
    ]);
    const saved = r.snapshot('finished')!.players.find((p) => p.memberId === meena.id)!;
    expect(saved).toMatchObject({ kicked: true, secret: { id: 'bait', done: false } });
  });

  it('saves whether a card is done as it stands when the game is stopped mid-way', () => {
    const { r, people } = room(BLUFF, ['Asha', 'Ravi']);
    const [asha, ravi] = people;
    r.secretCards.set(asha.id, 'bigDrop');
    r.secretCards.set(ravi.id, 'bait');
    const g = r.game!;
    const four = [card('2'), card('3'), card('4'), card('5')];
    g.hands.set(asha.id, [...four, card('9')]);
    g.turnId = asha.id;
    g.play(asha.id, ids(...four), 'A');
    expect(r.phase).toBe('playing');
    expect(r.snapshot('ended_early')!.players.map((p) => p.secret)).toEqual([{ id: 'bigDrop', done: true }, { id: 'bait', done: false }]);
  });

  it('clears the cards back in the lobby and deals new ones for the next game', () => {
    const { r, people, host } = room(BLUFF, ['Asha', 'Ravi']);
    r.game!.close();
    expect(r.view(host.id).secrets).toHaveLength(2);
    r.backToLobby(host.id);
    expect(r.secretCards.size).toBe(0);
    for (const p of people) {
      expect(r.view(p.id).secret).toBe(null);
      expect(r.view(p.id).secrets).toEqual([]);
    }
    expect(r.snapshot('finished')).toBe(null);
    // the next game is Crazy 7, so its own cards come out
    r.setConfig(host.id, CRAZY7);
    r.start(host.id);
    for (const p of people) expect(CRAZY7_CARDS).toContain(r.view(p.id).secret!.id);
  });

  it('counts a Crazy 7 card live and keeps it to its holder until the game is over', () => {
    const { r, people } = room(CRAZY7, ['Asha', 'Ravi', 'Meena']);
    const [asha, ravi, meena] = people;
    r.secretCards.set(asha.id, 'lastCard');
    r.secretCards.set(ravi.id, 'stack7');
    r.secretCards.set(meena.id, 'sevens2');
    const c7 = r.c7!;
    c7.hands.set(asha.id, [card('9', 'H'), card('J', 'H')]);
    c7.turnId = asha.id;
    c7.call(asha.id);
    expect(r.view(asha.id).secret).toEqual({ id: 'lastCard', progress: 1, done: true });
    expect(stringsIn(r.view(ravi.id))).not.toContain('lastCard');
    expect(stringsIn(r.view(ravi.id))).not.toContain('sevens2');
    expect(stringsIn(r.view(meena.id))).not.toContain('stack7');
    expect(r.view(meena.id).secrets).toEqual([]);
    c7.close();
    expect(r.view(meena.id).secrets).toEqual([
      { playerId: asha.id, name: 'Asha', id: 'lastCard', done: true },
      { playerId: ravi.id, name: 'Ravi', id: 'stack7', done: false },
      { playerId: meena.id, name: 'Meena', id: 'sevens2', done: false },
    ]);
  });
});
