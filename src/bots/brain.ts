import type { Card, LifetimeStats, Rank, RoomView } from '../types.js';
import { partnerIn, type BotMemory } from './memory.js';
import type { BotMove, Personality, Rand } from './models.js';
import { holdChance } from './odds.js';

/** share of plays that are bluffs, before knowing anything about a player */
const PRIOR_BLUFF = 0.22;
/** chance a player calls any one play, before knowing anything about them */
const PRIOR_CALL = 0.12;
/** floors for accounts from before plays and chances were counted */
const PLAYS_PER_GAME = 8;
const CHANCES_PER_GAME = 15;

/** Bluff games only: Crazy 7 games say nothing about how someone lies or calls */
const bluffGames = (life: LifetimeStats) => life.gamesPlayed - (life.crazy7Games ?? 0);

/** everything a decision looks at: the table exactly as this bot's seat sees it, plus its memory */
export interface Situation {
  view: RoomView;
  mem: BotMemory;
  me: Personality;
  rand: Rand;
}

/** shows one card of the last play to this bot only; null when the peek isn't allowed */
export type Peek = (index: number) => Card | null;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
/** bell-shaped noise around 0, spread about 1 */
const noise = (rand: Rand) => (rand() + rand() + rand() - 1.5) * 2;
const countIn = (cards: Card[], rank: Rank) => cards.filter((c) => c.rank === rank).length;
const copies = (v: RoomView) => 4 * v.config.decks;

function shuffled<T>(items: T[], rand: Rand): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** picks one option, better scores more often; tau says how loose the choice is */
function choose<T>(options: T[], score: (o: T) => number, tau: number, rand: Rand): T {
  const scores = options.map(score);
  const top = Math.max(...scores);
  const weights = scores.map((x) => Math.exp((x - top) / tau));
  let r = rand() * weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < options.length; i++) {
    r -= weights[i];
    if (r <= 0) return options[i];
  }
  return options[options.length - 1];
}

/** how often plays at this table turn out to be lies when called, so the bot adapts to how this table plays */
export function tableRate(s: Situation): number {
  let caught = 0;
  let honest = 0;
  for (const r of s.mem.reads.values()) {
    caught += r.caught;
    honest += r.honest;
  }
  return (PRIOR_BLUFF * 8 + caught) / (8 + caught + honest);
}

/** how likely a player is to lie on a play: lifetime record, then what this bot saw at the table */
export function bluffRate(s: Situation, id: string): number {
  const prior = tableRate(s);
  let a = prior * 6;
  let b = (1 - prior) * 6;
  const life = s.mem.lifetime.get(id);
  if (life && bluffGames(life) > 0) {
    const plays = Math.max(life.plays, life.bluffs, bluffGames(life) * PLAYS_PER_GAME);
    // a lifetime counts as at most 30 plays, so today's table still matters
    const w = Math.min(30, plays) / plays;
    a += life.bluffs * w;
    b += (plays - life.bluffs) * w;
  }
  const r = s.mem.reads.get(id);
  if (r) {
    a += r.caught * 1.5;
    b += r.honest * 1.5;
  }
  return a / (a + b);
}

/** how likely a player is to call bluff on any one play */
export function callRate(s: Situation, id: string): number {
  let a = PRIOR_CALL * 10;
  let b = (1 - PRIOR_CALL) * 10;
  const life = s.mem.lifetime.get(id);
  if (life && bluffGames(life) > 0) {
    const calls = life.goodCalls + life.wrongCalls;
    const chances = Math.max(life.chances, calls, bluffGames(life) * CHANCES_PER_GAME);
    const w = Math.min(40, chances) / chances;
    a += calls * w;
    b += (chances - calls) * w;
  }
  const r = s.mem.reads.get(id);
  if (r) {
    const calls = r.goodCalls + r.wrongCalls;
    a += calls;
    b += Math.max(0, r.chances - calls);
  }
  return a / (a + b);
}

