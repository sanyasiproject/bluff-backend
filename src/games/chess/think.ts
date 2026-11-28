import { botMove } from '../../chess/engine/index.js';
import { ChessGame } from '../../chess/game.js';
import type { ChessVariant } from '../../types.js';
import { seeded } from './budget.js';

/** one bot think: the game so far, the level and its time budget */
export interface ThinkJob {
  variant: ChessVariant;
  initialFen: string;
  /** UCI moves so far */
  moves: string[];
  level: number;
  /** the most this think may take */
  maxMs: number;
  /** seeds the bot's random choices */
  seed: number;
}

/** the bot's move in UCI (runs in a worker thread) */
export function thinkMove(job: ThinkJob): string {
  const game = ChessGame.fromUci(job.variant, job.initialFen, job.moves);
  const pos = game.position();
  const level = Math.min(Math.max(Math.round(job.level), 1), 8) as 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
  const move = botMove(pos, game.keys(), level, seeded(job.seed), { maxMs: job.maxMs });
  return pos.uci(move);
}
