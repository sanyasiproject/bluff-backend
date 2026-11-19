import { backsClaim, type Card, type Rank, type RoomView } from '../types.js';
import { skillOf } from './levels.js';
import { hiddenReal, partnerIn, type BotMemory } from './memory.js';
import type { Policy } from './models.js';
import { convolve, copiesFor, holdingOdds } from './odds.js';
import { policyOf, PRIOR } from './profile.js';

/**
 * The lie detector. It reads the last play from what this bot's seat can see (its own cards, the public table and what it remembers)
 * plus the player's habits from past games. It never sees the cards of the play itself: the only way to look at one is a peek.
 */
export interface PlayRead {
  /** chance the play holds exactly f fake cards, f = 0..count */
  fakes: number[];
  /** chance it holds at least one fake */
  lie: number;
  /** fewest fakes card counting proves */
  minFake: number;
  /** for each card of the play (in the order it went down), the chance it's a fake */
  spots: number[];
  /** how strongly the player tends to hide fakes at each card, as odds; cards seen real get 0 */
  weights: number[];
  /** how much the bot knows about this player's habits (0 nothing, 1 plenty) */
  known: number;
}

/** what the detector needs: the table from this bot's seat and its memory */
export interface Sight {
  view: RoomView;
  mem: BotMemory;
  rand: () => number;
  /** 0..1: chance this decision uses everything it remembers (card counting at its sharpest) */
  recall: number;
}

/** cards that back up a claim of this rank: the rank itself, or the Kismat card */
const countIn = (cards: Card[], rank: Rank, kismat: Rank | null) => cards.filter((c) => backsClaim(c, rank, kismat)).length;
/** copies in the game that could back up a claim of this rank (Kismat cards count too) */
export const copiesOf = (v: RoomView, rank: Rank) => copiesFor(rank, v.config.decks, v.kismat);

/** chance a lie holds exactly f fakes, f >= 1, for a player whose lies hold `size` fakes on average */
export function fakeCount(f: number, size: number): number {
  if (f < 1) return 0;
  const p = 1 / Math.max(1, size);
  return p * Math.pow(1 - p, f - 1);
}

/** copies of a rank this bot is sure aren't in anyone else's hand: its own, its partner's, its cards in the pile, discarded ones */
export function sureCopies(s: Sight, rank: Rank): number {
  const v = s.view;
  const k = v.kismat;
  let n = countIn(v.hand, rank, k) + countIn(v.partnerHand ?? [], rank, k);
  for (const e of s.mem.pile) n += countIn(e.mine ?? [], rank, k);
  return n + (s.mem.gone.get(rank) ?? 0) + (k && k !== rank ? (s.mem.gone.get(k) ?? 0) : 0);
}

/** copies it remembers others holding (cards they picked up in front of it); they may have played them off since, so it's a hint */
function remembered(s: Sight, rank: Rank, exceptId: string): number {
  const v = s.view;
  const partner = partnerIn(v, v.meId);
  const wild = v.kismat && v.kismat !== rank ? v.kismat : null;
  let n = 0;
  for (const p of v.players) {
    if (p.id === exceptId || p.id === v.meId || p.id === partner) continue;
    n += wild ? Math.min(p.cardCount, s.mem.knownOf(p.id, rank, p.cardCount) + s.mem.knownOf(p.id, wild, p.cardCount)) : s.mem.knownOf(p.id, rank, p.cardCount);
  }
  return n;
}

/** cards of earlier plays this round (not mine, not the play being read): in the pile, so in nobody's hand */
function pileOthers(s: Sight, playId: string): number {
  return s.mem.pile.reduce((n, e) => (e.mine || e.id === playId ? n : n + e.count), 0);
}

/** real copies the earlier plays of this round probably hold (not mine, not the play being read; with Seedhi only claims of this rank) */
function pileReal(s: Sight, playId: string, rank: Rank): number {
  let n = 0;
  for (const e of s.mem.pile) {
    if (e.mine || e.id === playId || e.rank !== rank) continue;
    const seenReal = e.seen.filter((c) => backsClaim(c, e.rank, s.view.kismat)).length;
    n += Math.max(seenReal, e.realEst ?? e.count * 0.55);
  }
  return n;
}

