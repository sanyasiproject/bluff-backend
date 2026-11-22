import { RANG_COLORS, type RangCard, type RangColor, type RangValue, type RoomView } from '../types.js';
import type { OpponentRead, Rand, RangAction, RangPersonality, RangSeatView, RangStyle } from './bot-models.js';
import { buildRangDeck, isWild, RangGame, type RangState } from './game.js';
import { breaksRead, type RangMemory } from './memory.js';

type Range = [number, number];
type Recipe = Record<Exclude<keyof RangPersonality, 'style'>, Range>;

/** each style is a range per trait; every bot draws its own numbers inside it. The server is single-threaded, so the search stays modest */
const STYLES: Record<RangStyle, Recipe> = {
  // fires +2 and +4 early, spends wilds, doubts every +4
  striker: { budgetMs: [15, 25], maxPlayouts: [160, 260], memory: [0.75, 0.9], temper: [0.25, 0.45], attack: [0.6, 1], wilds: [0.3, 0.8], switching: [0, 0.3], doubt: [0.3, 0.7], tempo: [0.75, 1], chatty: [0.25, 0.4] },
  // keeps wilds and +2/+4 back to answer one, rarely challenges
  hoarder: { budgetMs: [15, 25], maxPlayouts: [160, 260], memory: [0.8, 0.95], temper: [0.15, 0.3], attack: [-1, -0.6], wilds: [-1, -0.6], switching: [0, 0.3], doubt: [-0.6, -0.1], tempo: [1, 1.3], chatty: [0.1, 0.2] },
  // loves turning the colour with a same-value card
  shifter: { budgetMs: [18, 28], maxPlayouts: [180, 280], memory: [0.75, 0.9], temper: [0.3, 0.5], attack: [-0.2, 0.3], wilds: [-0.3, 0.3], switching: [0.6, 1], doubt: [-0.2, 0.3], tempo: [0.8, 1.1], chatty: [0.15, 0.3] },
  // the deepest thinker with the best memory
  counter: { budgetMs: [28, 35], maxPlayouts: [300, 400], memory: [0.95, 1], temper: [0.05, 0.15], attack: [-0.3, 0.2], wilds: [-0.3, 0.2], switching: [0, 0.3], doubt: [-0.1, 0.1], tempo: [1, 1.3], chatty: [0.05, 0.15] },
};

export const RANG_STYLES = Object.keys(STYLES) as RangStyle[];

const draw = (rand: Rand, [lo, hi]: Range) => lo + rand() * (hi - lo);

export function makePersonality(style: RangStyle, rand: Rand): RangPersonality {
  const traits = Object.fromEntries(Object.entries(STYLES[style]).map(([k, range]) => [k, draw(rand, range)])) as Omit<RangPersonality, 'style'>;
  return { ...traits, style, maxPlayouts: Math.round(traits.maxPlayouts) };
}

/** a style nobody at the table plays yet, else any */
export function pickStyle(taken: RangStyle[], rand: Rand): RangStyle {
  const free = RANG_STYLES.filter((s) => !taken.includes(s));
  const from = free.length > 0 ? free : RANG_STYLES;
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

/** the Rang table from a seat's room view; null outside Rang */
export function seatView(view: RoomView): RangSeatView | null {
  if (!view.rang) return null;
  return {
    meId: view.meId,
    turnId: view.turnId,
    config: view.config,
    players: view.players.map((p) => ({ id: p.id, cardCount: p.cardCount })),
    rang: view.rang,
  };
}

const count = <T>(items: T[], ok: (x: T) => boolean) => items.reduce((n, x) => n + (ok(x) ? 1 : 0), 0);

/** colours I hold (not counting wilds and the card being played), most first; ties go to the first in RANG_COLORS */
export function heldColors(hand: RangCard[], skip?: RangCard): RangColor[] {
  const rest = hand.filter((c) => c !== skip && !isWild(c));
  return RANG_COLORS.map((col) => [col, count(rest, (c) => c.color === col)] as const)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([col]) => col);
}

