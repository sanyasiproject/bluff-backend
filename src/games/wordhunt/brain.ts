import type { BotLevel } from '../../types.js';
import type { Solved } from './grid.js';

/** common words: SCOWL levels 10 and 20 (the most used English words, from public-domain frequency lists) */
export const COMMON_TIER = 2;

/**
 * a bot's pace (ms between words), the longest word it plays, the rarest tier it ever plays and how often a word
 * past the common tiers may come up (its weight next to a common word's)
 */
export const WORDHUNT_BOT = {
  normal: { gap: [6_000, 9_000], maxLen: 5, maxTier: 3, rare: 0.05 },
  hard: { gap: [4_500, 6_500], maxLen: 7, maxTier: 4, rare: 0.15 },
  expert: { gap: [3_000, 4_000], maxLen: 8, maxTier: 5, rare: 0.3 },
} as const;

/** the bot's next pause before a word (ms) */
export function botGap(level: BotLevel, r: () => number): number {
  const [lo, hi] = (WORDHUNT_BOT[level] ?? WORDHUNT_BOT.hard).gap;
  return lo + r() * (hi - lo);
}

/**
 * the words a bot will find this round, in order: a weighted shuffle of plausible words, mostly common ones
 * (Normal: short and common, Expert: longer, now and then a rarer word)
 */
export function botWords(words: Map<string, Solved>, level: BotLevel, r: () => number): string[] {
  const lv = WORDHUNT_BOT[level] ?? WORDHUNT_BOT.hard;
  const keyed: { w: string; k: number }[] = [];
  for (const [w, s] of words) {
    if (s.tier > lv.maxTier || w.length > lv.maxLen) continue;
    const common = s.tier <= COMMON_TIER ? (s.tier === 1 ? 1.5 : 1) : lv.rare ** (s.tier - COMMON_TIER);
    const weight = level === 'expert' ? common * (w.length >= 6 ? 1.3 : 1) : level === 'normal' ? common / w.length ** 2 : common / w.length;
    // a weighted random order: smaller keys come first
    keyed.push({ w, k: -Math.log(1 - r()) / weight });
  }
  return keyed.sort((a, b) => a.k - b.k).map((x) => x.w);
}
