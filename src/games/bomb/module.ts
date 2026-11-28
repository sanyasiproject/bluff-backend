import { ordinal } from '../../cards.js';
import { GameError } from '../../game.js';
import type { GameEvent } from '../../models.js';
import type { AnnounceKind, BombMoveInput } from '../../types.js';
import type { GameModule } from '../module.js';
import { BombGame, type BombTally } from './game.js';

/** a game:move payload's Bomb Pass part: { type: 'answer', task, choice } */
export function parseBombMove(raw: unknown): BombMoveInput {
  const p = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  if (p.type === 'answer' && Number.isInteger(p.task) && Number.isInteger(p.choice)) return { type: 'answer', task: p.task as number, choice: p.choice as number };
  throw new GameError('Invalid move');
}

function describe(g: BombGame, e: GameEvent, n: (id: string | null) => string): [AnnounceKind, string] | null {
  if (e.kind === 'gameOver') {
    if (g.aborted) return ['over', 'Game stopped, not enough players left. No coins moved'];
    const won = g.winners();
    if (g.closed && won.length === 0) return ['over', 'Game over. Only bots are left playing'];
    if (won.length === 0) return ['over', 'Game over'];
    return ['over', `Game over. ${n(won[0])} is the last one standing 🎉`];
  }
  if (e.kind !== 'bomb') return null;
  const x = e.ev;
  // only the big moments: no line per pass or task
  if (x.type === 'go') return ['round', 'The fuse is lit! 💣'];
  if (x.type === 'boom') return ['play', x.out ? `BOOM! ${n(x.playerId)} is out 💥${x.place && x.place > 1 ? ` (${ordinal(x.place)})` : ''}` : `BOOM! ${n(x.playerId)} loses a heart 💥`];
  return null;
}

export const bombModule: GameModule<BombGame> = {
  kind: 'bomb',
  create: (order, config, rand, botIds) => new BombGame(order, config, rand, botIds),
  view: (g) => ({ kind: 'bomb', bomb: g.view() }),
  move(g, playerId, raw) {
    const m = parseBombMove(raw);
    return g.answer(playerId, m.task, m.choice);
  },
  describe,
  // the countdown, the heat, new tasks, bots' answers, the BOOM and the next round, on the server's clock
  auto(g) {
    const step = g.nextStep();
    return step ? { delayMs: Math.max(0, step.at - g.now()), run: step.run, quiet: true } : null;
  },
  clock: () => null,
  // nobody has a turn: bots answer through auto()
  botMove: (g) => ({ type: 'answer', task: g.task?.task.id ?? 0, choice: 0 }),
  turnKey: (g) => `${g.stepSeq}`,
  inPlay: (g, id) => g.inPlay(id),
  moveRate: 60,
  tallies: (g, id) => ({ ...((g.stats.get(id)?.tallies as BombTally | undefined) ?? {}) }),
  missionCounts: () => ({}),
};
