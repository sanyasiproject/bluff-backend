import type { PlayerStats } from './models.js';
import type { Award, GameKind } from './types.js';

interface AwardRule {
  emoji: string;
  title: string;
  score: (s: PlayerStats) => number;
  detail: (n: number) => string;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

const RULES: AwardRule[] = [
  { emoji: '🤥', title: 'Biggest liar', score: (s) => s.bluffs, detail: (n) => plural(n, 'bluff') },
  { emoji: '😎', title: 'Smoothest liar', score: (s) => s.bluffs - s.caught, detail: (n) => `${plural(n, 'bluff')} never caught` },
  { emoji: '🕵️', title: 'Best detective', score: (s) => s.goodCalls, detail: (n) => `caught ${plural(n, 'bluff')}` },
  { emoji: '🙈', title: 'Trust issues', score: (s) => s.wrongCalls, detail: (n) => plural(n, 'wrong call') },
  { emoji: '🧲', title: 'Card collector', score: (s) => s.pickedUp, detail: (n) => `picked up ${plural(n, 'card')}` },
];

const CRAZY7_RULES: AwardRule[] = [
  { emoji: '🎯', title: 'Sevens master', score: (s) => s.sevens ?? 0, detail: (n) => `played ${plural(n, 'seven')}` },
  { emoji: '🧲', title: 'Card collector', score: (s) => s.picks ?? 0, detail: (n) => `picked up ${plural(n, 'card')}` },
  { emoji: '🙊', title: 'Forgot to call', score: (s) => s.missedCalls ?? 0, detail: (n) => `missed last card ${plural(n, 'time')}` },
];

/** highest score wins each award and ties share it; awards nobody earned are left out */
export function computeAwards(stats: Map<string, PlayerStats>, game: GameKind = 'bluff'): Award[] {
  return (game === 'crazy7' ? CRAZY7_RULES : RULES).flatMap((rule) => {
    const scored = [...stats].map(([id, s]) => ({ id, n: rule.score(s) }));
    const best = Math.max(0, ...scored.map((x) => x.n));
    if (best === 0) return [];
    return [{ emoji: rule.emoji, title: rule.title, playerIds: scored.filter((x) => x.n === best).map((x) => x.id), detail: rule.detail(best) }];
  });
}