/** the colour I hold most, for naming with a wild; with only wilds left, the colour in play */
export function longColor(hand: RangCard[], skip?: RangCard, fallbackColor: RangColor | null = null): RangColor {
  return heldColors(hand, skip)[0] ?? fallbackColor ?? RANG_COLORS[0];
}

/** opponents still in, fewest cards first (ties: the nearer one in turn order) */
function byFewest(v: RangSeatView): { id: string; cardCount: number }[] {
  const i = v.players.findIndex((p) => p.id === v.meId);
  const len = v.players.length;
  const dist = (id: string) => {
    const j = v.players.findIndex((p) => p.id === id);
    return ((((j - i) * v.rang.dir) % len) + len) % len;
  };
  return v.players.filter((p) => p.id !== v.meId && p.cardCount > 0).sort((a, b) => a.cardCount - b.cardCount || dist(a.id) - dist(b.id));
}

/** a 7 swaps hands here: on with 7-0, and not my last card(s) */
const swaps = (v: RangSeatView, c: RangCard, putDown = 1) => !!v.config.rangSwap && c.value === '7' && v.rang.hand.length > putDown;

const NUMBER_VALUES: RangValue[] = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];

/** 2v2 partner: the seat across (teams on with exactly 4 players) */
export function partnerIn(v: RangSeatView): string | null {
  if (!v.config.teams || v.players.length !== 4) return null;
  const i = v.players.findIndex((p) => p.id === v.meId);
  return i < 0 ? null : v.players[(i + 2) % 4].id;
}

/** who a 7 of mine swaps with, best first: never my partner unless they hold far fewer cards than I'd give them */
function targets(v: RangSeatView, putDown = 1): { id: string; cardCount: number }[] {
  const partner = partnerIn(v);
  const keep = v.rang.hand.length - putDown;
  const all = byFewest(v);
  const ok = all.filter((p) => p.id !== partner || p.cardCount + 3 <= keep);
  return ok.length > 0 ? ok : all;
}

/**
 * a doubles play of one number: every card of it I hold, a card that fits first and the one whose colour I hold most last;
 * null with fewer than two, not a number, none that fits, or a top card of another number (doubles go only on the same number)
 */
export function doublesPlay(hand: RangCard[], fits: (c: RangCard) => boolean, value: RangValue, top: RangCard | null): RangCard[] | null {
  if (!NUMBER_VALUES.includes(value) || !top || top.value !== value) return null;
  const group = hand.filter((c) => c.value === value);
  if (group.length < 2) return null;
  const rest = hand.filter((c) => c.value !== value);
  const held = (c: RangCard) => count(rest, (x) => x.color === c.color);
  for (const last of [...group].sort((a, b) => held(b) - held(a))) {
    const first = group.find((c) => c !== last && fits(c));
    if (first) return [first, ...group.filter((c) => c !== first && c !== last), last];
  }
  return null;
}

/** the card hits the next player (skip, +2, +4) */
const hits = (c: RangCard) => c.value === 'skip' || c.value === 'draw2' || c.value === 'wild4';

