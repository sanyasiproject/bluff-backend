import type { Card, LifetimeStats, Rank, RoomView } from '../types.js';
import { copiesOf, likeliestFake, readPlay, realIn, seenReal, spotWeights, sureCopies, type PlayRead, type Sight } from './detector.js';
import { skillOf, type Skill } from './levels.js';
import { partnerIn, type BotMemory } from './memory.js';
import type { BotMove, Personality, Rand } from './models.js';
import { holdChance } from './odds.js';
import { policyOf } from './profile.js';

/** chance a player calls any one play, before knowing anything about them */
const PRIOR_CALL = 0.12;
/** floors for accounts from before plays and chances were counted */
const CHANCES_PER_GAME = 15;

/** Bluff games only: Crazy 7 games say nothing about how someone lies or calls */
const bluffGames = (life: LifetimeStats) => life.gamesPlayed - (life.crazy7Games ?? 0);

/** everything a decision looks at: the table exactly as this bot's seat sees it, plus its memory */
export interface Situation {
  view: RoomView;
  mem: BotMemory;
  me: Personality;
  rand: Rand;
  /** how well it plays (the room's bot level); missing means expert */
  skill?: Skill;
}

/** shows one card of the last play to this bot only; null when the peek isn't allowed */
export type Peek = (index: number) => Card | null;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
/** bell-shaped noise around 0, spread about 1 */
const noise = (rand: Rand) => (rand() + rand() + rand() - 1.5) * 2;
const countIn = (cards: Card[], rank: Rank) => cards.filter((c) => c.rank === rank).length;

const skillIn = (s: Situation): Skill => s.skill ?? skillOf(s.view.config?.botLevel);

/** chance this decision uses everything the bot remembers: always for experts, less for sloppier levels and forgetful styles */
const recallOf = (s: Situation) => clamp(1 - (1 - skillIn(s).memory) * (1.4 - s.me.memory), 0, 1);

const sightOf = (s: Situation): Sight => ({ view: s.view, mem: s.mem, rand: s.rand, recall: recallOf(s) });

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
  const w = spotWeights(policyOf(s.mem, id, false, s.skill?.level ?? s.view.config?.botLevel), n);
  const sum = w.reduce((a, b) => a + b, 0);
  return w.map((x) => x / sum);
}

/** a guess at how a play looks: the chance it hides a fake, the fewest fakes card counting proves, and the share of lies that are all fake */
export interface Suspicion {
  p: number;
  minFake: number;
  /** of the lies, the share with no real card at all */
  allFake: number;
}

