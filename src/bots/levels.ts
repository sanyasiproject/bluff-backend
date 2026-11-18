import type { BotLevel } from '../types.js';

/** what a bot level changes: how sharp its reads are, how steady its choices are and how many tricks it plays; its style only flavours them */
export interface Skill {
  level: BotLevel;
  /** weight it gives a player's saved habits (0 ignores them) */
  habits: number;
  /** how reliably it uses what it remembers about cards (1 = always) */
  memory: number;
  /** wobble on its peeks, as a share of what's at stake (higher = sloppier) */
  noise: number;
  /** how far its style's leanings move its choices (1 = fully) */
  style: number;
  /** chance it calls a claim its own cards prove false (under "show all") */
  sureCall: number;
  /** peeks only when a look could change the call, at the likeliest fake; otherwise on a whim at a random card */
  smartPeek: boolean;
  /** under "pick one": chance it turns over the likeliest fake rather than any card */
  aim: number;
  /** its own lies: how much it counts on an opponent holding enough copies to prove a claim false (0 never thinks of it, 1 always) */
  provable: number;
  /** fake cards it will add to empty its hand and finish */
  finishFakes: number;
  /** how loose its own choices are (multiplies its style's randomness) */
  loose: number;
  /** weighs which claim of a round was the lie: an earlier claim it believed may have been the fake one (beats the fake-then-real trap) */
  joint: boolean;
  /** how mixed its calls are near the line, as a share of what's at stake: nobody can find the exact point where it stops calling */
  callTemp: number;
  /** chance it tests a plausible claim while the pile is small */
  audit: number;
  /** how often it plays tricks: real cards held back, a pass while holding the rank, fakes now and the real ones later (0..1) */
  tricks: number;
  /** fakes from the cards hardest to get rid of honestly, and a clean last play kept ready */
  junk: boolean;
  /** how far its plan for the next few rounds wanders from its style (0..1) */
  swing: number;
}

export const SKILLS: Record<BotLevel, Skill> = {
  normal: {
    level: 'normal', habits: 0, memory: 0.55, noise: 0.32, style: 1, sureCall: 0.9, smartPeek: false, aim: 0.6, provable: 0.5, finishFakes: 1, loose: 1.15,
    joint: false, callTemp: 0.2, audit: 0.03, tricks: 0.4, junk: false, swing: 0.6,
  },
  hard: {
    level: 'hard', habits: 0.6, memory: 0.85, noise: 0.14, style: 0.6, sureCall: 0.98, smartPeek: true, aim: 0.85, provable: 1, finishFakes: 2, loose: 0.8,
    joint: true, callTemp: 0.1, audit: 0.05, tricks: 0.75, junk: true, swing: 0.85,
  },
  expert: {
    level: 'expert', habits: 1, memory: 1, noise: 0.05, style: 0.3, sureCall: 1, smartPeek: true, aim: 1, provable: 1, finishFakes: 3, loose: 0.6,
    joint: true, callTemp: 0.075, audit: 0.06, tricks: 1, junk: true, swing: 1,
  },
};

/** older rooms and tests don't name a level: the strongest bots */
export const skillOf = (level: BotLevel | undefined | null): Skill => SKILLS[level ?? 'expert'] ?? SKILLS.expert;