/** how often their calls are right */
export function callSkill(s: Situation, id: string): number {
  let good = 2;
  let wrong = 2;
  const life = s.mem.lifetime.get(id);
  const total = life ? life.goodCalls + life.wrongCalls : 0;
  if (life && total > 0) {
    const w = Math.min(20, total) / total;
    good += life.goodCalls * w;
    wrong += life.wrongCalls * w;
  }
  const r = s.mem.reads.get(id);
  if (r) {
    good += r.goodCalls;
    wrong += r.wrongCalls;
  }
  return good / (good + wrong);
}

/** how often a player pushes fakes on a turn they had none of the rank, from how rarely they pass when they likely lack it */
export function pushRate(s: Situation, id: string): number {
  const r = s.mem.reads.get(id);
  const lack = r?.lack ?? 0;
  const passes = r?.passes ?? 0;
  return clamp((lack - passes + 0.6) / (lack + 2), 0.04, 0.97);
}

/** where this player's fakes sit: for each card of their play of n, the chance it's the one fake */
export function fakeSpots(s: Situation, id: string, n: number): number[] {
  if (n <= 1) return [1];
  // bots shuffle their cards; people's go down in tap order, and the fake is often tapped last (or first)
  if (s.view.players.find((p) => p.id === id)?.bot) return Array.from({ length: n }, () => 1 / n);
  const r = s.mem.reads.get(id);
  // light first guesses, so a player who puts fakes somewhere else is found out after a call or two
  const first = ((r?.firstFound ?? 0) + 0.35) / ((r?.firstTried ?? 0) + 1);
  const last = ((r?.lastFound ?? 0) + 0.6) / ((r?.lastTried ?? 0) + 1);
  const mid = ((r?.midFound ?? 0) + 0.3) / ((r?.midTried ?? 0) + 1);
  const w = Array.from({ length: n }, (_, i) => (i === 0 ? first : i === n - 1 ? last : mid));
  const sum = w.reduce((a, b) => a + b, 0);
  return w.map((x) => x / sum);
}

/** how often a player slips a fake in among real cards, from their called plays of 2+ cards (openings and follow-ups apart) */
export function padRate(s: Situation, id: string, opening: boolean): number {
  const r = s.mem.reads.get(id);
  const prior = bluffRate(s, id) * 0.6;
  const caught = (opening ? r?.openCaught : r?.followCaught) ?? 0;
  const held = (opening ? r?.openHonest : r?.followHonest) ?? 0;
  return clamp((caught + prior * 3) / (caught + held + 3), 0.03, 0.95);
}

/** how much bolder to lie than usual: players at the table who rarely call are easy to lie to */
function boldness(s: Situation): number {
  const others = opponents(s.view);
  if (others.length === 0) return 1;
  const rate = others.reduce((sum, o) => sum + callRate(s, o.id), 0) / others.length;
  return clamp(Math.pow(PRIOR_CALL / Math.max(0.01, rate), 0.6 * s.me.readWeight), 0.8, 2.2);
}

/** players still holding cards who could call on me (never my 2v2 partner) */
function opponents(v: RoomView) {
  const partner = partnerIn(v, v.meId);
  return v.players.filter((p) => p.id !== v.meId && p.id !== partner && p.cardCount > 0);
}

/** copies of a rank this bot is sure are out of everyone else's hands: its own, its partner's, its cards in the pile, discarded ones */
function sure(s: Situation, rank: Rank, sharp: boolean): number {
  const v = s.view;
  let n = countIn(v.hand, rank) + countIn(v.partnerHand ?? [], rank);
  for (const e of s.mem.pile) n += countIn(e.mine ?? [], rank);
  return sharp ? n + (s.mem.gone.get(rank) ?? 0) : n;
}

