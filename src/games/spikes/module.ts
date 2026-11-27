import { ordinal } from '../../cards.js';
import { GameError } from '../../game.js';
import type { GameEvent } from '../../models.js';
import type { AnnounceKind, SpikesMoveInput } from '../../types.js';
import type { GameModule } from '../module.js';
import { SpikesGame, type SpikesTally } from './game.js';

const DIRS: readonly SpikesMoveInput['dir'][] = ['up', 'down', 'left', 'right'];

/** a game:move payload's Spike Attack part: { type: 'step', dir } */
export function parseSpikesMove(raw: unknown): SpikesMoveInput {
  const p = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  if (p.type === 'step' && DIRS.includes(p.dir as SpikesMoveInput['dir'])) return { type: 'step', dir: p.dir as SpikesMoveInput['dir'] };
  throw new GameError('Invalid move');
}

function describe(g: SpikesGame, e: GameEvent, n: (id: string | null) => string): [AnnounceKind, string] | null {
  if (e.kind === 'finish') return ['finish', `${n(e.playerId)} is the last one standing! 🏆`];
  if (e.kind === 'gameOver') {
    if (g.aborted) return ['over', 'Game stopped, not enough players left. No coins moved'];
    const won = g.winners();
    if (g.closed && won.length === 0) return ['over', 'Game over. Only bots are left playing'];
    if (won.length === 0) return ['over', 'Game over'];
    return ['over', won.length > 1 ? `Game over. ${won.map(n).join(' and ')} share the win 🎉` : `Game over. ${n(won[0])} wins 🎉`];
  }
  if (e.kind !== 'spikes') return null;
  const x = e.ev;
  // only the big moments: no line per step, warning or hit
  if (x.type === 'go') return ['round', 'Dodge the spikes! 🔺'];
  if (x.type === 'out') return ['play', `${n(x.playerId)} is out 💀${x.place > 1 ? ` (${ordinal(x.place)})` : ''}`];
  if (x.type === 'timeUp') return ['round', "Time's up! Most lives left wins"];
  return null;
}

export const spikesModule: GameModule<SpikesGame> = {
  kind: 'spikes',
  create: (order, config, rand, botIds) => new SpikesGame(order, config, rand, botIds),
  view: (g) => ({ kind: 'spikes', spikes: g.view() }),
  move(g, playerId, raw) {
    const m = parseSpikesMove(raw);
    return g.step(playerId, m.dir);
  },
  describe,
  // the countdown, warnings, strikes and bots' steps, on the server's clock
  auto(g) {
    const step = g.nextStep();
    return step ? { delayMs: Math.max(0, step.at - g.now()), run: step.run, quiet: true } : null;
  },
  clock: () => null,
  // nobody has a turn, so this is only a fallback: bots step through auto()
  botMove: () => ({ type: 'step', dir: 'up' }),
  turnKey: (g) => `${g.stepSeq}`,
  inPlay: (g, id) => g.inPlay(id),
  // a step every 140 ms
  moveRate: 100,
  tallies: (g, id) => ({ ...((g.stats.get(id)?.tallies as SpikesTally | undefined) ?? {}) }),
  missionCounts: () => ({}),
};
