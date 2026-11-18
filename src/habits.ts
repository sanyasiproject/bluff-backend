import type { Habits } from './models.js';
import type { Card, Rank } from './types.js';

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
export function notePlay(h: Habits, hand: Card[], cards: Card[], claim: Rank, { opening, before, copies }: PlaySpot): void {
  const n = cards.length;
  const real = cards.filter((c) => c.rank === claim).length;
  const fakes = n - real;
  const held = hand.filter((c) => c.rank === claim).length;
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
  if (hand.length <= END_HAND && !canFinishHonestly(hand, opening ? null : claim)) {
    h.endTurns++;
    if (n === hand.length) h.endFakes++;
  }
  // only plays with real and fake cards together say where someone hides fakes
  if (n < 2 || fakes === 0 || real === 0) return;
  cards.forEach((c, i) => {
    const fake = c.rank !== claim ? 1 : 0;
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
export function notePass(h: Habits, hand: Card[], rank: Rank): void {
  if (hand.some((c) => c.rank === rank)) h.passHeld++;
  else h.passNone++;
  if (hand.length <= END_HAND && !canFinishHonestly(hand, rank)) h.endTurns++;
}

/** hands this small count for "fakes the rest to finish" */
const END_HAND = 3;

/** the whole hand can go down as the truth: all of the round's rank, or (opening, rank null) all one rank */
function canFinishHonestly(hand: Card[], rank: Rank | null): boolean {
  const r = rank ?? hand[0]?.rank;
  return hand.length > 0 && hand.every((c) => c.rank === r);
}
