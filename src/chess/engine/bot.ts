// Bot levels 1-8: depth/time caps plus a chance of picking among the top moves.
import type { Move, Position } from '../position.js';
import { searchBoard, toPublicMove, type PvLine } from './search.js';
import { MATE } from './tt.js';

export type BotLevel = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

export interface BotLevelInfo { level: BotLevel; rating: number; depth: number; ms: number; topN: number; margin: number; blunder: number }

/** Approximate strength and limits per level (rating is a rough Lichess-style guide). */
export const BOT_LEVELS: readonly BotLevelInfo[] = [
  { level: 1, rating: 800, depth: 1, ms: 60, topN: 6, margin: 450, blunder: 0.22 },
  { level: 2, rating: 1000, depth: 2, ms: 100, topN: 5, margin: 300, blunder: 0.12 },
  { level: 3, rating: 1200, depth: 3, ms: 150, topN: 4, margin: 180, blunder: 0.06 },
  { level: 4, rating: 1400, depth: 4, ms: 250, topN: 3, margin: 100, blunder: 0.03 },
  { level: 5, rating: 1600, depth: 6, ms: 400, topN: 3, margin: 50, blunder: 0.01 },
  { level: 6, rating: 1800, depth: 8, ms: 600, topN: 2, margin: 20, blunder: 0 },
  { level: 7, rating: 2000, depth: 12, ms: 1000, topN: 1, margin: 0, blunder: 0 },
  { level: 8, rating: 2200, depth: 64, ms: 1600, topN: 1, margin: 0, blunder: 0 },
];

export interface BotClock { clockMs?: number; incMs?: number; maxMs?: number; maxNodes?: number }

/** Think-time cap for a timed game: at most 1/30 of the clock plus most of the increment. */
export function botThinkMs(level: BotLevel, clock?: BotClock): number {
  let ms = BOT_LEVELS[level - 1].ms;
  if (clock?.maxMs !== undefined) ms = Math.min(ms, clock.maxMs);
  if (clock?.clockMs !== undefined) {
    const inc = clock.incMs ?? 0;
    const cap = clock.clockMs / 30 + inc * 0.8;
    ms = Math.min(ms, cap);
    if (clock.clockMs < 3000) ms = Math.min(ms, Math.max(5, clock.clockMs / 60 + inc * 0.5));
  }
  return Math.max(5, Math.floor(ms));
}

const val = (l: PvLine): number => (l.mate !== undefined ? (l.mate > 0 ? MATE - l.mate : -MATE - l.mate) : l.scoreCp ?? 0);

export function botMove(pos: Position, history: readonly string[], level: BotLevel, rand: () => number, clock?: BotClock): Move {
  const cfg = BOT_LEVELS[Math.max(1, Math.min(8, level)) - 1];
  const legal = pos.legalCodes();
  if (!legal.length) throw new Error('no legal moves');
  if (legal.length === 1) return toPublicMove(legal[0]);
  if (cfg.blunder && rand() < cfg.blunder) return toPublicMove(legal[Math.floor(rand() * legal.length)]);
  const ms = botThinkMs(level, clock);
  const { lines } = searchBoard(pos.raw(), history, { maxDepth: cfg.depth, maxMs: ms, multiPv: cfg.topN, nodes: clock?.maxNodes });
  if (!lines.length) return toPublicMove(legal[0]);
  const top = val(lines[0]);
  // Never throw away a forced mate the bot has seen.
  if (lines[0].mate !== undefined && lines[0].mate > 0 && level >= 3) return lines[0].moves[0];
  const pool = lines.filter((l) => l.moves.length && top - val(l) <= cfg.margin);
  if (pool.length <= 1) return lines[0].moves[0];
  const weights = pool.map((l) => Math.exp(-(top - val(l)) / Math.max(30, cfg.margin / 2)));
  let r = rand() * weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < pool.length; i++) {
    r -= weights[i];
    if (r <= 0) return pool[i].moves[0];
  }
  return pool[0].moves[0];
}
