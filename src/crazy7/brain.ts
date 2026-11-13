import { buildDeck } from '../cards.js';
import type { Card, RoomView } from '../types.js';
import type { Crazy7Action, Crazy7Personality, Crazy7Style, OpponentRead, Rand, SeatView } from './bot-models.js';
import { Crazy7Game, type Crazy7State } from './game.js';
import { breaksRead, type Crazy7Memory } from './memory.js';

type Range = [number, number];
type Recipe = Record<Exclude<keyof Crazy7Personality, 'style'>, Range>;

/** each style is a range per trait; every bot draws its own numbers inside it. All of them search hard */
const STYLES: Record<Crazy7Style, Recipe> = {
  // fires 7s early and keeps the pressure on
  hunter: { budgetMs: [40, 50], maxPlayouts: [400, 600], memory: [0.75, 0.9], temper: [0.25, 0.45], sevens: [0.6, 1], switching: [0, 0.3], tempo: [0.75, 1], chatty: [0.25, 0.4] },
  // keeps 7s as shields against incoming picks
  guardian: { budgetMs: [40, 50], maxPlayouts: [400, 600], memory: [0.8, 0.95], temper: [0.15, 0.3], sevens: [-1, -0.6], switching: [0, 0.3], tempo: [1, 1.3], chatty: [0.1, 0.2] },
  // loves turning the suit with a same-number card
  switcher: { budgetMs: [40, 55], maxPlayouts: [400, 650], memory: [0.75, 0.9], temper: [0.3, 0.5], sevens: [-0.2, 0.3], switching: [0.6, 1], tempo: [0.8, 1.1], chatty: [0.15, 0.3] },
  // the deepest thinker with the best memory
  counter: { budgetMs: [55, 70], maxPlayouts: [800, 1100], memory: [0.95, 1], temper: [0.05, 0.15], sevens: [-0.3, 0.2], switching: [0, 0.3], tempo: [1, 1.3], chatty: [0.05, 0.15] },
};

export const CRAZY7_STYLES = Object.keys(STYLES) as Crazy7Style[];

const draw = (rand: Rand, [lo, hi]: Range) => lo + rand() * (hi - lo);

export function makePersonality(style: Crazy7Style, rand: Rand): Crazy7Personality {
  const traits = Object.fromEntries(Object.entries(STYLES[style]).map(([k, range]) => [k, draw(rand, range)])) as Omit<Crazy7Personality, 'style'>;
  return { ...traits, style, maxPlayouts: Math.round(traits.maxPlayouts) };
}

/** a style nobody at the table plays yet, else any */
export function pickStyle(taken: Crazy7Style[], rand: Rand): Crazy7Style {
  const free = CRAZY7_STYLES.filter((s) => !taken.includes(s));
  const from = free.length > 0 ? free : CRAZY7_STYLES;
  return from[Math.floor(rand() * from.length)];
}