/** copies it remembers others holding; they may have played them off as fakes since, so it's only a hint */
function remembered(s: Situation, rank: Rank, exceptId: string): number {
  const v = s.view;
  const partner = partnerIn(v, v.meId);
  let n = 0;
  for (const p of v.players) {
    if (p.id !== exceptId && p.id !== v.meId && p.id !== partner) n += s.mem.knownOf(p.id, rank, p.cardCount);
  }
  return n;
}

/** a guess at how a play looks: the chance it hides a fake, the fewest fakes card counting proves, and the share of lies that are all fake */
export interface Suspicion {
  p: number;
  minFake: number;
  /** of the lies, the share with no real card at all (a player who had none of the rank) */
  allFake: number;
}

/** chance the last play hides a fake, and the fewest fakes it must hold by card counting */
export function suspicion(s: Situation): Suspicion {
  const v = s.view;
  const play = v.lastPlay!;
  const sharp = s.rand() < s.me.memory;
  const room = copies(v) - sure(s, play.rank, sharp);
  const minFake = Math.max(0, play.count - room);
  if (minFake > 0) return { p: 1, minFake, allFake: minFake >= play.count ? 1 : 0.3 };
  // copies that are probably still out there
  const likely = room - (sharp ? 0.6 * remembered(s, play.rank, play.playerId) : 0);

  // called plays are the suspicious ones, so the table's caught rate runs high; trim it for an average play
  const gut = clamp(tableRate(s) * 0.75 + s.me.call * 0.12, 0.03, 0.9);
  const record = bluffRate(s, play.playerId);
  let base: number;
  let allFake: number;
  const following = s.mem.pile.length > 1;
  if (following) {
    // a player following a round either holds the rank or doesn't: weigh their hand against how they play
    const hand = (v.players.find((p) => p.id === play.playerId)?.cardCount ?? 0) + play.count;
    const u = s.mem.unseen(v, play.rank);
    const none = 1 - holdChance(u, hand, 1);
    const enough = holdChance(u, hand, play.count);
    const pad = padRate(s, play.playerId, false);
    // a player without the rank usually pushes a single fake; two or more at once is rarer
    const pushed = none * pushRate(s, play.playerId) * (play.count === 1 ? 1 : play.count === 2 ? 0.4 : 0.2);
    const padded = (1 - none - enough) * pad + enough * pad * 0.5;
    const honest = enough * (1 - pad * 0.5);
    const model = (pushed + padded) / Math.max(1e-6, pushed + padded + honest);
    allFake = pushed / Math.max(1e-6, pushed + padded);
    // careful bots lean on the odds; gut players less so
    const trust = 0.55 + 0.35 * s.me.readWeight;
    base = clamp(trust * model + (1 - trust) * gut, 0.02, 0.97);
  } else {
    // an opener picks the rank, so a lie there is a fake slipped among real cards, or rarely a rank they don't hold at all
    const pad = padRate(s, play.playerId, true) * (1 + 0.15 * Math.max(0, play.count - 2));
    // one card can't hide a fake among real ones; a known liar may still claim a rank they don't hold
    const model = play.count >= 2 ? pad : 0.7 * record + 0.1 * pushRate(s, play.playerId);
    allFake = play.count >= 2 ? 0.15 : 1;
    const trust = 0.45 + 0.35 * s.me.readWeight;
    base = clamp(trust * model + (1 - trust) * gut * 0.75, 0.02, 0.95);
  }
  let odds = base / (1 - base);
  // claims of this rank close to (or past) the copies that can still be out there
  const claimed = s.mem.pile.filter((e) => !e.mine).reduce((n, e) => n + e.count, 0);
  const pressure = claimed / Math.max(1, likely);
  if (pressure > 0.85) odds *= 1 + 2.5 * (pressure - 0.85);
  const left = v.players.find((p) => p.id === play.playerId)?.cardCount ?? 9;
  if (left === 0) odds *= 1.6;
  else if (left <= 2) odds *= 1.25;
  const p = odds / (1 + odds);
  return { p: clamp(p + noise(s.rand) * 0.05 * (0.5 + s.me.temper), 0.02, 0.98), minFake: 0, allFake };
}

