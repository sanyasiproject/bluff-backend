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

const RANG_RULES: AwardRule[] = [
  { emoji: '➕', title: 'Stack attack', score: (s) => s.stacks ?? 0, detail: (n) => `answered ${plural(n, 'draw card')} with their own` },
  { emoji: '🧲', title: 'Card collector', score: (s) => s.picks ?? 0, detail: (n) => `picked up ${plural(n, 'card')}` },
  { emoji: '🙊', title: 'Forgot to call', score: (s) => s.missedCalls ?? 0, detail: (n) => `missed last card ${plural(n, 'time')}` },
];

const CRAZY7_RULES: AwardRule[] = [
  { emoji: '🎯', title: 'Sevens master', score: (s) => s.sevens ?? 0, detail: (n) => `played ${plural(n, 'seven')}` },
  { emoji: '🧲', title: 'Card collector', score: (s) => s.picks ?? 0, detail: (n) => `picked up ${plural(n, 'card')}` },
  { emoji: '🙊', title: 'Forgot to call', score: (s) => s.missedCalls ?? 0, detail: (n) => `missed last card ${plural(n, 'time')}` },
];

const LUDO_RULES: AwardRule[] = [
  { emoji: '💥', title: 'Goti hunter', score: (s) => s.tallies?.kills ?? 0, detail: (n) => `knocked off ${plural(n, 'goti')}` },
  { emoji: '🎲', title: 'Lucky sixes', score: (s) => s.tallies?.sixes ?? 0, detail: (n) => `rolled ${n} ${n === 1 ? 'six' : 'sixes'}` },
];

const SNAKES_RULES: AwardRule[] = [
  { emoji: '🪜', title: 'Ladder climber', score: (s) => s.tallies?.ladders ?? 0, detail: (n) => `climbed ${plural(n, 'ladder')}` },
  { emoji: '🐍', title: 'Snake food', score: (s) => s.tallies?.snakes ?? 0, detail: (n) => `slid down ${plural(n, 'snake')}` },
];

const RMCS_RULES: AwardRule[] = [
  { emoji: '🧐', title: 'Sharp Mantri', score: (s) => s.tallies?.caught ?? 0, detail: (n) => `caught the Chor ${plural(n, 'time')}` },
  { emoji: '🦹', title: 'Master Chor', score: (s) => s.tallies?.escaped ?? 0, detail: (n) => `got away ${plural(n, 'time')}` },
];

const DARTS_RULES: AwardRule[] = [
  { emoji: '🎯', title: 'Maximum!', score: (s) => s.tallies?.t180 ?? 0, detail: (n) => `threw ${n} × 180` },
  { emoji: '🐂', title: 'Bull hunter', score: (s) => s.tallies?.bulls ?? 0, detail: (n) => `hit ${plural(n, 'bullseye')}` },
];

const DOTS_RULES: AwardRule[] = [{ emoji: '📦', title: 'Box collector', score: (s) => s.tallies?.boxes ?? 0, detail: (n) => `closed ${n} ${n === 1 ? 'box' : 'boxes'}` }];

const COLORWAR_RULES: AwardRule[] = [
  { emoji: '🎨', title: 'Colour thief', score: (s) => s.tallies?.captures ?? 0, detail: (n) => `took ${plural(n, 'cell')}` },
  { emoji: '💥', title: 'Chain reactor', score: (s) => s.tallies?.bursts ?? 0, detail: (n) => plural(n, 'burst') },
];

/** registry games' awards by kind (a new game adds a line) */
const GAME_RULES: Partial<Record<GameKind, AwardRule[]>> = { darts: DARTS_RULES, dots: DOTS_RULES, colorwar: COLORWAR_RULES };

/** highest score wins each award and ties share it; awards nobody earned are left out */
export function computeAwards(stats: Map<string, PlayerStats>, game: GameKind = 'bluff'): Award[] {
  return (game === 'crazy7' ? CRAZY7_RULES : game === 'rang' ? RANG_RULES : game === 'ludo' ? LUDO_RULES : game === 'snakes' ? SNAKES_RULES : game === 'rmcs' ? RMCS_RULES : GAME_RULES[game] ?? RULES).flatMap((rule) => {
    const scored = [...stats].map(([id, s]) => ({ id, n: rule.score(s) }));
    const best = Math.max(0, ...scored.map((x) => x.n));
    if (best === 0) return [];
    return [{ emoji: rule.emoji, title: rule.title, playerIds: scored.filter((x) => x.n === best).map((x) => x.id), detail: rule.detail(best) }];
  });
}
