import type { Habits } from '../models.js';
import { PLUGGED_GAMES, type LifetimeStats } from '../types.js';
import { skillOf } from './levels.js';
import type { BotMemory } from './memory.js';
import type { Policy, Read } from './models.js';

/** how an average person plays, before knowing anything about them */
export const PRIOR: Omit<Policy, 'known'> = {
  pad: 0.2,
  push: 0.4,
  hold: 0.08,
  openPad: 0.22,
  openNone: 0.05,
  finish: 0.55,
  sandbag: 0.15,
  holdBack: 0.3,
  size: 1.5,
  spots: [0.3, 0.3, 0.45],
  over: 0.75,
};

/** share of plays that are lies for an average person (lifetime stats count every lie, caught or not) */
const PRIOR_LIES = 0.22;
/** a lifetime of habits counts as at most this many turns, so a player who changes is noticed */
const CAP = 150;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

type Evidence = [hits: number, tries: number, weight: number];

/** a chance from a prior and counts (each capped and weighted) */
function blend(prior: number, strength: number, evidence: Evidence[]): number {
  let a = prior * strength;
  let n = strength;
  for (const [hits, tries, weight] of evidence) {
    if (tries <= 0 || weight <= 0) continue;
    const scale = (Math.min(tries, CAP) / tries) * weight;
    a += Math.max(0, Math.min(hits, tries)) * scale;
    n += tries * scale;
  }
  return n > 0 ? a / n : prior;
}

/** lifetime lie rate against the average, for accounts that have no saved habits yet */
function lieLean(life: LifetimeStats | null | undefined): number {
  if (!life) return 1;
  // registry games (Ludo and after) aren't Bluff either
  const plugged = PLUGGED_GAMES.reduce((n, k) => n + (life.perGame?.[k]?.played ?? 0), 0);
  const games = life.gamesPlayed - (life.crazy7Games ?? 0) - (life.rangGames ?? 0) - plugged;
  if (games <= 0 || life.plays <= 0) return 1;
  const rate = (life.bluffs + PRIOR_LIES * 20) / (life.plays + 20);
  return clamp(rate / PRIOR_LIES, 0.3, 3.5);
}

/** what a bot can know about a player's habits: saved ones (when its level reads them) */
function habitsFor(mem: BotMemory, id: string, weight: number): Habits | null {
  return weight > 0 ? (mem.habits?.get(id) ?? null) : null;
}