/** every different move open to me now (two identical cards count once); a wild once per colour I hold, a 7 once per likely target */
export function candidates(v: RangSeatView, mem?: RangMemory, me?: RangPersonality): RangAction[] {
  const r = v.rang;
  const out: RangAction[] = [];
  const seen = new Set<string>();
  const kept = held(v, mem, me);
  for (const id of r.playable) {
    const card = r.hand.find((c) => c.id === id);
    if (!card || seen.has(card.value + card.color) || kept(card)) continue;
    seen.add(card.value + card.color);
    if (isWild(card)) {
      const colors = heldColors(r.hand, card);
      for (const color of colors.length > 0 ? colors : RANG_COLORS) out.push({ kind: 'play', cardId: id, color });
    } else if (swaps(v, card)) {
      for (const t of targets(v).slice(0, 2)) out.push({ kind: 'play', cardId: id, targetId: t.id });
    } else out.push({ kind: 'play', cardId: id });
  }
  // doubles: every card of one number at once
  if (v.config.rangDoubles) {
    const values = new Set<RangValue>();
    for (const id of r.playable) {
      const card = r.hand.find((c) => c.id === id);
      if (!card || values.has(card.value)) continue;
      values.add(card.value);
      const set = doublesPlay(r.hand, (c) => r.playable.includes(c.id), card.value, r.top);
      if (!set) continue;
      const base = { kind: 'play' as const, cardId: set[0].id, extra: set.slice(1).map((c) => c.id) };
      if (swaps(v, card, set.length)) for (const t of targets(v, set.length).slice(0, 2)) out.push({ ...base, targetId: t.id });
      else out.push(base);
    }
  }
  // 2v2: don't skip or +2 my partner while something else fits
  const next = seatAt(v, 1);
  if (next && next.id === partnerIn(v)) {
    const hitsPartner = (a: RangAction) => {
      const card = a.kind === 'play' ? r.hand.find((c) => c.id === a.cardId) : undefined;
      return !!card && hits(card) && r.penalty === 0;
    };
    if (out.some((a) => a.kind === 'play' && !hitsPartner(a))) out.splice(0, out.length, ...out.filter((a) => !hitsPartner(a)));
  }
  // picking or passing while a card fits only makes sense to keep a wild back
  const keepable = out.length === 0 || r.penalty > 0 || r.playable.every((id) => {
    const c = r.hand.find((x) => x.id === id);
    return !!c && isWild(c);
  });
  if (r.canPick && keepable) out.push({ kind: 'pick' });
  if (r.canPass && keepable) out.push({ kind: 'pass' });
  if (out.length === 0 && r.canPass) out.push({ kind: 'pass' });
  if (r.canChallenge) out.push({ kind: 'challenge' });
  return out;
}

/**
 * With stacking on a +2/+4 is kept to answer one, unless the next player is nearly out (a striker fires a little sooner),
 * has shown they can't answer it, my hand is nearly gone, or nothing else fits
 */
function held(v: RangSeatView, mem?: RangMemory, me?: RangPersonality): (c: RangCard) => boolean {
  const r = v.rang;
  if (!v.config.rangStack || r.penalty > 0 || r.hand.length <= 2) return () => false;
  const others = r.playable.filter((id) => {
    const c = r.hand.find((x) => x.id === id);
    return !!c && c.value !== 'draw2' && c.value !== 'wild4';
  });
  if (others.length === 0) return () => false;
  const next = seatAt(v, 1);
  const near = (me?.attack ?? 0) > 0.5 ? 3 : 2;
  if (!next || next.cardCount <= near) return () => false;
  const read = mem?.reads.get(next.id);
  const sure = !!read && read.fresh === 0;
  return (c) =>
    c.value === 'wild4' ? !(sure && read!.voidValues.has('wild4')) : c.value === 'draw2' && !(sure && read!.voidValues.has('draw2') && read!.voidValues.has('wild4'));
}

/** a move the rules always take: a matching card (a wild names the colour held most, a 7 swaps with the fewest cards), else pick, else pass */
export function fallback(v: RangSeatView): RangAction {
  const r = v.rang;
  if (r.playable.length > 0) {
    const cardId = r.playable[0];
    const card = r.hand.find((c) => c.id === cardId)!;
    if (isWild(card)) return { kind: 'play', cardId, color: longColor(r.hand, card, r.color) };
    const target = targets(v)[0];
    if (swaps(v, card) && target) return { kind: 'play', cardId, targetId: target.id };
    return { kind: 'play', cardId };
  }
  return r.canPick ? { kind: 'pick' } : { kind: 'pass' };
}

const shuffled = <T>(items: T[], rand: Rand): T[] => {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
};

const readSize = (r: OpponentRead | undefined) => (r ? r.voidColors.size + r.voidValues.size : 0);

