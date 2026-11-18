import { RANKS, type Card, type LifetimeStats, type PublicPlayer, type Rank, type RoomView } from '../types.js';
import { copiesOf, likeliestFake, readPlay, realIn, seenReal, spotWeights, sureCopies, type PlayRead, type Sight } from './detector.js';
import { skillOf, type Skill } from './levels.js';
import { partnerIn, type BotMemory } from './memory.js';
import type { BotMove, BotStyle, Personality, Plan, PlanMode, Rand } from './models.js';
import { holdChance, type Unseen } from './odds.js';
import { botCallsOf, policyOf } from './profile.js';

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
  // a score that went wrong never wins
  const scores = options.map((o) => {
    const x = score(o);
    return Number.isFinite(x) ? x : -1e9;
  });
  const top = Math.max(...scores);
  const weights = scores.map((x) => Math.exp((x - top) / tau));
  let r = rand() * weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < options.length; i++) {
    r -= weights[i];
    if (r <= 0) return options[i];
  }
  return options[options.length - 1];
}

/** how likely a player is to call bluff on any one play (for a person: how they treat bots' plays above all) */
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
  // saved from past games: how often they call a bot's play (someone who trusts bots is easy to lie to)
  const bots = botCallsOf(s.mem, id, skillIn(s).level);
  if (bots) {
    const n = Math.min(40, bots.seen);
    a += bots.rate * n;
    b += (1 - bots.rate) * n;
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

/** the moods a bot plays in for a few rounds: plain, heavy on fakes, full of tricks (slow-plays, fake now and real later), or honest and sharp */
const MODES: Record<PlanMode, { lie: number; trap: number; call: number }> = {
  straight: { lie: 0, trap: 0.1, call: 0 },
  pressure: { lie: 0.9, trap: -0.2, call: -0.3 },
  tricky: { lie: 0.2, trap: 1.3, call: 0.1 },
  tight: { lie: -0.9, trap: 0.3, call: 0.5 },
};

/** how often each style goes into each mode (any style can be in any of them) */
const MODE_ODDS: Record<BotStyle, Record<PlanMode, number>> = {
  shark: { straight: 3, pressure: 2, tricky: 3, tight: 2 },
  maniac: { straight: 2, pressure: 5, tricky: 2, tight: 1 },
  rock: { straight: 3, pressure: 1, tricky: 2, tight: 4 },
  detective: { straight: 3, pressure: 2, tricky: 2, tight: 3 },
  trickster: { straight: 2, pressure: 2, tricky: 5, tight: 1 },
  gambler: { straight: 2, pressure: 4, tricky: 3, tight: 1 },
};

/**
 * What it's up to for the next few rounds: one of its modes (plain, heavy on fakes, tricky, or honest and sharp), each a little off
 * its centre, plus which ranks it fancies opening. Drawn again every 1 to 4 rounds and right after it's caught or calls wrong, so a
 * pattern someone spots in one round says little about the next.
 */
export function planOf(s: Situation): Plan {
  const mem = s.mem;
  if (mem.plan && mem.rounds < mem.plan.until) return mem.plan;
  const skill = skillIn(s);
  const odds = MODE_ODDS[s.me.style] ?? MODE_ODDS.shark;
  const names = Object.keys(odds) as PlanMode[];
  // sloppier levels play fewer tricks
  const mode = choose(names, (m) => Math.log(odds[m] * (m === 'tricky' ? skill.tricks : 1) + 0.01), 1, s.rand);
  const m = MODES[mode];
  mem.plan = {
    mode,
    lie: clamp((m.lie + noise(s.rand) * 0.25) * skill.swing, -1.5, 1.5),
    trap: clamp((m.trap + noise(s.rand) * 0.25) * skill.tricks, -0.6, 1.6),
    call: clamp((m.call + noise(s.rand) * 0.25) * skill.swing, -1, 1),
    fancy: RANKS.map(() => (s.rand() - 0.5) * 2.4 * skill.swing),
    until: mem.rounds + 1 + Math.floor(s.rand() * 4),
  };
  return mem.plan;
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

/** the call: worth it when catching a liar outweighs being wrong, with this bot's leanings; close calls are mixed, never a fixed line */
function wantsCall(s: Situation, hit: number, gain: number, loss: number, read: PlayRead): boolean {
  const skill = skillIn(s);
  if (hit >= 0.999) return s.rand() < skill.sureCall;
  // a reckless style calls on a hunch now and then (barely at higher levels)
  if (hit > 0.2 && s.rand() < Math.max(0, s.me.call) * 0.25 * skill.style) return true;
  const ev = (hit * gain - (1 - hit) * loss) / (gain + loss);
  const lean = (s.me.call * 0.3 + s.mem.mood * 0.05) * skill.style + planOf(s).call * 0.05;
  // someone it knows little about: an early close call also teaches it how they play
  const learn = hit > 0.3 ? (1 - read.known) * 0.04 : 0;
  // near the line its answer is mixed, so nobody can find the exact point where it stops calling; steadier on a big pile,
  // and with more players around (everyone's doubts add up, and others may call anyway)
  const pile = s.view.pileCount;
  const around = Math.max(1, opponents(s.view).length);
  const temp = skill.callTemp / Math.sqrt(around) / (1 + pile / 10);
  if (s.rand() < 1 / (1 + Math.exp(-(ev + lean + learn) / temp))) return true;
  // now and then it tests a claim that looks fine while the pile is small: cheap to be wrong, and no lie is ever free (shared round the
  // table); never when the pile would cost it its own finish
  const cheap = pile <= 4 && s.view.hand.length > 3;
  return cheap && hit > 0.06 && s.rand() < (skill.audit / around) * Math.min(1, hit / 0.25) * (1 - pile / 6);
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
  const sight = sightOf(s);
  let read = readPlay(sight, skill.level);
  const entry = s.mem.entryOf(play.id);
  // cards it already peeked at in this play (weighing it again on its own turn): a fake one is a sure call, a real one is known
  let fakeAt: number | null = null;
  for (let i = 0; i < (entry?.seen.length ?? 0); i++) {
    if (entry!.seen[i].rank !== play.rank) fakeAt = entry!.seenAt[i];
    else read = seenReal(read, entry!.seenAt[i]);
  }
  if (entry) {
    entry.realEst = realIn(read);
    entry.fakes = read.fakes;
    entry.sure ??= sureCopies(sight, play.rank);
    // kept to check against whatever gets turned over, unless a peek already steered the call
    entry.read = entry.seen.length > 0 ? null : { lie: read.lie, spots: read.spots };
  }
  const { gain, loss } = stakes(s, onTurn);
  const target = (r: PlayRead) => (last ? anyLikely(r, s.rand) : aim(s, r));
  let index = fakeAt ?? target(read);
  let hit = fakeAt !== null ? 1 : one ? read.spots[index] : read.lie;

  // on last cards a good bot peeks at the card it means to turn over; under "show all" the call shows every card anyway; never twice at one card
  const fresh = (entry?.seen.length ?? 0) < play.count;
  const canLook = fakeAt === null && fresh && v.peeksLeft > 0 && (last ? one && read.minFake < play.count : hit < 0.999);
  const look = !canLook ? null : !skill.smartPeek ? whimPeek(s, hit) : last ? index : planPeek(s, read, gain, loss);
  if (look !== null && !entry?.seenAt.includes(look)) {
    const card = peek(look);
    if (card) {
      if (entry) {
        entry.seen.push(card);
        entry.seenAt.push(look);
        // a real card there may prove the player's earlier claim this round was the fake one
        if (card.rank === play.rank) s.mem.noteTrap(entry, entry.seen.filter((c) => c.rank === play.rank).length, v.config.decks);
      }
      // a play that clashes with the round (or springs a proven trap) is about the round, not this player's honesty
      if (!entry || !(s.mem.clash(entry, v.config.decks) || entry.trapped)) s.mem.checkRead(play.playerId, read.spots[look], card.rank !== play.rank);
      // the rest of this play's reveal was steered by the peek, so it doesn't check the read again
      if (entry) entry.read = null;
      if (card.rank !== play.rank) {
        hit = 1;
        index = look;
      } else {
        read = seenReal(read, look);
        if (entry) {
          entry.realEst = realIn(read);
          entry.fakes = read.fakes;
        }
        index = target(read);
        hit = one ? read.spots[index] : read.lie;
      }
    }
  }
  if (last) return { cardIndex: one ? index : undefined };
  if (hit <= 0.01 || !wantsCall(s, hit, gain, loss, read)) return null;
  return { cardIndex: one ? index : undefined };
}

/** one way to play this turn */
interface Choice {
  cards: Card[];
  rank: Rank;
  /** fake cards in it */
  fakes: number;
  /** real cards of the rank it keeps back for later */
  kept: number;
}

/** an opponent who could call my play: how often they call any play, and how much likelier on a lie or on the truth */
interface Rival {
  p: PublicPlayer;
  rate: number;
  lie: number;
  truth: number;
}

/** what every option of one turn shares, worked out once */
interface Turn {
  s: Situation;
  skill: Skill;
  plan: Plan;
  /** extra worth of lying and of keeping real cards back: its style, its mood and its current plan */
  lean: { lie: number; trap: number };
  /** cards claimed so far this round, by anyone */
  claimed: number;
  rivals: Rival[];
  /** a wrong call lands the pile on someone else: all of it counts heads-up, less with more players around */
  heads: number;
  unseen: Map<Rank, Unseen>;
  /** cards other people have in the pile or threw away: in nobody's hand */
  outCards: number;
}

function turnOf(s: Situation): Turn {
  const v = s.view;
  const skill = skillIn(s);
  const plan = planOf(s);
  const rivals = opponents(v).map((p) => {
    const rate = s.me.readWeight * callRate(s, p.id) * (0.6 + 0.8 * callSkill(s, p.id)) + (1 - s.me.readWeight) * PRIOR_CALL;
    // people who read bots well call their lies more than their truths (saved habits)
    const seen = botCallsOf(s.mem, p.id, skill.level);
    return { p, rate, lie: seen ? seen.lie / seen.rate : 1, truth: seen ? seen.truth / seen.rate : 1 };
  });
  return {
    s,
    skill,
    plan,
    lean: {
      lie: (s.me.bluff - 0.4) * 1.2 * skill.style + s.mem.mood * 0.25 + plan.lie,
      trap: (s.me.sandbag - 0.2) * 0.8 * skill.style + plan.trap,
    },
    claimed: s.mem.pile.reduce((t, e) => t + e.count, 0),
    rivals,
    heads: rivals.length <= 1 ? 1 : 0.6,
    unseen: new Map(),
    outCards: s.mem.pile.reduce((n, e) => (e.mine ? n : n + e.count), 0) + s.mem.othersGone,
  };
}

function unseenIn(t: Turn, rank: Rank): Unseen {
  let u = t.unseen.get(rank);
  if (!u) {
    u = t.s.mem.unseen(t.s.view, rank);
    t.unseen.set(rank, u);
  }
  return u;
}

/** what opponents' hands are dealt from: the cards I can't see minus other people's cards in the pile and the thrown-away piles */
function handsPool(t: Turn, rank: Rank): Unseen {
  const u = unseenIn(t, rank);
  let real = t.s.mem.goneMean(rank);
  for (const e of t.s.mem.pile) if (!e.mine) real += e.realEst ?? e.count * 0.55;
  return { cards: Math.max(1, u.cards - t.outCards), copies: Math.max(0, u.copies - real) };
}

/** chance a play gets called (by anyone), and that the call finds a fake; good bots count who could prove a claim false from their own cards */
function risk(t: Turn, n: number, fakes: number, rank: Rank): { called: number; caught: number } {
  const v = t.s.view;
  const finishing = n === v.hand.length;
  let quiet = 1;
  for (const r of t.rivals) {
    // other bots always call last cards
    if (finishing && r.p.bot) {
      quiet = 0;
      continue;
    }
    // big claims and finishing plays draw calls; a big pile makes callers think twice
    let c = r.rate * (fakes > 0 ? r.lie : r.truth) * (1 + 0.25 * (n - 1)) * (finishing ? 2.2 : 1) * (1 - Math.min(0.5, v.pileCount * 0.03));
    if (t.skill.provable > 0) {
      // anyone holding this many copies knows the round's claims can't all be true and calls: right only if I lied (else my trap worked)
      const need = copiesOf(v) - t.claimed - n + 1;
      c += (1 - c) * 0.85 * t.skill.provable * (need <= 0 ? 1 : holdChance(handsPool(t, rank), r.p.cardCount, need));
    }
    quiet *= 1 - clamp(c, 0.02, 0.97);
  }
  const called = 1 - quiet;
  // my cards go down shuffled, so under "pick one" a call finds a fake only by luck
  const shown = fakes === 0 ? 0 : v.config.bluffRule === 'all' ? 1 : fakes / n;
  return { called, caught: called * shown };
}

/** 0..1: how hard a card of this rank is to get rid of honestly: a lone card, or a rank whose other copies are mostly gone */
function junkiness(t: Turn, rank: Rank): number {
  const held = countIn(t.s.view.hand, rank);
  const alone = held === 1 ? 1 : held === 2 ? 0.55 : held === 3 ? 0.25 : 0.1;
  const left = unseenIn(t, rank).copies - t.s.mem.goneMean(rank);
  return clamp(alone * 0.8 + (left <= 1 ? 0.2 : 0), 0, 1);
}

/** emptying my hand: worth most while 1st place is still open */
const finishBonus = (s: Situation, n: number) =>
  n === s.view.hand.length ? (s.view.players.every((p) => p.place === null) ? 8 : 5) * (0.5 + s.me.closer) : 0;

/** near the end, a hand left as one rank can go out honestly next time (bots always call last cards, people often do) */
function exitBonus(t: Turn, cards: Card[]): number {
  if (!t.skill.junk) return 0;
  const rest = t.s.view.hand.filter((x) => !cards.includes(x));
  if (rest.length === 0 || rest.length > 6) return 0;
  const ranks = new Set(rest.map((x) => x.rank)).size;
  return ranks === 1 ? 1.2 : ranks === 2 ? 0.35 : 0;
}

/** what a play is worth, in cards: what it sheds (junk counts extra), minus the pile it may cost, plus the pile a wrong call hands someone */
function worth(t: Turn, c: Choice): number {
  const v = t.s.view;
  const n = c.cards.length;
  const { called, caught } = risk(t, n, c.fakes, c.rank);
  let w = n - caught * (v.pileCount + n + 2) + (called - caught) * (v.pileCount + n) * t.heads;
  w += finishBonus(t.s, n) * (1 - caught) + exitBonus(t, c.cards);
  if (c.fakes > 0) {
    for (const x of c.cards) if (x.rank !== c.rank) w += t.skill.junk ? 0.6 * junkiness(t, x.rank) - 0.15 : 0.1;
    w += t.lean.lie;
  }
  if (c.kept > 0) w += t.lean.trap;
  return w;
}

/** cards to pass off as the claim: good bots take the ones hardest to get rid of honestly, others mostly their smallest groups */
function pickFakes(t: Turn, claim: Rank, n: number): Card[] {
  const hand = t.s.view.hand;
  return hand
    .filter((c) => c.rank !== claim)
    .map((c) => ({ c, key: (t.skill.junk ? -3 * junkiness(t, c.rank) : countIn(hand, c.rank)) + t.s.rand() * 1.5 }))
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

const tauOf = (s: Situation) => (0.3 + 1.1 * s.me.temper) * skillIn(s).loose;
/** a claim nobody could believe, as far as anyone could tell from my side (more copies than can be out there) */
const impossible = (s: Situation, rank: Rank, n: number, real: number) => n > copiesOf(s.view) - (sureCopies(sightOf(s), rank) - real);

/** the whole hand as one claim, real cards and fakes together, to go out now */
function finishOption(t: Turn, rank: Rank, real: Card[]): Choice | null {
  const v = t.s.view;
  const fakes = v.hand.length - real.length;
  if (fakes === 0 || fakes > t.skill.finishFakes || impossible(t.s, rank, v.hand.length, real.length)) return null;
  return { cards: v.hand, rank, fakes, kept: 0 };
}

/** ways to claim a rank it holds: all of them, some kept back, fakes slipped in, or fakes now with the real ones kept for later */
function claimsOf(t: Turn, rank: Rank, real: Card[], others: number): Choice[] {
  const s = t.s;
  const k = real.length;
  const out: Choice[] = [];
  if (k > 0) out.push({ cards: real, rank, fakes: 0, kept: 0 });
  if (k >= 2) out.push({ cards: real.slice(0, k - 1), rank, fakes: 0, kept: 1 });
  const finish = finishOption(t, rank, real);
  if (finish) out.push(finish);
  for (let f = 1; f <= s.me.padMax && f <= others; f++) {
    const fakes = pickFakes(t, rank, f);
    // emptying the hand on fakes is the finishing option's call (its level caps the fakes)
    if (k + f < s.view.hand.length && !impossible(s, rank, k + f, k)) out.push({ cards: [...real, ...fakes], rank, fakes: f, kept: 0 });
    // the trap: claim no more than it holds, keep the real ones; later they make an honest claim look impossible
    if (k > 0 && f <= k && t.skill.tricks > 0 && f < s.view.hand.length) out.push({ cards: fakes, rank, fakes: f, kept: k });
  }
  return out;
}

/** starting a round: any rank it holds, in any of those ways, or now and then a rank it hasn't got */
function open(s: Situation): BotMove {
  const v = s.view;
  const groups = new Map<Rank, Card[]>();
  for (const c of v.hand) groups.set(c.rank, [...(groups.get(c.rank) ?? []), c]);
  if (groups.size === 1) return put(s, v.hand, v.hand[0].rank);
  const t = turnOf(s);
  const options: Choice[] = [];
  for (const [rank, cards] of groups) options.push(...claimsOf(t, rank, cards, v.hand.length - cards.length));
  // a few ranks it hasn't got, claimed with junk
  for (const rank of shuffled(RANKS.filter((r) => !groups.has(r)), s.rand).slice(0, 3)) {
    for (let f = 1; f <= s.me.padMax && f < v.hand.length; f++) {
      if (impossible(s, rank, f, 0)) break;
      options.push({ cards: pickFakes(t, rank, f), rank, fakes: f, kept: 0 });
    }
  }
  // the ranks it fancies opening change with its plan, so an opening doesn't give its biggest group away
  const pick = choose(options, (o) => worth(t, o) + t.plan.fancy[RANKS.indexOf(o.rank)], tauOf(s), s.rand);
  return put(s, pick.cards, pick.rank);
}

/** a round is on: real cards (all or some), fakes slipped in, fakes now and the real ones later, a lone push, or pass (even holding the rank) */
function follow(s: Situation, rank: Rank): BotMove {
  const v = s.view;
  const t = turnOf(s);
  const real = v.hand.filter((c) => c.rank === rank);
  const options: (Choice | null)[] = claimsOf(t, rank, real, v.hand.length - real.length);
  const scores = new Map<Choice | null, number>(options.map((o) => [o, worth(t, o!)]));
  // a pass that ends the round throws an opponent's last play away (fakes and all) and hands them the next opening
  const lp = v.lastPlay;
  if (lp) {
    const gift =
      partnerIn(v, v.meId) !== lp.playerId &&
      v.players.every((p) => p.id === v.meId || p.id === lp.playerId || p.cardCount === 0 || v.passedIds.includes(p.id));
    // holding the rank and passing anyway hides it: nobody can read "none" from a pass
    const hold = real.length > 0 ? t.lean.trap - 0.9 : s.me.sandbag * 0.3;
    // handing the next opening to someone about to go out can lose the game
    const left = v.players.find((p) => p.id === lp.playerId)?.cardCount ?? 9;
    const opening = gift ? 0.7 + (t.skill.junk && left <= 3 ? (4 - left) * 0.9 : 0) : 0;
    scores.set(null, -0.15 + hold - (v.hand.length <= 3 ? 1.2 * s.me.closer : 0) - opening);
    options.push(null);
  }
  // nothing else left to do: a single fake card
  if (options.length === 0) return put(s, pickFakes(t, rank, 1), rank);
  // now and then (in tricky moods most) it keeps its real cards back anyway: half the time a plain pass, so a pass doesn't always say
  // "none", unless that hands the next opening to someone about to go out; a play that goes out is never given up for it
  const slow = real.length > 0 && v.hand.length > 4 && s.rand() < slowChance(t);
  const about = lp !== null && (v.players.find((p) => p.id === lp.playerId)?.cardCount ?? 9) <= 3;
  const out = options.some((o) => o !== null && o.cards.length === v.hand.length);
  if (slow && options.includes(null) && !about && !out && s.rand() < 0.5) return { kind: 'pass' };
  const held = options.filter((o) => o === null || o.kept > 0 || o.cards.length === v.hand.length);
  const pick = choose(slow && held.length > 0 ? held : options, (o) => scores.get(o)!, tauOf(s), s.rand);
  return pick === null ? { kind: 'pass' } : put(s, pick.cards, rank);
}

/** chance it holds its real cards back on a turn it could play them: more in tricky moods, less at sloppier levels */
const slowChance = (t: Turn) => clamp(0.03 + 0.1 * Math.max(0, t.plan.trap), 0, 0.2) * t.skill.tricks;
