import { GameError } from '../../game.js';
import type { GameEvent } from '../../models.js';
import type { AnnounceKind, UtttMoveInput } from '../../types.js';
import type { GameModule } from '../module.js';
import { decide } from './brain.js';
import { UtttGame, type UtttTally } from './game.js';

/** a game:move payload's Ultimate Tic-Tac-Toe part: { type: 'place', board, cell } */
export function parseUtttMove(raw: unknown): UtttMoveInput {
  const p = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  if (p.type !== 'place') throw new GameError('Invalid move');
  if (!Number.isInteger(p.board) || !Number.isInteger(p.cell)) throw new GameError('Pick a cell on the board');
  return { type: 'place', board: p.board as number, cell: p.cell as number };
}

function describe(g: UtttGame, e: GameEvent, n: (id: string | null) => string): [AnnounceKind, string] | null {
  if (e.kind === 'gameOver') {
    if (g.aborted) return ['over', 'Game stopped, not enough players left. No coins moved'];
    if (g.closed) return ['over', 'Game over. Only bots are left playing'];
    if (g.draw) return ['over', 'No big line anywhere. It’s a draw 🤝'];
    const won = g.winners();
    if (won.length === 0) return ['over', 'Game over'];
    return ['over', g.core.bigLine() ? `${n(won[0])} wins three boards in a row 🎉` : `Game over. ${n(won[0])} wins 🎉`];
  }
  return null;
}

export const utttModule: GameModule<UtttGame> = {
  kind: 'uttt',
  create: (order, config, rand, botIds) => new UtttGame(order, config, rand, botIds),
  view: (g) => ({ kind: 'uttt', uttt: g.view() }),
  move(g, playerId, raw) {
    const m = parseUtttMove(raw);
    return g.place(playerId, m.board, m.cell);
  },
  describe,
  // bots play through the driver's think pause
  auto: () => null,
  clock: () => null,
  botMove: (g, botId, level, rand) => decide(g, botId, level, rand),
  turnKey: (g) => `${g.stepSeq}|${g.turnId}`,
  inPlay: (g, id) => g.inPlay(id),
  tallies: (g, id) => ({ ...((g.stats.get(id)?.tallies as UtttTally | undefined) ?? {}) }),
  missionCounts: () => ({}),
};
