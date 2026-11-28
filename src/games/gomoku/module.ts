import { GameError } from '../../game.js';
import type { GameEvent } from '../../models.js';
import type { AnnounceKind, GomokuMoveInput } from '../../types.js';
import type { GameModule } from '../module.js';
import { decide } from './brain.js';
import { GomokuGame, type GomokuTally } from './game.js';

/** a game:move payload's Five in a Row part: { type: 'place', at } */
export function parseGomokuMove(raw: unknown): GomokuMoveInput {
  const p = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  if (p.type !== 'place') throw new GameError('Invalid move');
  if (!Number.isInteger(p.at)) throw new GameError('Pick a point on the board');
  return { type: 'place', at: p.at as number };
}

function describe(g: GomokuGame, e: GameEvent, n: (id: string | null) => string): [AnnounceKind, string] | null {
  if (e.kind === 'gameOver') {
    if (g.aborted) return ['over', 'Game stopped, not enough players left. No coins moved'];
    if (g.closed) return ['over', 'Game over. Only bots are left playing'];
    if (g.draw) return ['over', 'The board is full. It’s a draw 🤝'];
    const won = g.winners();
    if (won.length === 0) return ['over', 'Game over'];
    return ['over', g.line ? `${n(won[0])} makes ${g.line.length} in a row and wins 🎉` : `Game over. ${n(won[0])} wins 🎉`];
  }
  return null;
}

export const gomokuModule: GameModule<GomokuGame> = {
  kind: 'gomoku',
  create: (order, config, rand, botIds) => new GomokuGame(order, config, rand, botIds),
  view: (g) => ({ kind: 'gomoku', gomoku: g.view() }),
  move(g, playerId, raw) {
    return g.place(playerId, parseGomokuMove(raw).at);
  },
  describe,
  // bots play through the driver's think pause
  auto: () => null,
  clock: () => null,
  botMove: (g, botId, level, rand) => decide(g, botId, level, rand),
  turnKey: (g) => `${g.stepSeq}|${g.turnId}`,
  inPlay: (g, id) => g.inPlay(id),
  tallies: (g, id) => ({ ...((g.stats.get(id)?.tallies as GomokuTally | undefined) ?? {}) }),
  missionCounts: () => ({}),
};