/** chance of each card being one of the f fakes, given how strongly the player hides fakes at each spot (weights as odds) */
export function inclusion(weights: number[], f: number): number[] {
  const n = weights.length;
  const p = new Array<number>(n).fill(0);
  if (f <= 0) return p;
  const open = weights.map((w, i) => (w > 0 ? i : -1)).filter((i) => i >= 0);
  if (f >= open.length) {
    for (const i of open) p[i] = 1;
    return p;
  }
  // share f by weight, cap any share at 1 and pass the rest on
  const capped = new Set<number>();
  for (let round = 0; round < n; round++) {
    const rest = open.filter((i) => !capped.has(i));
    const need = f - capped.size;
    const sum = rest.reduce((a, i) => a + weights[i], 0);
    let over = false;
    for (const i of rest) {
      p[i] = sum > 0 ? (need * weights[i]) / sum : need / rest.length;
      if (p[i] >= 1) {
        p[i] = 1;
        capped.add(i);
        over = true;
      }
    }
    if (!over) break;
  }
  return p;
}

/** chance of each card being fake, over the chances of how many fakes there are */
function spotChances(fakes: number[], weights: number[]): number[] {
  const out = new Array<number>(weights.length).fill(0);
  fakes.forEach((pf, f) => {
    if (pf <= 0 || f === 0) return;
    inclusion(weights, f).forEach((x, i) => (out[i] += pf * x));
  });
  return out;
}

/** odds of a fake at each card of a play of n, from the player's first / middle / last habits */
export function spotWeights(pol: Policy, n: number): number[] {
  const odds = (p: number) => {
    const q = Math.min(0.95, Math.max(0.05, p));
    return q / (1 - q);
  };
  return Array.from({ length: n }, (_, i) => odds(i === 0 ? pol.spots[0] : i === n - 1 ? pol.spots[2] : pol.spots[1]));
}

/** chance of playing n cards with f fakes while holding k of the rank, having decided to play (lie: their chance of lying) */
function playChance(n: number, f: number, k: number, lie: number, pol: Policy): number {
  const real = n - f;
  if (real < 0 || real > k) return 0;
  if (f === 0) {
    if (real === 0) return 0;
    // honest: all their copies, or now and then fewer
    return (1 - lie) * (real === k ? (k > 1 ? 1 - pol.sandbag : 1) : pol.sandbag / (k - 1));
  }
  // a lie: usually with all their real copies, sometimes keeping some back
  const reals = k === 0 ? 1 : real === k ? 1 - pol.holdBack : pol.holdBack / k;
  return lie * reals * fakeCount(f, pol.size);
}

/**
 * Real copies of the rank out of the claimer's reach that the bot can only guess at (the real cards of earlier plays this round and of
 * thrown-away piles), as [copies, chance] pairs. Good bots keep the whole spread, so an earlier claim they believed may turn out to be
 * the lie: that's what beats "fake first, real later". Sloppier ones take one best guess.
 */
function goneSpread(s: Sight, playId: string, rank: Rank, joint: boolean): [number, number][] {
  const k = s.view.kismat;
  if (!joint) return [[pileReal(s, playId, rank) + s.mem.goneMean(rank, k), 1]];
  let spread = s.mem.goneOf(rank, k);
  for (const e of s.mem.pile) {
    if (e.mine || e.id === playId || e.rank !== rank) continue;
    // cards it peeked at and saw real are certain; the rest as it read them
    const seenReal = e.seen.filter((c) => backsClaim(c, e.rank, k)).length;
    spread = convolve(spread, [...new Array<number>(seenReal).fill(0), ...hiddenReal(e, k)]);
  }
  return spread.flatMap((p, g) => (p > 1e-4 ? [[g, p] as [number, number]] : []));
}

const oddsOf = (p: number) => p / (1 - p);

