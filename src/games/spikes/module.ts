import { ordinal } from '../../cards.js';
import { GameError } from '../../game.js';
import type { GameEvent } from '../../models.js';
import type { AnnounceKind, SpikesMoveInput } from '../../types.js';
import type { GameModule } from '../module.js';
import { SpikesGame, type SpikesTally } from './game.js';

/** a game:move payload's Spike Attack part: { type: 'move', x, y } in arena units (the game clamps them) */
export function parseSpikesMove(raw: unknown): SpikesMoveInput {
  const p = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const ok = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < 100;
  if (p.type === 'move' && ok(p.x) && ok(p.y)) return { type: 'move', x: p.x, y: p.y };
  throw new GameError('Invalid move');
}

/** coalesced view pushes while people and bots move (ms) */
export const SPIKES_PUSH_MS = 80;

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
  // only the big moments: no line per move, warning or hit
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
    return g.moveTo(playerId, m.x, m.y);
  },
  describe,
  // the countdown, warnings, strikes and bots' runs, on the server's clock
  auto(g) {
    const step = g.nextStep();
    return step ? { delayMs: Math.max(0, step.at - g.now()), run: step.run, quiet: true } : null;
  },
  clock: () => null,
  // nobody has a turn, so this is only a fallback: bots run through auto()
  botMove: (g, id) => {
    const [x, y] = g.pos.get(id) ?? [0, 0];
    return { type: 'move', x, y };
  },
  turnKey: (g) => `${g.stepSeq}`,
  inPlay: (g, id) => g.inPlay(id),
  // ~12 moves a second, with room to spare
  moveRate: 200,
  // positions go out with the next view, at most every 80 ms
  live: { ms: SPIKES_PUSH_MS, is: (e) => e.kind === 'spikes' && e.ev.type === 'step' },
  tallies: (g, id) => ({ ...((g.stats.get(id)?.tallies as SpikesTally | undefined) ?? {}) }),
  missionCounts: () => ({}),
};
