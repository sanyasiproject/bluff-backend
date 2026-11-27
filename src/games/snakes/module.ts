import { ordinal } from '../../cards.js';
import { GameError } from '../../game.js';
import type { GameEvent } from '../../models.js';
import { SNAKES_BITE_BACK, type AnnounceKind, type SnakesMoveInput } from '../../types.js';
import type { GameModule } from '../module.js';
import { SnakesGame, type SnakesTally } from './game.js';

/** a game:move payload's Saanp Seedhi part: { type: 'roll' } */
export function parseSnakesMove(raw: unknown): SnakesMoveInput {
  const p = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  if (p.type === 'roll') return { type: 'roll' };
  throw new GameError('Invalid move');
}

function describe(g: SnakesGame, e: GameEvent, n: (id: string | null) => string): [AnnounceKind, string] | null {
  if (e.kind === 'finish') return ['finish', e.place === 1 ? `${n(e.playerId)} reached 100 first! 🏆` : `${n(e.playerId)} finished ${ordinal(e.place)}`];
  if (e.kind === 'gameOver') {
    if (g.aborted) return ['over', 'Game stopped, not enough players left. No coins moved'];
    const won = g.winners();
    if (g.closed && won.length === 0) return ['over', 'Game over. Only bots are left playing'];
    if (won.length === 0) return ['over', 'Game over'];
    return ['over', `Game over. ${won.map(n).join(' and ')} wins 🎉`];
  }
  if (e.kind !== 'snakes') return null;
  const x = e.ev;
  if (x.type === 'roll') return x.lost ? ['pass', `Three 6s for ${n(x.playerId)}, turn lost 😵`] : null;
  const m = x.move;
  if (m.bitten.length > 0) return ['play', `${n(m.playerId)} bit ${m.bitten.map((b) => n(b.playerId)).join(' and ')}! 🐍 Back ${SNAKES_BITE_BACK}`];
  if (m.via?.kind === 'snake') return ['play', `Ssss! ${n(m.playerId)} slid down from ${m.via.from} to ${m.via.to} 🐍`];
  if (m.via?.kind === 'ladder') return ['round', `${n(m.playerId)} climbed a ladder to ${m.via.to} 🪜`];
  return null;
}

export const snakesModule: GameModule<SnakesGame> = {
  kind: 'snakes',
  create: (order, config, rand, botIds) => new SnakesGame(order, config, rand, botIds),
  view: (g) => ({ kind: 'snakes', snakes: g.view() }),
  move(g, playerId, raw) {
    parseSnakesMove(raw);
    return g.roll(playerId);
  },
  describe,
  // bots roll here, once the last roll has had time to show on the board
  auto(g) {
    const id = g.turnId;
    if (g.over || !id || !g.bots.has(id)) return null;
    return { delayMs: g.botPaceMs, run: () => g.roll(id) };
  },
  clock: () => null,
  botMove: () => ({ type: 'roll' }),
  turnKey: (g) => `${g.stepSeq}|${g.turnId}`,
  inPlay: (g, id) => g.inPlay(id),
  tallies: (g, id) => ({ ...((g.stats.get(id)?.tallies as SnakesTally | undefined) ?? {}) }),
  missionCounts: () => ({}),
};