/** small fast seeded random numbers, so every option is played out on the same luck */
export function seededRand(seed: number): Rand {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** the Crazy 7 table from a seat's room view; null outside Crazy 7 */
export function seatView(view: RoomView): SeatView | null {
  if (!view.crazy7) return null;
  return {
    meId: view.meId,
    turnId: view.turnId,
    config: view.config,
    hand: view.hand,
    players: view.players.map((p) => ({ id: p.id, cardCount: p.cardCount })),
    c7: view.crazy7,
  };
}

/** every different move open to me now (two identical cards from two decks count once) */
export function candidates(v: SeatView): Crazy7Action[] {
  const out: Crazy7Action[] = [];
  const seen = new Set<string>();
  for (const id of v.c7.playable) {
    const card = v.hand.find((c) => c.id === id);
    if (!card || seen.has(card.rank + card.suit)) continue;
    seen.add(card.rank + card.suit);
    out.push({ kind: 'play', cardId: id });
  }
  // picking or passing while a card fits only makes sense to keep a 7 back as a shield
  const keepable = out.length === 0 || v.c7.penalty > 0 || v.c7.playable.every((id) => v.hand.find((c) => c.id === id)?.rank === '7');
  if (v.c7.canPick && keepable) out.push({ kind: 'pick' });
  if (v.c7.canPass && keepable) out.push({ kind: 'pass' });
  if (out.length === 0 && v.c7.canPass) out.push({ kind: 'pass' });
  return out;
}

/** a move the rules always take: a matching card, else pick, else pass */
export function fallback(v: SeatView): Crazy7Action {
  if (v.c7.playable.length > 0) return { kind: 'play', cardId: v.c7.playable[0] };
  return v.c7.canPick ? { kind: 'pick' } : { kind: 'pass' };
}

const shuffled = <T>(items: T[], rand: Rand): T[] => {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
};

const readSize = (r: OpponentRead | undefined) => (r ? r.voidSuits.size + r.voidRanks.size : 0);

/** one guess at the hidden cards that fits everything public: card counts, the pile, and what opponents surely lack */
export function sample(v: SeatView, mem: Crazy7Memory, useReads: boolean, rand: Rand): Crazy7State {
  const top = v.c7.top;
  const known = new Set([...v.hand.map((c) => c.id), ...mem.pile.map((c) => c.id), ...(top ? [top.id] : [])]);
  const pool = shuffled(
    buildDeck(v.config.decks).filter((c) => !known.has(c.id)),
    rand,
  );
  const used = new Array<boolean>(pool.length).fill(false);
  const take = (ok: (c: Card) => boolean): Card | null => {
    for (let i = 0; i < pool.length; i++) {
      if (!used[i] && ok(pool[i])) {
        used[i] = true;
        return pool[i];
      }
    }
    return null;
  };

  const hands = new Map<string, Card[]>(v.players.map((p) => [p.id, [] as Card[]]));
  hands.set(v.meId, [...v.hand]);
  const plan = v.players
    .filter((p) => p.id !== v.meId && p.cardCount > 0)
    .map((p) => {
      const r = useReads ? mem.reads.get(p.id) : undefined;
      return { id: p.id, count: p.cardCount, r, sure: r ? Math.max(0, p.cardCount - r.fresh) : 0 };
    })
    .sort((a, b) => readSize(b.r) - readSize(a.r));
  // cards they've held since their read was made must fit it; the rest can be anything
  for (const x of plan) {
    for (let k = 0; k < x.sure; k++) {
      const c = take((card) => !breaksRead(x.r!, card)) ?? take(() => true);
      if (c) hands.get(x.id)!.push(c);
    }
  }
  for (const x of plan) {
    const h = hands.get(x.id)!;
    while (h.length < x.count) {
      const c = take(() => true);
      if (!c) break;
      h.push(c);
    }
  }
  const rest = pool.filter((_, i) => !used[i]);
  const deck = rest.slice(0, v.c7.deckCount);
  // anything left over is pile we never saw (before this bot started watching)
  const unseen = rest.slice(v.c7.deckCount);
  const pile = [...mem.pile.filter((c) => c.id !== top?.id), ...unseen, ...(top ? [top] : [])];
  return {
    order: v.players.map((p) => p.id),
    config: v.config,
    hands,
    deck,
    pile,
    turnId: v.turnId,
    penalty: v.c7.penalty,
    picks: v.c7.picks,
    picked: [...v.c7.picked],
    called: new Set(v.c7.called),
    missed: new Set(v.c7.missed),
    atRisk: v.c7.atRisk,
    over: false,
    places: [],
  };
}

/** decisions in one playout before it's judged on hand sizes instead */
const DEPTH = 140;
/** a few samples even when the clock says stop, so a slow moment never means a blind guess */
const MIN_SAMPLES = 6;

const count = (cards: Card[], ok: (c: Card) => boolean) => cards.reduce((n, c) => n + (ok(c) ? 1 : 0), 0);

/** cards held by the next player still in */
function nextCount(g: Crazy7Game, id: string): number {
  const start = g.order.indexOf(id);
  for (let step = 1; step < g.order.length; step++) {
    const n = g.hand(g.order[(start + step) % g.order.length]).length;
    if (n > 0) return n;
  }
  return 99;
}

/** a quick sensible move for any seat in a playout: keep your long suit alive, save 7s, fire them at a near-winner */
function quickCard(g: Crazy7Game, id: string, legal: Card[], rand: Rand): Card {
  const hand = g.hand(id);
  const next = nextCount(g, id);
  let best = legal[0];
  let bestScore = -Infinity;
  for (const c of legal) {
    let s = count(hand, (x) => x !== c && x.suit === c.suit) + 0.5 * count(hand, (x) => x !== c && x.rank === c.rank);
    if (c.rank === '7') s += g.penalty > 0 ? 50 : next <= 2 ? 3 : -2.5;
    // with two cards left, a 7 kept as the last one answers any 7 aimed at you and wins
    else if (hand.length === 2 && hand.some((x) => x.rank === '7')) s += 2;
    s += rand() * 0.6;
    if (s > bestScore) {
      bestScore = s;
      best = c;
    }
  }
  return best;
}

/** plays a card, saying "last card" with the second-last one (straight after, when a waiting 7 didn't allow it before) */
function playCard(g: Crazy7Game, id: string, cardId: string): void {
  if (g.hand(id).length === 2 && g.canCall(id)) g.call(id);
  g.play(id, cardId);
  if (g.atRisk === id && g.canCall(id)) g.call(id);
}

function apply(g: Crazy7Game, id: string, a: Crazy7Action): void {
  if (a.kind === 'play') playCard(g, id, a.cardId);
  else if (a.kind === 'pick') g.pick(id);
  else g.pass(id);
}

/** one seat's move in a playout */
function quickMove(g: Crazy7Game, id: string, rand: Rand): void {
  const legal = g.playable(id);
  if (legal.length > 0) return playCard(g, id, quickCard(g, id, legal, rand).id);
  if (g.canPick(id)) return void g.pick(id);
  if (g.canPass(id)) return void g.pass(id);
  throw new Error('no move');
}

/** my rough chance from hand sizes when a playout runs long */
function estimate(g: Crazy7Game, meId: string): number {
  const live = g.order.filter((id) => g.hand(id).length > 0);
  const total = live.reduce((sum, id) => sum + 1 / g.hand(id).length, 0);
  const mine = g.hand(meId).length;
  return mine > 0 && total > 0 ? 1 / mine / total : 0;
}

/** plays one option out to the end on one guess of the hidden cards: 1 if I win; a loss counts a little more the closer I came */
export function playout(state: Crazy7State, first: Crazy7Action, meId: string, seed: number, depth = DEPTH): number {
  const rand = seededRand(seed);
  const g = Crazy7Game.fromState(state, (max) => Math.floor(rand() * max));
  try {
    // anyone still able to say "last card" is assumed to say it in time
    if (g.atRisk && g.canCall(g.atRisk)) g.call(g.atRisk);
    apply(g, meId, first);
    for (let step = 0; step < depth && !g.over && g.turnId; step++) quickMove(g, g.turnId, rand);
  } catch {
    return 0.5;
  }
  if (!g.over) return estimate(g, meId);
  return g.winners()[0] === meId ? 1 : 0.1 / (1 + g.hand(meId).length);
}

/** the next opponent still holding cards, by turn order */
function nextOpponent(v: SeatView): { id: string; cardCount: number } | null {
  const i = v.players.findIndex((p) => p.id === v.meId);
  for (let step = 1; step < v.players.length; step++) {
    const p = v.players[(i + step) % v.players.length];
    if (p.cardCount > 0 && p.id !== v.meId) return p;
  }
  return null;
}

/** a quick judgement of each option from what this seat can see; the search starts from it and soon outweighs it */
export function priors(v: SeatView, mem: Crazy7Memory, options: Crazy7Action[]): number[] {
  const hand = v.hand;
  const top = v.c7.top;
  const known = new Set([...hand.map((c) => c.id), ...mem.pile.map((c) => c.id), ...(top ? [top.id] : [])]);
  const unknown = buildDeck(v.config.decks).filter((c) => !known.has(c.id));
  const next = nextOpponent(v);
  const k = next?.cardCount ?? 7;
  const read = next ? mem.reads.get(next.id) : undefined;
  const hasPlay = v.c7.playable.length > 0;
  /** chance the next player holds nothing that answers this card */
  const stuck = (c: Card): number => {
    const answers = unknown.filter((x) => (c.rank === '7' ? x.rank === '7' : x.suit === c.suit || x.rank === c.rank));
    // what they surely lack makes them likelier to be stuck
    const sure = !!read && read.fresh === 0 && (c.rank === '7' ? read.voidRanks.has('7') : read.voidSuits.has(c.suit) && read.voidRanks.has(c.rank));
    const p = unknown.length > 0 ? (1 - answers.length / unknown.length) ** k : 0;
    return sure ? Math.max(p, 0.6) : p;
  };
  const raw = options.map((o) => {
    if (o.kind === 'pick') return v.c7.penalty > 0 ? -2 : hasPlay ? -4 : 0.5;
    if (o.kind === 'pass') return hasPlay ? -3 : 0;
    const c = hand.find((x) => x.id === o.cardId);
    if (!c) return -5;
    if (v.c7.penalty > 0) return 5;
    const sevens = count(hand, (x) => x.rank === '7');
    let s = count(hand, (x) => x !== c && x.suit === c.suit) + 0.4 * count(hand, (x) => x !== c && x.rank === c.rank) + 3 * stuck(c);
    // 7s are shields; fire one at a player about to go out, or when there are spares
    if (c.rank === '7') s += k <= 2 ? 4 : sevens >= 2 ? -0.5 : -1.5;
    // with two cards left, keep the 7 as the last one: it answers any 7 aimed at you and wins
    else if (hand.length === 2 && sevens > 0) s += 1.5;
    return s;
  });
  const lo = Math.min(...raw);
  const hi = Math.max(...raw);
  return raw.map((x) => (hi > lo ? (x - lo) / (hi - lo) : 0.5));
}

/** style nudges, small next to what the search finds */
function lean(v: SeatView, me: Crazy7Personality, a: Crazy7Action): number {
  if (a.kind !== 'play') return 0;
  const card = v.hand.find((c) => c.id === a.cardId);
  const top = v.c7.top;
  if (!card) return 0;
  let b = 0;
  if (card.rank === '7' && v.c7.penalty === 0) b += me.sevens * 0.03;
  if (top && card.rank === top.rank && card.suit !== top.suit) b += me.switching * 0.02;
  return b;
}

/** picks one option, better ones far more often; tau says how loose */
function choose<T>(options: T[], values: number[], tau: number, rand: Rand): T {
  const top = Math.max(...values);
  const weights = values.map((x) => Math.exp((x - top) / tau));
  let r = rand() * weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < options.length; i++) {
    r -= weights[i];
    if (r <= 0) return options[i];
  }
  return options[options.length - 1];
}