/** cards I've seen go where they are: my hand, the pile as remembered, the top */
function seenIds(v: RangSeatView, mem: RangMemory): Set<string> {
  const top = v.rang.top;
  return new Set([...v.rang.hand.map((c) => c.id), ...mem.pile.map((c) => c.id), ...(top ? [top.id] : [])]);
}

/** cards an opponent surely holds (a hand that came from me), as far as still possible */
function knownOf(mem: RangMemory, id: string, seen: Set<string>, cardCount: number): RangCard[] {
  const r = mem.reads.get(id);
  return r ? r.known.filter((c) => !seen.has(c.id)).slice(0, cardCount) : [];
}

/** one guess at the hidden cards that fits everything public: card counts, the pile, hands that came from me, and what opponents surely lack */
export function sample(v: RangSeatView, mem: RangMemory, useReads: boolean, rand: Rand): RangState {
  const r = v.rang;
  const top = r.top;
  const seen = seenIds(v, mem);
  const hands = new Map<string, RangCard[]>(v.players.map((p) => [p.id, [] as RangCard[]]));
  hands.set(v.meId, [...r.hand]);
  // hands that came from me with a swap are known card for card
  for (const p of v.players) {
    if (p.id === v.meId || p.cardCount === 0) continue;
    for (const c of knownOf(mem, p.id, seen, p.cardCount)) {
      hands.get(p.id)!.push(c);
      seen.add(c.id);
    }
  }
  const pool = shuffled(
    buildRangDeck().filter((c) => !seen.has(c.id)),
    rand,
  );
  const used = new Array<boolean>(pool.length).fill(false);
  const take = (ok: (c: RangCard) => boolean): RangCard | null => {
    for (let i = 0; i < pool.length; i++) {
      if (!used[i] && ok(pool[i])) {
        used[i] = true;
        return pool[i];
      }
    }
    return null;
  };
  const plan = v.players
    .filter((p) => p.id !== v.meId && p.cardCount > 0)
    .map((p) => {
      const read = useReads ? mem.reads.get(p.id) : undefined;
      const held = hands.get(p.id)!.length;
      return { id: p.id, count: p.cardCount, r: read, sure: read ? Math.max(0, p.cardCount - read.fresh - held) : 0 };
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
  const deck = rest.slice(0, r.deckCount);
  // anything left over is pile we never saw
  const unseen = rest.slice(r.deckCount);
  const pile = [...mem.pile.filter((c) => c.id !== top?.id), ...unseen, ...(top ? [top] : [])];
  // an open +4 challenge: guilty or not by the guessed hand, never the real one
  const open = !!v.config.rangChallenge && r.penalty === 4 && top?.value === 'wild4' && !!r.topBy;
  const fourColor = mem.four && mem.four.by === r.topBy ? mem.four.color : null;
  const challengeable = open ? { by: r.topBy!, guilty: !!fourColor && (hands.get(r.topBy!) ?? []).some((c) => c.color === fourColor) } : null;
  return {
    order: v.players.map((p) => p.id),
    config: v.config,
    hands,
    deck,
    pile,
    turnId: v.turnId,
    penalty: r.penalty,
    picks: r.picks,
    picked: [...r.picked],
    called: new Set(r.called),
    missed: new Set(r.missed),
    atRisk: r.atRisk,
    over: false,
    places: [],
    color: r.color,
    dir: r.dir,
    topBy: r.topBy,
    challengeable,
  };
}

/** a player holding the colour plays a +4 anyway this often, before any of their challenges are seen */
const BLUFF_PRIOR = 0.12;
/** how many +4s that prior counts for next to what this player has shown */
const PRIOR_FOURS = 3;

/**
 * Chance the +4 on me was played while holding the colour in play, from public information only: the unseen cards,
 * their hand size, what they surely lacked (a recent forced pick against that colour) and how their past +4s turned out.
 */
export function guiltChance(v: RangSeatView, mem: RangMemory): number {
  const r = v.rang;
  const by = r.topBy;
  const color = mem.four && mem.four.by === by ? mem.four.color : null;
  if (!by || !color) return 0.2;
  const cardCount = v.players.find((p) => p.id === by)?.cardCount ?? 0;
  const seen = seenIds(v, mem);
  const known = knownOf(mem, by, seen, cardCount);
  if (known.some((c) => c.color === color)) return 1;
  known.forEach((c) => seen.add(c.id));
  const unknown = buildRangDeck().filter((c) => !seen.has(c.id));
  const f = unknown.length > 0 ? count(unknown, (c) => c.color === color) / unknown.length : 0;
  const read = mem.reads.get(by);
  const free = Math.max(0, cardCount - known.length);
  // after a forced pick against that colour only the cards picked since can hold it
  const open = read && read.voidColors.has(color) ? Math.min(read.fresh, free) : free;
  const held = 1 - (1 - f) ** open;
  // most players with the colour play it instead: weigh by how often this one bluffed a +4 before
  const record = mem.fours.get(by) ?? { guilty: 0, fair: 0 };
  const bluffs = (BLUFF_PRIOR * PRIOR_FOURS + record.guilty) / (PRIOR_FOURS + record.guilty + record.fair);
  return (held * bluffs) / (held * bluffs + (1 - held));
}

/** decisions in one playout before it's judged on hand sizes instead */
const DEPTH = 160;
/** a few samples even when the clock says stop, so a slow moment never means a blind guess */
const MIN_SAMPLES = 4;

/** a seat's neighbour still holding cards: step 1 is who plays next, -1 who played before */
function neighbour(g: RangGame, id: string, step: 1 | -1): string | null {
  const start = g.order.indexOf(id);
  const len = g.order.length;
  for (let k = 1; k < len; k++) {
    const p = g.order[(((start + k * step * g.dir) % len) + len) % len];
    if (g.hand(p).length > 0) return p;
  }
  return null;
}

/** the opponent with the fewest cards (ties: the next in turn order); 2v2 skips the partner */
function fewestIn(g: RangGame, id: string): string | null {
  const start = g.order.indexOf(id);
  const len = g.order.length;
  const partner = g.partnerOf(id);
  let best: string | null = null;
  for (let k = 1; k < len; k++) {
    const p = g.order[(((start + k * g.dir) % len) + len) % len];
    if (p !== partner && g.hand(p).length > 0 && (!best || g.hand(p).length < g.hand(best).length)) best = p;
  }
  return best;
}

/** a quick sensible move for any seat in a playout: keep your long colour alive, save wilds, hit a near-winner with action cards */
function quickCard(g: RangGame, id: string, legal: RangCard[], rand: Rand): RangCard {
  const hand = g.hand(id);
  const nextId = neighbour(g, id, 1);
  const next = nextId ? g.hand(nextId).length : 99;
  const duel = g.order.filter((p) => g.hand(p).length > 0).length === 2;
  const partnerNext = !!nextId && nextId === g.partnerOf(id);
  let best = legal[0];
  let bestScore = -Infinity;
  for (const c of legal) {
    let s = count(hand, (x) => x !== c && x.color !== null && x.color === c.color) + 0.5 * count(hand, (x) => x !== c && x.value === c.value);
    if (g.penalty > 0) s += 50;
    // a wild fits anything: keep it for when nothing else does, or the very end
    else if (c.value === 'wild') s = -3 + (hand.length <= 2 ? 6 : 0);
    else if (c.value === 'wild4') s = (next <= 2 ? 3 : -4) + (hand.length <= 2 ? 6 : 0);
    // with stacking on a +2 is kept to answer one, unless the next player is nearly out
    else if (c.value === 'draw2') s += next <= 2 ? 3 : g.config.rangStack && hand.length > 2 ? -4 : 1;
    else if (c.value === 'skip' || c.value === 'reverse') s += (next <= 2 ? 2.5 : 0.5) + (duel ? 1 : 0);
    else if (g.config.rangSwap && c.value === '7' && hand.length > 1) {
      const t = fewestIn(g, id);
      s += t ? hand.length - 1 - g.hand(t).length : 0;
    } else if (g.config.rangSwap && c.value === '0') {
      const prev = neighbour(g, id, -1);
      s += prev ? 0.8 * (hand.length - 1 - g.hand(prev).length) : 0;
    }
    // dump a doubles set while it's open
    if (g.config.rangDoubles && NUMBER_VALUES.includes(c.value)) s += 1.5 * (count(hand, (x) => x.value === c.value) - 1);
    if (partnerNext && g.penalty === 0 && hits(c)) s -= 6;
    s += rand() * 0.6;
    if (s > bestScore) {
      bestScore = s;
      best = c;
    }
  }
  return best;
}

/** plays a card (or doubles), saying "last card" with the second-last one (and straight after, if it's still owed); a wild names the colour held most, a 7 swaps with the fewest cards */
function playCard(g: RangGame, id: string, cardId: string, color?: RangColor, targetId?: string, extra?: string[]): void {
  if (g.hand(id).length === 2 && g.canCall(id)) g.call(id);
  const hand = g.hand(id);
  const card = hand.find((c) => c.id === cardId);
  const opts: { color?: RangColor; targetId?: string; extra?: string[] } = {};
  if (extra && extra.length > 0) opts.extra = extra;
  if (card && isWild(card)) opts.color = color ?? longColor(hand, card, g.color);
  if (card && g.config.rangSwap && card.value === '7' && hand.length > 1 + (extra?.length ?? 0)) opts.targetId = targetId ?? fewestIn(g, id) ?? undefined;
  g.play(id, cardId, opts);
  if (!g.over && g.hand(id).length === 1 && g.canCall(id)) g.call(id);
}

function apply(g: RangGame, id: string, a: RangAction): void {
  if (a.kind === 'play') playCard(g, id, a.cardId, a.color, a.targetId, a.extra);
  else if (a.kind === 'pick') {
    g.pick(id);
    // force play may have put the picked card down
    if (!g.over && g.atRisk === id && g.canCall(id)) g.call(id);
  }
  else if (a.kind === 'pass') g.pass(id);
  else g.challenge(id);
}

/** one seat's move in a playout; challenges go by the +4 player's hand size, never by what they really held */
function quickMove(g: RangGame, id: string, rand: Rand): void {
  if (g.canChallenge(id)) {
    const by = g.topBy ? g.hand(g.topBy).length : 0;
    if (rand() < (by >= 4 ? 0.35 : 0.15)) return void g.challenge(id);
  }
  const legal = g.playable(id);
  if (legal.length > 0) {
    const c = quickCard(g, id, legal, rand);
    const set = g.config.rangDoubles ? doublesPlay(g.hand(id), (x) => g.fits(x), c.value, g.top()) : null;
    return set ? playCard(g, id, set[0].id, undefined, undefined, set.slice(1).map((x) => x.id)) : playCard(g, id, c.id);
  }
  // keep looking for a card that fits for a pick or two, then stop
  if (g.canPass(id) && g.picks >= 2) return void g.pass(id);
  if (g.canPick(id)) return void apply(g, id, { kind: 'pick' });
  if (g.canPass(id)) return void g.pass(id);
  throw new Error('no move');
}

/** my rough chance from hand sizes when a playout runs long; 2v2 adds my partner's */
function estimate(g: RangGame, meId: string): number {
  const live = g.order.filter((id) => g.hand(id).length > 0);
  const total = live.reduce((sum, id) => sum + 1 / g.hand(id).length, 0);
  const share = (id: string) => (g.hand(id).length > 0 && total > 0 ? 1 / g.hand(id).length / total : 0);
  const partner = g.partnerOf(meId);
  return share(meId) + (partner ? share(partner) : 0);
}

/** plays one option out to the end on one guess of the hidden cards: 1 if I win; a loss counts a little more the closer I came */
export function playout(state: RangState, first: RangAction, meId: string, seed: number, depth = DEPTH): number {
  const rand = seededRand(seed);
  const g = RangGame.fromState(state, (max) => Math.floor(rand() * max));
  try {
    // anyone still able to say "last card" is assumed to say it in time
    if (g.atRisk && g.canCall(g.atRisk)) g.call(g.atRisk);
    apply(g, meId, first);
    for (let step = 0; step < depth && !g.over && g.turnId; step++) quickMove(g, g.turnId, rand);
  } catch {
    return 0.5;
  }
  if (!g.over) return estimate(g, meId);
  // 2v2: my partner going out is our win
  return g.winners().includes(meId) ? 1 : 0.1 / (1 + g.hand(meId).length);
}

/** the next opponent still holding cards (step 1), or the one before me (step -1), in the current direction */
function seatAt(v: RangSeatView, step: 1 | -1): { id: string; cardCount: number } | null {
  const i = v.players.findIndex((p) => p.id === v.meId);
  const len = v.players.length;
  for (let k = 1; k < len; k++) {
    const p = v.players[(((i + k * step * v.rang.dir) % len) + len) % len];
    if (p.cardCount > 0 && p.id !== v.meId) return p;
  }
  return null;
}

/** a quick judgement of each option from what this seat can see; the search starts from it and soon outweighs it */
export function priors(v: RangSeatView, mem: RangMemory, options: RangAction[]): number[] {
  const r = v.rang;
  const hand = r.hand;
  const seen = seenIds(v, mem);
  const unknown = buildRangDeck().filter((c) => !seen.has(c.id));
  const next = seatAt(v, 1);
  const prev = seatAt(v, -1);
  const k = next?.cardCount ?? 7;
  const read = next ? mem.reads.get(next.id) : undefined;
  const hasPlay = r.playable.length > 0;
  const duel = v.players.filter((p) => p.cardCount > 0).length === 2;
  const partnerNext = !!next && next.id === partnerIn(v);
  /** chance the next player holds nothing that answers this card (a wild: the colour it names) */
  const stuck = (c: RangCard, color: RangColor | null): number => {
    if (c.value === 'draw2' || c.value === 'wild4') {
      if (!v.config.rangStack) return 1;
      const answers = count(unknown, (x) => x.value === 'wild4' || (c.value === 'draw2' && x.value === 'draw2'));
      return unknown.length > 0 ? (1 - answers / unknown.length) ** k : 1;
    }
    const answers = count(unknown, (x) => isWild(x) || x.color === color || (!isWild(c) && x.value === c.value));
    // what they surely lack makes them likelier to be stuck
    const sure = !!read && read.fresh === 0 && !!color && read.voidColors.has(color) && read.voidValues.has('wild') && (isWild(c) || read.voidValues.has(c.value));
    const p = unknown.length > 0 ? (1 - answers / unknown.length) ** k : 0;
    return sure ? Math.max(p, 0.6) : p;
  };
  const raw = options.map((o) => {
    if (o.kind === 'pick') return r.penalty > 0 ? -2 : hasPlay ? -4 : 0.5;
    if (o.kind === 'pass') return hasPlay ? -3 : 0;
    if (o.kind === 'challenge') return 0;
    const c = hand.find((x) => x.id === o.cardId);
    if (!c) return -5;
    if (r.penalty > 0) return 5;
    // doubles: judged by the card left on top, plus the cards dumped
    const set = [c, ...(o.extra ?? []).map((x) => hand.find((y) => y.id === x)).filter((x): x is RangCard => !!x)];
    const top = set[set.length - 1];
    const color = isWild(c) ? (o.color ?? null) : top.color;
    let s =
      count(hand, (x) => !set.includes(x) && !!color && x.color === color) +
      0.4 * count(hand, (x) => !set.includes(x) && x.value === c.value) +
      3 * stuck(top, color) +
      1.5 * (set.length - 1);
    if (partnerNext && hits(c)) s -= 6;
    // wilds fit anything: save them unless the hand is nearly gone
    if (c.value === 'wild') s += hand.length <= 2 ? 1 : -4;
    else if (c.value === 'wild4') s += (k <= 2 ? 3 : -4) + (hand.length <= 2 ? 3 : 0);
    else if (c.value === 'draw2') s += k <= 2 ? 3 : 1;
    // a skip or reverse stops a near-winner, and with two players it's another turn
    else if (c.value === 'skip' || c.value === 'reverse') s += (k <= 2 ? 2.5 : 0.5) + (duel ? 1 : 0);
    else if (o.targetId) {
      // a 7 swap: trade my hand (less the 7) for a smaller one
      const t = v.players.find((p) => p.id === o.targetId);
      s += 1.2 * (hand.length - set.length - (t?.cardCount ?? hand.length));
    } else if (v.config.rangSwap && c.value === '0' && prev) s += 1.0 * (hand.length - set.length - prev.cardCount);
    return s;
  });
  const lo = Math.min(...raw);
  const hi = Math.max(...raw);
  return raw.map((x) => (hi > lo ? (x - lo) / (hi - lo) : 0.5));
}

/** style nudges, small next to what the search finds */
function lean(v: RangSeatView, me: RangPersonality, a: RangAction): number {
  if (a.kind !== 'play') return 0;
  const card = v.rang.hand.find((c) => c.id === a.cardId);
  const top = v.rang.top;
  if (!card) return 0;
  let b = 0;
  if ((card.value === 'draw2' || card.value === 'wild4') && v.rang.penalty === 0) b += me.attack * 0.03;
  if (isWild(card)) b += me.wilds * 0.02;
  if (top && !isWild(card) && card.value === top.value && card.color !== v.rang.color) b += me.switching * 0.02;
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
  view: RangSeatView;
  mem: RangMemory;
  me: RangPersonality;
  rand: Rand;
  /** overrides the personality's limits (tests) */
  budgetMs?: number;
  maxPlayouts?: number;
}

export interface Verdict {
  action: RangAction;
  /** each option with its estimated chance to win */
  scores: { action: RangAction; value: number }[];
  samples: number;
  /** when a +4 could be challenged: the estimated chance it was played holding the colour */
  guilt?: number;
}

/** the first judgement counts as this many played-out samples */
const PRIOR_WEIGHT = 20;
/** challenge a +4 above this chance of guilt: a wrong challenge costs 2 more cards, a right one swings 8 and keeps the turn */
const CHALLENGE_BAR = 0.5;

/** challenge the +4 on me? From public information, with the style's doubt and a little noise */
function challenges(t: Thinking, canStack: boolean): { yes: boolean; guilt: number } {
  const guilt = guiltChance(t.view, t.mem);
  // answering with my own +4 is often better than a coin-flip challenge
  const bar = CHALLENGE_BAR - 0.1 * t.me.doubt + (canStack ? 0.15 : 0) + (t.rand() - 0.5) * (0.06 + 0.15 * t.me.temper);
  return { yes: guilt > bar, guilt };
}

/** searches every option over many guesses of the hidden cards and keeps the one that wins most */
export function think(t: Thinking): Verdict {
  let options = candidates(t.view, t.mem, t.me);
  let guilt: number | undefined;
  if (options.some((o) => o.kind === 'challenge')) {
    const call = challenges(t, options.some((o) => o.kind === 'play'));
    guilt = call.guilt;
    if (call.yes) return { action: { kind: 'challenge' }, scores: [], samples: 0, guilt };
    options = options.filter((o) => o.kind !== 'challenge');
  }
  if (options.length === 0) return { action: fallback(t.view), scores: [], samples: 0, guilt };
  if (options.length === 1) return { action: options[0], scores: [{ action: options[0], value: 1 }], samples: 0, guilt };
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
  return { action, scores: options.map((o, i) => ({ action: o, value: est[i] })), samples: n, guilt };
}

export const decide = (t: Thinking): RangAction => think(t).action;
