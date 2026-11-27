import { GameError } from '../../game.js';
import type { GameEvent } from '../../models.js';
import type { AnnounceKind, DotsMoveInput } from '../../types.js';
import type { GameModule } from '../module.js';
import { decide } from './brain.js';
import { DotsGame, type DotsTally } from './game.js';

/** a game:move payload's Dots and Boxes part: { type: 'line', line } (numbered as in dotsLineAt) */
export function parseDotsMove(raw: unknown): DotsMoveInput {
  const p = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  if (p.type !== 'line') throw new GameError('Invalid move');
  if (!Number.isInteger(p.line)) throw new GameError('Pick a line between two dots');
  return { type: 'line', line: p.line as number };
}

const boxes = (k: number) => `${k} ${k === 1 ? 'box' : 'boxes'}`;

function describe(g: DotsGame, e: GameEvent, n: (id: string | null) => string): [AnnounceKind, string] | null {
  if (e.kind === 'gameOver') {
    if (g.aborted) return ['over', 'Game stopped, not enough players left. No coins moved'];
    const won = g.winners();
    if (g.closed && won.length === 0) return ['over', 'Game over. Only bots are left playing'];
    if (won.length === 0) return ['over', 'Game over'];
    const k = g.scores.get(won[0]) ?? 0;
    return ['over', won.length > 1 ? `Game over. ${won.map(n).join(' and ')} share first with ${boxes(k)} 🎉` : `Game over. ${n(won[0])} wins with ${boxes(k)} 🎉`];
  }
  if (e.kind !== 'dots') return null;
  // one line closing two boxes at once
  if (e.ev.closed.length === 2 && !g.over) return ['round', `Double! ${n(e.ev.playerId)} closed two boxes with one line ✌️`];
  return null;
}

export const dotsModule: GameModule<DotsGame> = {
  kind: 'dots',
  create: (order, config, rand, botIds) => new DotsGame(order, config, rand, botIds),
  view: (g) => ({ kind: 'dots', dots: g.view() }),
  move(g, playerId, raw) {
    return g.draw(playerId, parseDotsMove(raw).line);
  },
  describe,
  // bots play through the driver's think pause
  auto: () => null,
  clock: () => null,
  botMove: (g, botId, level, rand) => decide(g, botId, level, rand),
  turnKey: (g) => `${g.stepSeq}|${g.turnId}`,
  inPlay: (g, id) => g.inPlay(id),
  tallies: (g, id) => ({ ...((g.stats.get(id)?.tallies as DotsTally | undefined) ?? {}) }),
  missionCounts: () => ({}),
};