/** share of a bluff's cards that are fake, as a guess when nothing more is known */
const fakeShare = (count: number) => (count <= 1 ? 1 : 0.35 + 0.65 / count);

/** chance a call turns up a fake: any card under "show all", the picked one under "pick one" (share: chance that card is the fake in a padded lie) */
function hitChance(s: Situation, sus: Suspicion, share: number): number {
  const count = s.view.lastPlay!.count;
  if (s.view.config.bluffRule === 'all') return sus.p;
  return Math.max(sus.minFake / count, sus.p * (sus.allFake + (1 - sus.allFake) * share));
}

/** under "pick one": the card to turn over, and the chance it's the fake in a padded lie */
function pickCard(s: Situation, playerId: string, count: number): { index: number; share: number } {
  if (count <= 1) return { index: 0, share: 1 };
  const spots = fakeSpots(s, playerId, count);
  const best = spots.indexOf(Math.max(...spots));
  // go for the likeliest spot, not every time, so the pick can't be read
  if (spots[best] > 1 / count && s.rand() < Math.min(0.9, spots[best] + 0.15)) return { index: best, share: spots[best] };
  const index = Math.floor(s.rand() * count);
  return { index, share: spots[index] };
}

/** weighs a call: catching a liar against picking up the pile, and against letting a lie through, with this bot's leanings and some chance */
function wantsCall(s: Situation, hit: number, onTurn: boolean, sus: Suspicion): boolean {
  const v = s.view;
  const play = v.lastPlay!;
  if (hit >= 0.999) return s.rand() < 0.97;
  const left = v.players.find((p) => p.id === play.playerId)?.cardCount ?? 9;
  const firstOpen = v.players.every((p) => p.place === null);
  let gain = v.pileCount + 2;
  // stopping someone from finishing, above all from taking 1st place
  if (left === 0) gain += (firstOpen ? 12 : 4) * (0.5 + s.me.closer);
  else if (left <= 2) gain += 2 * s.me.closer;
  if (onTurn) gain += 0.5;
  // a wrong call hands them the next round too
  let loss = v.pileCount * (1 + s.me.pileFear) + 2;
  if (v.hand.length <= 3) loss += 4 * (1 - s.me.closer * 0.5);
  if (v.bluffCallsLeft === 1) loss += 1.5;
  // staying quiet isn't free: an uncalled lie gets rid of their fakes, and that counts most with few players or against the leader
  const fakes = sus.allFake * play.count + (1 - sus.allFake);
  const rivals = opponents(v).length;
  const leader = v.players.every((p) => p.id === play.playerId || p.cardCount === 0 || p.cardCount >= left);
  const letGo = sus.p * fakes * (rivals <= 1 ? 1 : 0.9 / rivals) * (leader ? 1.5 : 1);
  const ev = (hit * gain - (1 - hit) * loss + letGo) / (v.pileCount + 3);
  const lean = s.me.call * 0.4 + s.mem.mood * 0.15 - 0.2;
  return s.rand() < sigmoid((ev + lean) / (0.08 + 0.2 * s.me.temper));
}