/** chance the last play hides a fake (the detector's read, in short) */
export function suspicion(s: Situation): Suspicion {
  const read = readPlay(sightOf(s), skillIn(s).level);
  const all = read.fakes[read.fakes.length - 1];
  return { p: read.lie, minFake: read.minFake, allFake: read.lie > 0 ? all / read.lie : 0 };
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

/** what a call is worth in cards: they take the pile if it's a lie, I take it if it's true */
function stakes(s: Situation, onTurn: boolean): { gain: number; loss: number } {
  const v = s.view;
  const play = v.lastPlay!;
  const skill = skillIn(s);
  const left = v.players.find((p) => p.id === play.playerId)?.cardCount ?? 9;
  const firstOpen = v.players.every((p) => p.place === null);
  const rivals = opponents(v);
  // the pile hurts most whoever is closest to going out
  const fewest = Math.min(v.hand.length, ...rivals.filter((o) => o.id !== play.playerId).map((o) => o.cardCount));
  const threat = rivals.length <= 1 ? 1 : left <= fewest ? 1.15 : 0.85;
  let gain = v.pileCount * threat + 1;
  // a lie that would finish them, above all for 1st place
  if (left === 0) gain += firstOpen ? 14 : 6;
  else if (left <= 2) gain += 3 - left;
  if (onTurn) gain += 0.5;
  let loss = v.pileCount + 1;
  // the pile would wreck my own finish
  if (v.hand.length <= 3) loss += 3;
  // my last call before I must play or pass first
  if (v.bluffCallsLeft === 1) loss += 0.6;
  // styles: a careful bot fears the pile, a closer goes after finishers
  loss *= 1 + (s.me.pileFear - 0.4) * 0.8 * skill.style;
  if (left <= 2) gain *= 1 + (s.me.closer - 0.5) * 0.4 * skill.style;
  return { gain, loss };
}

/** the call: worth it when catching a liar outweighs being wrong, with this bot's leanings and its level's wobble */
function wantsCall(s: Situation, hit: number, gain: number, loss: number, read: PlayRead): boolean {
  const skill = skillIn(s);
  if (hit >= 0.999) return s.rand() < skill.sureCall;
  // a reckless style calls on a hunch now and then (barely at higher levels)
  if (hit > 0.2 && s.rand() < Math.max(0, s.me.call) * 0.25 * skill.style) return true;
  const ev = (hit * gain - (1 - hit) * loss) / (gain + loss);
  const lean = (s.me.call * 0.3 + s.mem.mood * 0.05) * skill.style;
  // someone it knows little about: an early close call also teaches it how they play
  const learn = hit > 0.3 ? (1 - read.known) * 0.04 : 0;
  return ev + lean + learn + noise(s.rand) * skill.noise > 0;
}

/** under "pick one": the card to turn over; good bots go for the likeliest fake */
function aim(s: Situation, read: PlayRead): number {
  if (s.rand() < skillIn(s).aim) return likeliestFake(read, s.rand);
  const open = read.spots.map((p, i) => (p > 0 ? i : -1)).filter((i) => i >= 0);
  return open[Math.floor(s.rand() * open.length)] ?? 0;
}

/** on someone's last cards: any card may be turned over, likelier fakes more often, so real ones can't hide where it usually looks */
function anyLikely(read: PlayRead, rand: Rand): number {
  let r = rand() * read.spots.reduce((a, b) => a + b, 0);
  for (let i = 0; i < read.spots.length; i++) {
    r -= read.spots[i];
    if (read.spots[i] > 0 && r <= 0) return i;
  }
  // nothing looks fake: any card not already seen real
  const open = read.weights.map((w, i) => (w > 0 ? i : -1)).filter((i) => i >= 0);
  return open[Math.floor(rand() * open.length)] ?? 0;
}

/** a peek is scarce: what one is worth keeping for later, in cards (less as the game runs out or with more of them left) */
function peekCost(v: RoomView): number {
  const cards = v.players.reduce((n, p) => n + p.cardCount, 0) + v.pileCount;
  const ahead = Math.min(1, cards / (40 * v.config.decks));
  return (1 + 2.5 * ahead) / Math.sqrt(Math.max(1, v.peeksLeft));
}

/** a careful peek: the card whose look could change the call the most, when that's worth more than keeping the peek */
function planPeek(s: Situation, read: PlayRead, gain: number, loss: number): number | null {
  const one = s.view.config.bluffRule === 'one';
  const worth = (r: PlayRead) => {
    const hit = one ? Math.max(...r.spots) : r.lie;
    return hit >= 0.999 ? gain : Math.max(0, hit * gain - (1 - hit) * loss);
  };
  const now = worth(read);
  let best = -1;
  let most = 0;
  read.spots.forEach((p, j) => {
    // a fake seen means a sure call with that card; a real one sharpens the rest
    const after = p * gain + (1 - p) * worth(seenReal(read, j)) - now;
    if (p > 0 && after > most) {
      most = after;
      best = j;
    }
  });
  const cost = peekCost(s.view) * (1 + noise(s.rand) * skillIn(s).noise);
  return best >= 0 && most > cost ? best : null;
}

/** a casual peek: when unsure, now and then, at any card */
function whimPeek(s: Situation, hit: number): number | null {
  const v = s.view;
  if (hit <= 0.18 || hit >= 0.8 || v.pileCount < 2 || s.rand() >= s.me.peek) return null;
  return Math.floor(s.rand() * v.lastPlay!.count);
}

/** call bluff on the last play or not, maybe after a secret peek; returns the card to turn over */
export function decideCall(s: Situation, onTurn: boolean, peek: Peek): { cardIndex?: number } | null {
  const v = s.view;
  const play = v.lastPlay;
  if (!play || play.playerId === v.meId || v.bluffCallsLeft === 0 || v.hand.length === 0 || partnerIn(v, v.meId) === play.playerId) return null;
  const skill = skillIn(s);
  const one = v.config.bluffRule === 'one';
  // their last cards: if the play stands they're out, so it's always called
  const last = v.players.find((p) => p.id === play.playerId)?.cardCount === 0;
  let read = readPlay(sightOf(s), skill.level);
  const entry = s.mem.entryOf(play.id);
  if (entry) {
    entry.realEst = realIn(read);
    // kept to check against whatever gets turned over
    entry.read = { lie: read.lie, spots: read.spots };
  }
  const { gain, loss } = stakes(s, onTurn);
  const target = (r: PlayRead) => (last ? anyLikely(r, s.rand) : aim(s, r));
  let index = target(read);
  let hit = one ? read.spots[index] : read.lie;

  // on last cards a good bot peeks at the card it means to turn over; under "show all" the call shows every card anyway
  const canLook = v.peeksLeft > 0 && (last ? one && read.minFake < play.count : hit < 0.999);
  const look = !canLook ? null : !skill.smartPeek ? whimPeek(s, hit) : last ? index : planPeek(s, read, gain, loss);
  if (look !== null) {
    const card = peek(look);
    if (card) {
      entry?.seen.push(card);
      s.mem.checkRead(play.playerId, read.spots[look], card.rank !== play.rank);
      // the rest of this play's reveal was steered by the peek, so it doesn't check the read again
      if (entry) entry.read = null;
      if (card.rank !== play.rank) {
        hit = 1;
        index = look;
      } else {
        read = seenReal(read, look);
        if (entry) entry.realEst = realIn(read);
        index = target(read);
        hit = one ? read.spots[index] : read.lie;
      }
    }
  }
  if (last) return { cardIndex: one ? index : undefined };
  if (hit <= 0.01 || !wantsCall(s, hit, gain, loss, read)) return null;
  return { cardIndex: one ? index : undefined };
}

/** chance someone calls this play of mine and finds a fake; good bots also count who could prove it false from their own cards */
function caughtChance(s: Situation, fakes: number, count: number, finishing: boolean, rank: Rank): number {
  if (fakes === 0) return 0;
  const v = s.view;
  const skill = skillIn(s);
  // my cards go down shuffled, so under "pick one" a call finds a fake only by luck
  const shown = v.config.bluffRule === 'all' ? 1 : fakes / count;
  // anyone holding this many copies knows the round's claims can't all be true
  const claimed = s.mem.pile.reduce((n, e) => n + e.count, 0);
  const need = copiesOf(v) - claimed - count + 1;
  const unseen = s.mem.unseen(v, rank);
  let safe = 1;
  for (const o of opponents(v)) {
    const rate = s.me.readWeight * callRate(s, o.id) * (0.6 + 0.8 * callSkill(s, o.id)) + (1 - s.me.readWeight) * PRIOR_CALL;
    // big claims and finishing plays draw calls; a big pile makes callers think twice
    let c = rate * (1 + 0.25 * (count - 1)) * (finishing ? 2.2 : 1) * (1 - Math.min(0.5, v.pileCount * 0.03));
    if (skill.provable) c += (1 - c) * 0.85 * (need <= 0 ? 1 : holdChance(unseen, o.cardCount, need));
    // other bots always call last cards
    safe *= 1 - (finishing && o.bot ? 1 : clamp(c, 0.02, 0.97)) * shown;
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

const tauOf = (s: Situation) => (0.3 + 1.1 * s.me.temper) * skillIn(s).loose;
/** how keen this style is on a lie, added to every lying option's score (a maniac loves one, a rock doesn't) */
const appetite = (s: Situation) => (s.me.bluff - 0.4) * 1.5 * skillIn(s).style;
/** emptying my hand: worth most while 1st place is still open */
const finishBonus = (s: Situation, n: number) =>
  n === s.view.hand.length ? (s.view.players.every((p) => p.place === null) ? 8 : 5) * (0.5 + s.me.closer) : 0;
/** a claim nobody could believe, as far as anyone could tell from my side (more copies than can be out there) */
const impossible = (s: Situation, rank: Rank, n: number, real: number) => n > copiesOf(s.view) - (sureCopies(sightOf(s), rank) - real);

/** the whole hand as one claim, real cards and fakes together, to go out now */
function finishOption(s: Situation, rank: Rank, real: Card[]): Option | null {
  const v = s.view;
  const fakes = v.hand.length - real.length;
  if (fakes === 0 || fakes > skillIn(s).finishFakes || impossible(s, rank, v.hand.length, real.length)) return null;
  const pc = caughtChance(s, fakes, v.hand.length, true, rank);
  const n = v.hand.length;
  return { cards: v.hand, rank, score: n - pc * (v.pileCount + n + 2) + finishBonus(s, n) * (1 - pc) + appetite(s) };
}

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
    const finish = finishOption(s, rank, cards);
    if (finish) options.push(finish);
    if (s.rand() >= bluffy) continue;
    const fakes = pickFakes(s, rank, 1 + Math.floor(s.rand() * s.me.padMax));
    const n = k + fakes.length;
    if (fakes.length === 0 || impossible(s, rank, n, k)) continue;
    const pc = caughtChance(s, fakes.length, n, n === v.hand.length, rank);
    options.push({ cards: [...real, ...fakes], rank, score: n - pc * (n + 2) + finishBonus(s, n) * (1 - pc) + appetite(s) });
  }
  // now and then claim a rank it doesn't hold at all
  if (s.rand() < bluffy * s.me.bluff * 0.4) {
    const missing = (['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'] as Rank[]).filter((r) => !groups.has(r));
    if (missing.length > 0) {
      const rank = missing[Math.floor(s.rand() * missing.length)];
      const fakes = pickFakes(s, rank, 1 + Math.floor(s.rand() * s.me.padMax));
      if (!impossible(s, rank, fakes.length, 0)) {
        const pc = caughtChance(s, fakes.length, fakes.length, fakes.length === v.hand.length, rank);
        options.push({ cards: fakes, rank, score: fakes.length - pc * (fakes.length + 2) + appetite(s) });
      }
    }
  }
  const pick = choose(options, (o) => o.score, tauOf(s), s.rand) as Extract<Option, { cards: Card[] }>;
  return put(s, pick.cards, pick.rank);
}

/** a round is on: play real cards of its rank, slip in fakes, go out with fakes, or pass */
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
  const finish = finishOption(s, rank, real);
  if (finish) options.push(finish);
  const bluffy = clamp((s.me.bluff + s.mem.mood * 0.25) * boldness(s), 0.02, 0.97);
  for (let f = 1; f <= s.me.padMax && f <= others; f++) {
    // even a careful bot thinks about a fake card rather than give the round away
    if (s.rand() >= (f === 1 && gift ? Math.max(bluffy, 0.55) : bluffy)) continue;
    const fakes = pickFakes(s, rank, f);
    const n = real.length + f;
    let pc = caughtChance(s, f, n, n === v.hand.length, rank);
    // more claims of a rank than exist: anyone adding up the round would know
    if (claimed + n > copiesOf(v)) pc = Math.max(pc, 0.92);
    options.push({ cards: [...real, ...fakes], rank, score: n - pc * (v.pileCount + n + 2) + finishBonus(s, n) * (1 - pc) + appetite(s) });
  }
  // nothing else left to do: a single fake card
  if (options.length === 0) return put(s, pickFakes(s, rank, 1), rank);
  const pick = choose(options, (o) => o.score, tauOf(s), s.rand);
  return 'pass' in pick ? { kind: 'pass' } : put(s, pick.cards, pick.rank);
}
