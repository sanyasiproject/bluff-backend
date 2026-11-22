import type { Habits } from './models.js';
import { backsClaim, type Card, type Rank } from './types.js';

export const HABIT_KEYS = [
  'openPlays',
  'openLies',
  'openNone',
  'followPlays',
  'followLies',
  'pushes',
  'passNone',
  'passHeld',
  'lies',
  'lieCards',
  'finishPlays',
  'finishLies',
  'endTurns',
  'endFakes',
  'slotFirst',
  'fakeFirst',
  'slotMid',
  'fakeMid',
  'slotLast',
  'fakeLast',
  'heldHonest',
  'heldKept',
  'heldLies',
  'liesKept',
  'overPlays',
  'overLies',
  'botSeen',
  'botCalls',
  'botLieSeen',
  'botLieCalls',
] as const satisfies readonly (keyof Habits)[];

export const emptyHabits = (): Habits => Object.fromEntries(HABIT_KEYS.map((k) => [k, 0])) as unknown as Habits;

/** each saved game first shrinks the old totals by this much, so the last ~25 games carry most of the weight (old : new about 24 : 1) */
export const HABIT_DECAY = 0.96;
/** totals are scaled down once they hold more turns than this, so a long history (10k games) can't drown out recent play */
export const HABIT_TURN_LIMIT = 1000;
/** the turns a set of habits holds: every play and every pass */
const TURN_KEYS = ['openPlays', 'followPlays', 'pushes', 'passNone', 'passHeld'] as const;

/** old totals faded by HABIT_DECAY plus this game's counts, scaled to HABIT_TURN_LIMIT turns at most; ratios are kept */
export function mergeHabits(old: Partial<Habits> | null | undefined, game: Habits): Habits {
  const out = emptyHabits();
  for (const k of HABIT_KEYS) out[k] = Math.max(0, Number(old?.[k]) || 0) * HABIT_DECAY + game[k];
  const turns = TURN_KEYS.reduce((n, k) => n + out[k], 0);
  const scale = turns > HABIT_TURN_LIMIT ? HABIT_TURN_LIMIT / turns : 1;
  for (const k of HABIT_KEYS) out[k] = Math.round(out[k] * scale * 1000) / 1000;
  return out;
}

/** mergeHabits as one MongoDB update pipeline on users.habits, so games saved at the same time never overwrite each other */
export function habitsPipeline(game: Habits): Record<string, unknown>[] {
  const faded = (k: string) => ({ $add: [{ $multiply: [{ $max: [0, { $ifNull: [`$habits.${k}`, 0] }] }, HABIT_DECAY] }, game[k as keyof Habits]] });
  const turns = { $add: TURN_KEYS.map((k) => `$habits.${k}`) };
  const scale = { $cond: [{ $gt: [turns, HABIT_TURN_LIMIT] }, { $divide: [HABIT_TURN_LIMIT, turns] }, 1] };
  return [
    { $set: Object.fromEntries(HABIT_KEYS.map((k) => [`habits.${k}`, faded(k)])) },
    { $set: Object.fromEntries(HABIT_KEYS.map((k) => [`habits.${k}`, { $round: [{ $multiply: [`$habits.${k}`, scale] }, 3] }])) },
  ];
}

/** saved habits with zeros for counts an older account doesn't have yet; null when there are none */
export function habitsFrom(saved: Partial<Habits> | null | undefined): Habits | null {
  if (!saved) return null;
  const h = emptyHabits();
  for (const k of HABIT_KEYS) {
    const n = saved[k];
    if (typeof n === 'number' && Number.isFinite(n) && n > 0) h[k] = n;
  }
  return h;
}

/** where a play happened: it opened the round; cards already claimed this round; copies of a rank in the game */
export interface PlaySpot {
  opening: boolean;
  before: number;
  copies: number;
}

/** one play, with the true cards: hand is the hand before the play, cards in tap order */
export function notePlay(h: Habits, hand: Card[], cards: Card[], claim: Rank, { opening, before, copies }: PlaySpot, kismat: Rank | null = null): void {
  const n = cards.length;
  const real = cards.filter((c) => backsClaim(c, claim, kismat)).length;
  const fakes = n - real;
  const held = hand.filter((c) => backsClaim(c, claim, kismat)).length;
  // holding the rank: honest but keeping some back, or faking while the real ones wait for later
  if (fakes === 0 && held >= 2) {
    h.heldHonest++;
    if (real < held) h.heldKept++;
  } else if (fakes > 0 && held >= 1) {
    h.heldLies++;
    if (real < held) h.liesKept++;
  }
  // the round's claims went past the copies with this play: a lie, or real cards springing a trap?
  if (before > 0 && n <= copies && before + n > copies) {
    h.overPlays++;
    if (fakes > 0) h.overLies++;
  }
  if (opening) {
    h.openPlays++;
    if (fakes > 0) h.openLies++;
    if (held === 0) h.openNone++;
  } else if (held > 0) {
    h.followPlays++;
    if (fakes > 0) h.followLies++;
  } else {
    h.pushes++;
  }
  if (fakes > 0) {
    h.lies++;
    h.lieCards += fakes;
  }
  if (n === hand.length) {
    h.finishPlays++;
    if (fakes > 0) h.finishLies++;
  }
  // a small hand that can't go out honestly: do they fake the rest to finish?
  if (hand.length <= END_HAND && !canFinishHonestly(hand, opening ? null : claim, kismat)) {
    h.endTurns++;
    if (n === hand.length) h.endFakes++;
  }
  // only plays with real and fake cards together say where someone hides fakes
  if (n < 2 || fakes === 0 || real === 0) return;
  cards.forEach((c, i) => {
    const fake = backsClaim(c, claim, kismat) ? 0 : 1;
    if (i === 0) {
      h.slotFirst++;
      h.fakeFirst += fake;
    } else if (i === n - 1) {
      h.slotLast++;
      h.fakeLast += fake;
    } else {
      h.slotMid++;
      h.fakeMid += fake;
    }
  });
}

/** a bot's play this person had their chance to call (it stood, or they called it; not its last cards), and whether it hid a fake */
export function noteBotPlay(h: Habits, lie: boolean): void {
  h.botSeen++;
  if (lie) h.botLieSeen++;
}

/** this person called a bot's play (not its last cards) */
export function noteBotCall(h: Habits, lie: boolean): void {
  h.botCalls++;
  if (lie) h.botLieCalls++;
}

/** a pass while a round is on: holding its rank or not */
export function notePass(h: Habits, hand: Card[], rank: Rank, kismat: Rank | null = null): void {
  if (hand.some((c) => backsClaim(c, rank, kismat))) h.passHeld++;
  else h.passNone++;
  if (hand.length <= END_HAND && !canFinishHonestly(hand, rank, kismat)) h.endTurns++;
}

/** hands this small count for "fakes the rest to finish" */
const END_HAND = 3;

/** the whole hand can go down as the truth: all of the round's rank, or (opening, rank null) all one rank */
function canFinishHonestly(hand: Card[], rank: Rank | null, kismat: Rank | null): boolean {
  // opening: any one rank, with the Kismat cards backing it up
  const r = rank ?? hand.find((c) => c.rank !== kismat)?.rank ?? hand[0]?.rank;
  return hand.length > 0 && r !== undefined && hand.every((c) => backsClaim(c, r, kismat));
}