/** call bluff on the last play or not, maybe after a secret peek; returns the card to turn over */
export function decideCall(s: Situation, onTurn: boolean, peek: Peek): { cardIndex?: number } | null {
  const v = s.view;
  const play = v.lastPlay;
  if (!play || play.playerId === v.meId || v.bluffCallsLeft === 0 || partnerIn(v, v.meId) === play.playerId) return null;
  const one = v.config.bluffRule === 'one';
  const sus = suspicion(s);
  const pick = pickCard(s, play.playerId, play.count);
  let hit = hitChance(s, sus, pick.share);
  let cardIndex = one ? pick.index : undefined;

  const unsure = sus.minFake === 0 && hit > 0.18 && hit < 0.8;
  if (v.peeksLeft > 0 && unsure && v.pileCount >= 2 && s.rand() < s.me.peek) {
    const i = Math.floor(s.rand() * play.count);
    const card = peek(i);
    if (card && card.rank !== play.rank) {
      hit = 1;
      if (one) cardIndex = i;
    } else if (card && play.count === 1) {
      hit = 0;
    } else if (card) {
      // one real card seen: the rest are less likely to hide a fake
      const fs = fakeShare(play.count);
      const p = (sus.p * (1 - fs)) / (sus.p * (1 - fs) + (1 - sus.p));
      hit = one ? p * fakeShare(play.count - 1) : p;
      if (one) cardIndex = (i + 1 + Math.floor(s.rand() * (play.count - 1))) % play.count;
    }
  }
  if (hit <= 0.01 || !wantsCall(s, hit, onTurn, sus)) return null;
  return { cardIndex };
}

/** chance someone calls this play of mine and finds a fake */
function caughtChance(s: Situation, fakes: number, count: number, finishing: boolean): number {
  if (fakes === 0) return 0;
  const v = s.view;
  const shown = v.config.bluffRule === 'all' ? 1 : fakes / count;
  let safe = 1;
  for (const o of opponents(v)) {
    const rate = s.me.readWeight * callRate(s, o.id) * (0.6 + 0.8 * callSkill(s, o.id)) + (1 - s.me.readWeight) * PRIOR_CALL;
    // big claims and finishing plays draw calls; a big pile makes callers think twice
    const c = rate * (1 + 0.25 * (count - 1)) * (finishing ? 2.2 : 1) * (1 - Math.min(0.5, v.pileCount * 0.03));
    safe *= 1 - clamp(c, 0.02, 0.9) * shown;
  }
  return 1 - safe;
}

/** cards to pass off as something else: from ranks it holds least of, with some chance */
function pickFakes(s: Situation, claim: Rank, n: number): Card[] {
  const others = s.view.hand.filter((c) => c.rank !== claim);
  const size = (r: Rank) => countIn(s.view.hand, r);
  return others
    .map((c) => ({ c, key: size(c.rank) + s.rand() * 1.5 }))
    .sort((a, b) => a.key - b.key)
    .slice(0, n)
    .map((x) => x.c);
}

/** cards go down in a random order, so where a fake sits gives nothing away */
function put(s: Situation, cards: Card[], rank: Rank): BotMove {
  return { kind: 'play', cardIds: shuffled(cards, s.rand).map((c) => c.id), rank: s.view.roundRank ? undefined : rank };
}

/** this bot's turn: call the last play, play cards, or pass */
export function chooseTurn(s: Situation, peek: Peek): BotMove {
  s.mem.mood *= 0.85;
  const call = decideCall(s, true, peek);
  if (call) return { kind: 'call', cardIndex: call.cardIndex };
  return s.view.roundRank ? follow(s, s.view.roundRank) : open(s);
}

type Option = { cards: Card[]; rank: Rank; score: number } | { pass: true; score: number };

const tauOf = (s: Situation) => 0.3 + 1.1 * s.me.temper;
const finishBonus = (s: Situation, n: number) => (n === s.view.hand.length ? 6 * (0.5 + s.me.closer) : 0);

