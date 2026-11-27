import { GameError } from '../../game.js';
import type { GameEvent } from '../../models.js';
import type { AnnounceKind, FruitMoveInput } from '../../types.js';
import type { GameModule } from '../module.js';
import { FruitGame, type FruitTally } from './game.js';

/** a game:move payload's Fruit part: { type: 'strike', round, reaction: ms from when the item showed on this phone } */
export function parseFruitMove(raw: unknown): FruitMoveInput {
  const p = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  if (p.type !== 'strike') throw new GameError('Invalid move');
  if (!Number.isInteger(p.round) || (p.round as number) < 1 || (p.round as number) > 1000) throw new GameError('Invalid move');
  if (typeof p.reaction !== 'number' || !Number.isFinite(p.reaction) || p.reaction < 0 || p.reaction > 60_000) throw new GameError('Invalid move');
  return { type: 'strike', round: p.round as number, reaction: Math.round(p.reaction) };
}

function describe(g: FruitGame, e: GameEvent, n: (id: string | null) => string): [AnnounceKind, string] | null {
  if (e.kind === 'gameOver') {
    if (g.aborted) return ['over', 'Game stopped, not enough players left. No coins moved'];
    const won = g.winners();
    if (g.closed && won.length === 0) return ['over', 'Game over. Only bots are left playing'];
    if (won.length === 0) return ['over', 'Game over'];
    const pts = (g.scores.get(won[0]) ?? 0).toLocaleString('en-IN');
    return ['over', won.length > 1 ? `Game over! ${won.map(n).join(' and ')} share first with ${pts} points 🎉` : `Game over! ${n(won[0])} wins with ${pts} points 🎉`];
  }
  if (e.kind !== 'fruit') return null;
  // only the start: items, strikes and results show on the table
  if (e.ev.type === 'go') return ['round', `Swords ready! ${e.ev.rounds} items, fastest strike takes the fruit. Never cut the magnet 🧲`];
  return null;
}

export const fruitModule: GameModule<FruitGame> = {
  kind: 'fruit',
  create: (order, config, rand, botIds) => new FruitGame(order, config, rand, botIds),
  view: (g) => ({ kind: 'fruit', fruit: g.view() }),
  move(g, playerId, raw) {
    const m = parseFruitMove(raw);
    return g.strike(playerId, m.round, m.reaction);
  },
  describe,
  // the countdown, each item, bots' strikes and each item's close, on the server's clock
  auto(g) {
    const step = g.nextStep();
    return step ? { delayMs: Math.max(0, step.at - g.now()), run: step.run, quiet: true } : null;
  },
  clock: () => null,
  // nobody has a turn, so this is only a fallback: bots strike through auto()
  botMove: (g) => ({ type: 'strike', round: g.round, reaction: 400 }),
  turnKey: (g) => `${g.stepSeq}`,
  inPlay: (g, id) => g.inPlay(id),
  // one strike an item; room for a few retries
  moveRate: 60,
  tallies: (g, id) => ({ ...((g.stats.get(id)?.tallies as FruitTally | undefined) ?? {}) }),
  missionCounts: () => ({}),
};
