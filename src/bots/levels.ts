import type { BotLevel } from '../types.js';

/** what a bot level changes: how sharp its reads are and how steady its choices are; its style only flavours them */
export interface Skill {
  level: BotLevel;
  /** weight it gives a player's saved habits (0 ignores them) */
  habits: number;
  /** how reliably it uses what it remembers about cards (1 = always) */
  memory: number;
  /** wobble on its calls, as a share of what's at stake (higher = sloppier) */
  noise: number;
  /** how far its style's leanings move its calls (1 = fully) */
  style: number;
  /** chance it calls a claim its own cards prove false (under "show all") */
  sureCall: number;
  /** peeks only when a look could change the call, at the likeliest fake; otherwise on a whim at a random card */
  smartPeek: boolean;
  /** under "pick one": chance it turns over the likeliest fake rather than any card */
  aim: number;
  /** its own lies: knows an opponent may hold enough copies to prove a claim false */
  provable: boolean;
  /** fake cards it will add to empty its hand and finish */
  finishFakes: number;
  /** how loose its own choices are (multiplies its style's randomness) */
  loose: number;
}

export const SKILLS: Record<BotLevel, Skill> = {
  normal: { level: 'normal', habits: 0, memory: 0.55, noise: 0.32, style: 1, sureCall: 0.9, smartPeek: false, aim: 0.6, provable: false, finishFakes: 1, loose: 1 },
  hard: { level: 'hard', habits: 0.6, memory: 0.85, noise: 0.14, style: 0.6, sureCall: 0.98, smartPeek: true, aim: 0.85, provable: true, finishFakes: 2, loose: 0.8 },
  expert: { level: 'expert', habits: 1, memory: 1, noise: 0.05, style: 0.3, sureCall: 1, smartPeek: true, aim: 1, provable: true, finishFakes: 3, loose: 0.6 },
};

/** older rooms and tests don't name a level: the strongest bots */
export const skillOf = (level: BotLevel | undefined | null): Skill => SKILLS[level ?? 'expert'] ?? SKILLS.expert;