/** starting a round: pick the rank to claim, sometimes with fakes slipped in */
function open(s: Situation): BotMove {
  const v = s.view;
  const groups = new Map<Rank, Card[]>();
  for (const c of v.hand) groups.set(c.rank, [...(groups.get(c.rank) ?? []), c]);
  if (groups.size === 1) return put(s, v.hand, v.hand[0].rank);

  const bluffy = clamp((s.me.openBluff + s.mem.mood * 0.25) * boldness(s), 0.02, 0.95);
  const options: Option[] = [];
  for (const [rank, cards] of groups) {
    const k = cards.length >= 3 && s.rand() < s.me.sandbag ? cards.length - 1 : cards.length;
    const real = cards.slice(0, k);
    options.push({ cards: real, rank, score: k + finishBonus(s, k) + noise(s.rand) * 0.3 });
    if (s.rand() >= bluffy) continue;
    const fakes = pickFakes(s, rank, 1 + Math.floor(s.rand() * s.me.padMax));
    const n = k + fakes.length;
    // never claim more than can exist, as far as anyone could tell
    if (fakes.length === 0 || n > copies(v) - (sure(s, rank, true) - k)) continue;
    const pc = caughtChance(s, fakes.length, n, n === v.hand.length);
    options.push({ cards: [...real, ...fakes], rank, score: n - pc * (n + 2) + finishBonus(s, n) * (1 - pc) });
  }
  // now and then claim a rank it doesn't hold at all
  if (s.rand() < bluffy * s.me.bluff * 0.4) {
    const missing = (['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'] as Rank[]).filter((r) => !groups.has(r));
    if (missing.length > 0) {
      const rank = missing[Math.floor(s.rand() * missing.length)];
      const fakes = pickFakes(s, rank, 1 + Math.floor(s.rand() * s.me.padMax));
      const pc = caughtChance(s, fakes.length, fakes.length, fakes.length === v.hand.length);
      options.push({ cards: fakes, rank, score: fakes.length - pc * (fakes.length + 2) });
    }
  }
  const pick = choose(options, (o) => o.score, tauOf(s), s.rand) as Extract<Option, { cards: Card[] }>;
  return put(s, pick.cards, pick.rank);
}

/** a round is on: play real cards of its rank, slip in fakes, or pass */
function follow(s: Situation, rank: Rank): BotMove {
  const v = s.view;
  const real = v.hand.filter((c) => c.rank === rank);
  const others = v.hand.length - real.length;
  const claimed = s.mem.pile.reduce((n, e) => n + e.count, 0);
  const options: Option[] = [];

  // a pass that ends the round throws an opponent's last play away (fakes and all) and hands them the next opening
  const lp = v.lastPlay;
  const gift =
    !!lp &&
    partnerIn(v, v.meId) !== lp.playerId &&
    v.players.every((p) => p.id === v.meId || p.id === lp.playerId || p.cardCount === 0 || v.passedIds.includes(p.id));
  if (lp) {
    const passScore = -0.4 + (real.length === 0 ? 0.3 : -0.8) + s.me.sandbag * 0.6 - (v.hand.length <= 3 ? 1.2 * s.me.closer : 0) - (gift ? 0.7 : 0);
    options.push({ pass: true, score: passScore });
  }
  if (real.length > 0) {
    const k = real.length >= 2 && s.rand() < s.me.sandbag * 0.6 ? real.length - 1 : real.length;
    options.push({ cards: real.slice(0, k), rank, score: k + finishBonus(s, k) });
  }
  const bluffy = clamp((s.me.bluff + s.mem.mood * 0.25) * boldness(s), 0.02, 0.97);
  for (let f = 1; f <= s.me.padMax && f <= others; f++) {
    // even a careful bot thinks about a fake card rather than give the round away
    if (s.rand() >= (f === 1 && gift ? Math.max(bluffy, 0.55) : bluffy)) continue;
    const fakes = pickFakes(s, rank, f);
    const n = real.length + f;
    let pc = caughtChance(s, f, n, n === v.hand.length);
    // more claims of a rank than exist: anyone adding up the round would know
    if (claimed + n > copies(v)) pc = Math.max(pc, 0.92);
    options.push({ cards: [...real, ...fakes], rank, score: n - pc * (v.pileCount + n + 2) + finishBonus(s, n) * (1 - pc) });
  }
  // nothing else left to do: a single fake card
  if (options.length === 0) return put(s, pickFakes(s, rank, 1), rank);
  const pick = choose(options, (o) => o.score, tauOf(s), s.rand);
  return 'pass' in pick ? { kind: 'pass' } : put(s, pick.cards, pick.rank);
}
