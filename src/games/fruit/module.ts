import { GameError } from '../../game.js';
import type { GameEvent } from '../../models.js';
import type { AnnounceKind, FruitMoveInput } from '../../types.js';
import type { GameModule } from '../module.js';
import { FRUIT_MAX_IDS, FruitGame, type FruitTally } from './game.js';

/** a combo this big is read out */
const SAY_COMBO = 5;

/** a game:move payload's Fruit part: { type: 'slice', ids: fruit ids, at: ms after startsAt } */
export function parseFruitMove(raw: unknown): FruitMoveInput {
  const p = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  if (p.type !== 'slice') throw new GameError('Invalid move');
  const ids = p.ids;
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > FRUIT_MAX_IDS || !ids.every((x) => Number.isInteger(x) && x > 0 && x < 100_000)) throw new GameError('Invalid move');
  if (typeof p.at !== 'number' || !Number.isFinite(p.at) || Math.abs(p.at) > 10 * 60_000) throw new GameError('Invalid move');
  return { type: 'slice', ids: ids as number[], at: p.at };
}

function describe(g: FruitGame, e: GameEvent, n: (id: string | null) => string): [AnnounceKind, string] | null {
  if (e.kind === 'gameOver') {
    if (g.aborted) return ['over', 'Game stopped, not enough players left. No coins moved'];
    const won = g.winners();
    if (g.closed && won.length === 0) return ['over', 'Game over. Only bots are left playing'];
    if (won.length === 0) return ['over', 'Game over'];
    const pts = (g.scores.get(won[0]) ?? 0).toLocaleString('en-IN');
    return ['over', won.length > 1 ? `Time's up! ${won.map(n).join(' and ')} share first with ${pts} points 🎉` : `Time's up! ${n(won[0])} wins with ${pts} points 🎉`];
  }
  if (e.kind !== 'fruit') return null;
  const x = e.ev;
  if (x.type === 'go') return ['round', `Slice! ${x.seconds} seconds on the clock 🍉`];
  // only the big combos: no line per slice
  if (x.combo >= SAY_COMBO) return ['play', `${n(x.playerId)} sliced ${x.combo} in one swipe! 🔥`];
  return null;
}

export const fruitModule: GameModule<FruitGame> = {
  kind: 'fruit',
  create: (order, config, rand, botIds) => new FruitGame(order, config, rand, botIds),
  view: (g) => ({ kind: 'fruit', fruit: g.view() }),
  move(g, playerId, raw) {
    const m = parseFruitMove(raw);
    return g.slice(playerId, m.ids, m.at);
  },
  describe,
  // the countdown, every bot swipe and the final whistle, on the server's clock
  auto(g) {
    const step = g.nextStep();
    return step ? { delayMs: Math.max(0, step.at - g.now()), run: step.run, quiet: true } : null;
  },
  // ends the game on time even with nobody connected
  clock: (g) => (g.over ? null : { endsAt: g.endsAt, run: () => g.finish() }),
  // nobody has a turn, so this is only a fallback: bots swipe through auto()
  botMove: () => ({ type: 'slice', ids: [1], at: 0 }),
  turnKey: (g) => `${g.stepSeq}`,
  inPlay: (g, id) => g.inPlay(id),
  // ~10 swipes a second
  moveRate: 150,
  tallies: (g, id) => ({ ...((g.stats.get(id)?.tallies as FruitTally | undefined) ?? {}) }),
  missionCounts: () => ({}),
};