/** reads the last play: how many fakes it likely holds and where */
export function readPlay(s: Sight, level?: Parameters<typeof skillOf>[0]): PlayRead {
  const v = s.view;
  const play = v.lastPlay!;
  const n = play.count;
  const player = v.players.find((p) => p.id === play.playerId);
  const left = player?.cardCount ?? 0;
  const hand = left + n;
  const entry = s.mem.entryOf(play.id);
  const opening = entry ? entry.opening : s.mem.pile.length <= 1;
  const seedhi = !!v.config.seedhi;
  const sharp = s.rand() < s.recall;
  const joint = skillOf(level).joint;
  const pol = policyOf(s.mem, play.playerId, player?.bot ?? false, level);

  // card counting: what can't be in their hand for sure, and what probably isn't
  const sure = sureCopies(s, play.rank);
  const copies = copiesOf(v, play.rank);
  const maxReal = Math.max(0, copies - sure);
  const minFake = Math.max(0, n - maxReal);
  const unseen = s.mem.unseen(v, play.rank);
  // their hand came from the cards nobody can see that aren't sitting in this pile or the discards
  const pool = Math.max(hand, unseen.cards - pileOthers(s, play.id) - s.mem.othersGone);
  const room = Math.max(0, Math.min(maxReal, unseen.copies, pool));
  // copies others probably hold (picked up in front of it), and real copies in earlier plays and thrown-away piles
  const held = sharp ? 0.7 * remembered(s, play.rank, play.playerId) : 0;
  const gone: [number, number][] = sharp ? goneSpread(s, play.id, play.rank, joint) : [[0, 1]];
  // copies I saw them pick up are (most likely) still with them
  const known = sharp ? Math.min(entry?.knownBefore ?? 0, hand) : 0;

  // every way the earlier claims could have gone, weighed by how likely each makes this claim (the joint read of the round)
  const w = new Array<number>(n + 1).fill(0);
  for (const [g, pg] of gone) {
    let odds = holdingOdds(pool, Math.max(0, room - held - g), hand);
    if (known > 0) {
      const kept = odds.map((p, k) => (k >= known ? p : 0));
      const total = kept.reduce((a, b) => a + b, 0);
      if (total > 0) odds = odds.map((p, k) => 0.15 * p + (0.85 * kept[k]) / total);
    }
    odds.forEach((pk, k) => {
      if (pk <= 0) return;
      // an opener picks the rank: one they hold, their bigger groups far more often, rarely one they don't hold
      // with Seedhi a follower picks one of three ranks too: likelier one they hold more of
      const chose = opening ? (k > 0 ? (1 - pol.openNone) * ((k * k) / hand) : pol.openNone / 7) : seedhi ? k + 0.5 : 1;
      if (left === 0) {
        // the whole hand went down: true only if it was all this rank
        const f = hand - Math.min(k, hand);
        w[f] += pg * pk * chose * (f === 0 ? 1 : pol.finish);
        return;
      }
      for (let f = 0; f <= n; f++) {
        let like: number;
        if (opening) {
          like = chose * playChance(n, f, k, k > 0 ? pol.openPad : 1, pol);
        } else if (k === 0) {
          like = f === n ? chose * pol.push * fakeCount(n, pol.size) : 0;
        } else {
          like = chose * (1 - pol.hold) * playChance(n, f, k, pol.pad, pol);
        }
        w[f] += pg * pk * like;
      }
    });
  }
  for (let f = 0; f < Math.min(minFake, n + 1); f++) w[f] = 0;
  let total = w.reduce((a, b) => a + b, 0);
  if (!(total > 0)) {
    // nothing fits the habits: take the smallest lie the counting allows
    w.fill(0);
    w[Math.max(minFake, 1) <= n ? Math.max(minFake, 1) : n] = 1;
    total = 1;
  }
  let fakes = w.map((x) => x / total);
  // this claim clashes with the round (everyone's claims go past the copies, or other people's do with the copies only I know of), so some
  // claim of the round is a lie: this player's record says whether it's usually theirs
  // with Seedhi only the round's claims of this rank add up
  const same = s.mem.pile.filter((e) => e.rank === play.rank);
  const claimed = same.reduce((t, e) => t + e.count, 0);
  const others = same.reduce((t, e) => (e.mine ? t : t + e.count), 0);
  const clash = claimed > copies || others + sure > copies;
  const lift = joint && entry && same.length > 1 && n <= copies && clash ? oddsOf(pol.over) / oddsOf(PRIOR.over) : 1;
  if (minFake === 0 && lift !== 1) {
    const scaled = fakes.map((p, f) => (f === 0 ? p : p * lift));
    const sum = scaled.reduce((a, b) => a + b, 0);
    fakes = scaled.map((p) => p / sum);
  }
  const weights = spotWeights(pol, n);
  return { fakes, lie: 1 - fakes[0], minFake, spots: spotChances(fakes, weights), weights, known: pol.known };
}

/** the same read after a peek showed card j is real */
export function seenReal(read: PlayRead, j: number): PlayRead {
  const weights = read.weights.map((w, i) => (i === j ? 0 : w));
  const post = read.fakes.map((p, f) => p * (1 - inclusion(read.weights, f)[j]));
  const total = post.reduce((a, b) => a + b, 0);
  const fakes = total > 0 ? post.map((x) => x / total) : read.fakes;
  return { fakes, lie: 1 - fakes[0], minFake: read.minFake, spots: spotChances(fakes, weights), weights, known: read.known };
}

/** real cards the play most likely holds */
export const realIn = (read: PlayRead) => read.fakes.reduce((sum, p, f) => sum + p * (read.fakes.length - 1 - f), 0);

/** the card most likely to be a fake (ties broken at random) */
export function likeliestFake(read: PlayRead, rand: () => number): number {
  const top = Math.max(...read.spots);
  const best = read.spots.map((p, i) => (p >= top - 1e-9 ? i : -1)).filter((i) => i >= 0);
  return best[Math.floor(rand() * best.length)] ?? 0;
}
