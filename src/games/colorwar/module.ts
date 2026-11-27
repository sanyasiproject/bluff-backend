import { ordinal } from '../../cards.js';
import { GameError } from '../../game.js';
import type { GameEvent } from '../../models.js';
import type { AnnounceKind, ColorWarMoveInput } from '../../types.js';
import type { GameModule } from '../module.js';
import { decide } from './brain.js';
import { ColorWarGame, type ColorWarTally } from './game.js';

/** a chain this long (waves) is read out */
const BIG_CHAIN = 5;

/** a game:move payload's Colour Wars part: { type: 'tap', cell } (row-major) */
export function parseColorWarMove(raw: unknown): ColorWarMoveInput {
  const p = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  if (p.type !== 'tap') throw new GameError('Invalid move');
  if (!Number.isInteger(p.cell)) throw new GameError('Tap a cell on the board');
  return { type: 'tap', cell: p.cell as number };
}

function describe(g: ColorWarGame, e: GameEvent, n: (id: string | null) => string): [AnnounceKind, string] | null {
  if (e.kind === 'finish') return ['finish', `${n(e.playerId)} owns the board! 🏆`];
  if (e.kind === 'gameOver') {
    if (g.aborted) return ['over', 'Game stopped, not enough players left. No coins moved'];
    const won = g.winners();
    if (g.closed && won.length === 0) return ['over', 'Game over. Only bots are left playing'];
    if (won.length === 0) return ['over', 'Game over'];
    return ['over', `Game over. ${won.map(n).join(' and ')} wins 🎉`];
  }
  if (e.kind !== 'colorwar') return null;
  const x = e.ev;
  if (x.type === 'out') return ['play', `${n(x.playerId)} is wiped out, ${ordinal(x.place)} place 💥`];
  if (x.waves.length >= BIG_CHAIN && !g.over) return ['round', `Chain reaction! ${n(x.playerId)} took ${x.captured} cells 💥`];
  return null;
}

export const colorwarModule: GameModule<ColorWarGame> = {
  kind: 'colorwar',
  create: (order, config, rand, botIds) => new ColorWarGame(order, config, rand, botIds),
  view: (g) => ({ kind: 'colorwar', colorwar: g.view() }),
  move(g, playerId, raw) {
    return g.tap(playerId, parseColorWarMove(raw).cell);
  },
  describe,
  // bots tap here, once the last chain has had time to show on the board
  auto(g) {
    const id = g.turnId;
    if (g.over || !id || !g.bots.has(id)) return null;
    return { delayMs: g.botPaceMs, run: () => g.tap(id, decide(g, id, g.config.botLevel, g.jitter).cell) };
  },
  clock: () => null,
  botMove: (g, botId, level, rand) => decide(g, botId, level, rand),
  turnKey: (g) => `${g.stepSeq}|${g.turnId}`,
  inPlay: (g, id) => g.inPlay(id),
  tallies: (g, id) => ({ ...((g.stats.get(id)?.tallies as ColorWarTally | undefined) ?? {}) }),
  missionCounts: () => ({}),
};