/** how a player tends to play: saved habits from past games, what this bot saw at the table (only public things), and priors */
export function policyOf(
  mem: Pick<BotMemory, 'reads' | 'lifetime'> & Partial<Pick<BotMemory, 'habits'>>,
  id: string,
  bot: boolean,
  level?: Parameters<typeof skillOf>[0],
): Policy {
  const skill = skillOf(level);
  const w = skill.habits;
  const h = habitsFor(mem as BotMemory, id, w);
  const r: Read | undefined = mem.reads.get(id);
  // no saved habits yet: lean the priors on their lifetime lie rate
  const lean = h ? 1 : lieLean(mem.lifetime?.get(id));
  // how its reads of them did here: fakes found against fakes expected, on every card turned over (calls are picky, so raw counts would run high)
  const fix = clamp(((r?.found ?? 0) + 1.5) / ((r?.expected ?? 0) + 1.5), 0.25, 10);
  const tune = (p: number) => (fix * p) / (1 - p + fix * p);

  const pad = blend(clamp(PRIOR.pad * lean, 0.02, 0.9), 4, [[h?.followLies ?? 0, h?.followPlays ?? 0, w]]);
  const openPad = blend(clamp(PRIOR.openPad * lean, 0.02, 0.9), 4, [[(h?.openLies ?? 0) - (h?.openNone ?? 0), (h?.openPlays ?? 0) - (h?.openNone ?? 0), w]]);
  const openNone = blend(clamp(PRIOR.openNone * lean, 0.005, 0.6), 12, [[h?.openNone ?? 0, h?.openPlays ?? 0, w]]);
  // turns they likely had none of the rank (by the odds) and still didn't pass
  const lack = r?.lack ?? 0;
  const push = blend(clamp(PRIOR.push * Math.sqrt(lean), 0.05, 0.95), 5, [
    [h?.pushes ?? 0, (h?.pushes ?? 0) + (h?.passNone ?? 0), w],
    [Math.max(0, lack - (r?.passes ?? 0)), lack, 0.8],
  ]);
  const hold = blend(PRIOR.hold, 10, [[h?.passHeld ?? 0, (h?.passHeld ?? 0) + (h?.followPlays ?? 0), w]]);
  const finish = blend(clamp(PRIOR.finish * Math.sqrt(lean), 0.05, 0.95), 4, [[h?.endFakes ?? 0, h?.endTurns ?? 0, w]]);
  const lies = Math.min(h?.lies ?? 0, CAP);
  const scale = h && h.lies > 0 ? lies / h.lies : 0;
  const size = Math.max(1, (PRIOR.size * 3 + (h?.lieCards ?? 0) * scale * w) / (3 + lies * w));
  // keeping real cards back: honest plays that hold some, and lies that keep the real ones for later (the fake-then-real trap)
  const sandbag = blend(PRIOR.sandbag, 6, [[h?.heldKept ?? 0, h?.heldHonest ?? 0, w]]);
  // a trap sprung on this bot counts heavily: fooled once, it remembers
  const holdBack = blend(PRIOR.holdBack, 6, [
    [h?.liesKept ?? 0, h?.heldLies ?? 0, w],
    [r?.keptLies ?? 0, r?.keptLies ?? 0, 3],
  ]);
  // their claims that took a round past the copies: lies, or real cards springing a trap (saved, and called ones seen here)
  const over = blend(PRIOR.over, 4, [
    [h?.overLies ?? 0, h?.overPlays ?? 0, w],
    [r?.overCaught ?? 0, (r?.overCaught ?? 0) + (r?.overHonest ?? 0), 3],
  ]);

  // bots shuffle their cards, so where a card sits says nothing
  const spots: [number, number, number] = bot
    ? [0.5, 0.5, 0.5]
    : [
        blend(PRIOR.spots[0], 3, [[h?.fakeFirst ?? 0, h?.slotFirst ?? 0, w], [r?.firstFound ?? 0, r?.firstTried ?? 0, 1]]),
        blend(PRIOR.spots[1], 3, [[h?.fakeMid ?? 0, h?.slotMid ?? 0, w], [r?.midFound ?? 0, r?.midTried ?? 0, 1]]),
        blend(PRIOR.spots[2], 3, [[h?.fakeLast ?? 0, h?.slotLast ?? 0, w], [r?.lastFound ?? 0, r?.lastTried ?? 0, 1]]),
      ];

  // every turn in their saved habits, plus what it saw here (a called play teaches more than a turn watched)
  const turns = (h ? (h.followPlays + h.openPlays + h.pushes + h.passNone) * w : 0) + (r ? 4 * r.expected + lack : 0);
  return {
    pad: clamp(tune(pad), 0.01, 0.97),
    push: clamp(tune(push), 0.02, 0.98),
    hold: clamp(hold, 0.01, 0.6),
    openPad: clamp(tune(openPad), 0.01, 0.97),
    openNone: clamp(tune(openNone), 0.002, 0.8),
    finish: clamp(tune(finish), 0.03, 0.98),
    sandbag: clamp(sandbag, 0.02, 0.9),
    holdBack: clamp(holdBack, 0.03, 0.97),
    size: clamp(size, 1, 8),
    spots,
    over: clamp(over, 0.03, 0.98),
    known: clamp(turns / 40, 0, 1),
  };
}

/** how a person treats bots' plays, from saved habits: how often they call one, one that hides a fake, and one that doesn't (null until enough is saved) */
export function botCallsOf(
  mem: Partial<Pick<BotMemory, 'habits'>>,
  id: string,
  level?: Parameters<typeof skillOf>[0],
): { rate: number; lie: number; truth: number; seen: number } | null {
  const w = skillOf(level).habits;
  const h = habitsFor(mem as BotMemory, id, w);
  if (!h || h.botSeen < 8) return null;
  const rate = blend(0.12, 10, [[h.botCalls, h.botSeen, w]]);
  // a person who reads bots well calls their lies far more often than their truths
  const lie = blend(rate, 6, [[h.botLieCalls, h.botLieSeen, w]]);
  const truth = blend(rate, 6, [[h.botCalls - h.botLieCalls, h.botSeen - h.botLieSeen, w]]);
  return { rate, lie, truth, seen: Math.min(h.botSeen, CAP) * w };
}
