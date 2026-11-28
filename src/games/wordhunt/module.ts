import { GameError } from '../../game.js';
import type { GameEvent } from '../../models.js';
import type { AnnounceKind, WordHuntMoveInput } from '../../types.js';
import type { GameModule } from '../module.js';
import { WordHuntGame, type WordHuntTally } from './game.js';

/** a game:move payload's Word Grid Hunt part: { type: 'word', round, path } (tile indexes, at most 25) */
export function parseWordHuntMove(raw: unknown): WordHuntMoveInput {
  const p = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  if (p.type !== 'word' || !Number.isInteger(p.round) || !Array.isArray(p.path)) throw new GameError('Invalid move');
  if (p.path.length === 0 || p.path.length > 25 || !p.path.every((i) => Number.isInteger(i))) throw new GameError('Trace a word through touching tiles');
  return { type: 'word', round: p.round as number, path: [...(p.path as number[])] };
}

function describe(g: WordHuntGame, e: GameEvent, n: (id: string | null) => string): [AnnounceKind, string] | null {
  if (e.kind === 'gameOver') {
    if (g.aborted) return ['over', 'Game stopped, not enough players left. No coins moved'];
    const won = g.winners();
    if (g.closed && won.length === 0) return ['over', 'Game over. Only bots are left playing'];
    if (won.length === 0) return ['over', 'Game over'];
    const pts = g.scores.get(won[0]) ?? 0;
    return ['over', won.length > 1 ? `Game over. ${won.map(n).join(' and ')} share first with ${pts} points 🎉` : `Game over. ${n(won[0])} wins with ${pts} points 🎉`];
  }
  if (e.kind !== 'wordhunt') return null;
  const x = e.ev;
  if (x.type === 'round') return ['round', `Round ${x.round} of ${g.rounds}. Find the words! 🔤`];
  if (x.type === 'reveal' && x.best) return ['round', `Best word: ${x.best.word.toUpperCase()} by ${n(x.best.playerId)} ✨`];
  return null;
}

export const wordhuntModule: GameModule<WordHuntGame> = {
  kind: 'wordhunt',
  create: (order, config, rand, botIds) => new WordHuntGame(order, config, rand, botIds),
  view: (g, meId, seated) => ({ kind: 'wordhunt', wordhunt: g.view(meId, seated) }),
  move(g, playerId, raw) {
    const m = parseWordHuntMove(raw);
    return g.word(playerId, m.round, m.path);
  },
  describe,
  // the countdown, bots' words, the round's end and the next round, on the server's clock
  auto(g) {
    const step = g.nextStep();
    return step ? { delayMs: Math.max(0, step.at - g.now()), run: step.run, quiet: true } : null;
  },
  clock: () => null,
  // nobody has a turn: bots find words through auto()
  botMove: (g) => ({ type: 'word', round: g.round, path: [0] }),
  turnKey: (g) => `${g.stepSeq}`,
  inPlay: (g, id) => g.inPlay(id),
  moveRate: 50,
  tallies: (g, id) => ({ ...((g.stats.get(id)?.tallies as WordHuntTally | undefined) ?? {}) }),
  missionCounts: () => ({}),
};