export interface Thinking {
  view: SeatView;
  mem: Crazy7Memory;
  me: Crazy7Personality;
  rand: Rand;
  /** overrides the personality's limits (tests) */
  budgetMs?: number;
  maxPlayouts?: number;
}

export interface Verdict {
  action: Crazy7Action;
  /** each option with its estimated chance to win */
  scores: { action: Crazy7Action; value: number }[];
  samples: number;
}

/** the first judgement counts as this many played-out samples */
const PRIOR_WEIGHT = 20;

/** searches every option over many guesses of the hidden cards and keeps the one that wins most */
export function think(t: Thinking): Verdict {
  const options = candidates(t.view);
  if (options.length === 0) return { action: fallback(t.view), scores: [], samples: 0 };
  if (options.length === 1) return { action: options[0], scores: [{ action: options[0], value: 1 }], samples: 0 };
  const budget = t.budgetMs ?? t.me.budgetMs;
  const most = Math.max(0, t.maxPlayouts ?? t.me.maxPlayouts);
  const live = Math.max(2, t.view.players.filter((p) => p.cardCount > 0).length);
  // a fair seat wins 1 in `live`; the quick judgement moves that a little either way
  const prior = priors(t.view, t.mem, options).map((p) => (0.6 + 0.8 * p) / live);
  const wins = options.map(() => 0);
  const started = performance.now();
  let n = 0;
  while (n < most && (n < Math.min(MIN_SAMPLES, most) || performance.now() - started < budget)) {
    const state = sample(t.view, t.mem, t.rand() < t.me.memory, t.rand);
    const seed = Math.floor(t.rand() * 2 ** 31);
    options.forEach((o, i) => (wins[i] += playout(state, o, t.view.meId, seed)));
    n++;
  }
  const est = options.map((_, i) => (wins[i] + PRIOR_WEIGHT * prior[i]) / (n + PRIOR_WEIGHT));
  const values = options.map((o, i) => est[i] + lean(t.view, t.me, o));
  const action = choose(options, values, 0.004 + 0.02 * t.me.temper, t.rand);
  return { action, scores: options.map((o, i) => ({ action: o, value: est[i] })), samples: n };
}

export const decide = (t: Thinking): Crazy7Action => think(t).action;
