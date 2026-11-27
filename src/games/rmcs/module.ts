import { GameError } from '../../game.js';
import type { GameEvent } from '../../models.js';
import type { AnnounceKind, RmcsMoveInput } from '../../types.js';
import type { AutoStep, GameModule } from '../module.js';
import { RmcsGame, type RmcsTally } from './game.js';

/** a game:move payload's Raja Mantri part: { type: 'open' } or { type: 'guess', target } */
export function parseRmcsMove(raw: unknown): RmcsMoveInput {
  const p = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  if (p.type === 'open') return { type: 'open' };
  if (p.type === 'guess') {
    if (typeof p.target !== 'string' || p.target.length === 0 || p.target.length > 64) throw new GameError('Pick one of the two players left');
    return { type: 'guess', target: p.target };
  }
  throw new GameError('Invalid move');
}

/** a bot Mantri's pick: pure luck, 50/50 between the two left */
export function botGuess(g: RmcsGame, rand: () => number): string {
  const two = g.suspects();
  return two[Math.floor(rand() * two.length) % two.length];
}

function describe(g: RmcsGame, e: GameEvent, n: (id: string | null) => string): [AnnounceKind, string] | null {
  if (e.kind === 'gameOver') {
    if (g.aborted) return ['over', 'Game stopped, not enough players left. No coins moved'];
    const won = g.winners();
    if (g.closed && won.length === 0) return ['over', 'Game over. Only bots are left playing'];
    if (won.length === 0) return ['over', 'Game over'];
    const pts = (g.scores.get(won[0]) ?? 0).toLocaleString('en-IN');
    return ['over', won.length > 1 ? `Game over. ${won.map(n).join(' and ')} share first with ${pts} points 🎉` : `Game over. ${n(won[0])} wins with ${pts} points 🎉`];
  }
  if (e.kind !== 'rmcs') return null;
  const x = e.ev;
  switch (x.type) {
    case 'deal':
      return ['round', `Round ${x.round} of ${x.rounds}`];
    case 'open':
      return x.raja ? ['round', `Raja is ${n(x.playerId)} 👑`] : null;
    case 'guessing':
      return ['play', `Mantri ${n(x.mantriId)}, find the Chor!`];
    case 'result':
      return x.correct ? ['play', `Pakda gaya! 🦹 ${n(x.chorId)} was the Chor`] : ['play', `Chor bach gaya! 😈 ${n(x.chorId)} was the Chor`];
    default:
      return null;
  }
}

/** the next timed step: a bot opens or points, a chit opens by itself, time runs out, or the next round */
function auto(g: RmcsGame): AutoStep | null {
  if (g.over || g.endsAt === null) return null;
  const now = g.now();
  const wait = (at: number) => Math.max(0, at - now);
  if (g.phase === 'open') {
    const due = g.order.filter((id) => !g.opened.has(id) && g.botOpenAt.has(id)).sort((a, b) => g.botOpenAt.get(a)! - g.botOpenAt.get(b)!)[0];
    if (due && g.botOpenAt.get(due)! < g.endsAt) return { delayMs: wait(g.botOpenAt.get(due)!), run: () => g.open(due, true) };
    return { delayMs: wait(g.endsAt), run: () => g.openAll() };
  }
  if (g.phase === 'guess') {
    if (g.botGuessAt !== null && g.botGuessAt < g.endsAt) return { delayMs: wait(g.botGuessAt), run: () => g.guess(g.turnId!, botGuess(g, Math.random)) };
    return { delayMs: wait(g.endsAt), run: () => g.guessTimeUp() };
  }
  return { delayMs: wait(g.endsAt), run: () => g.next() };
}

export const rmcsModule: GameModule<RmcsGame> = {
  kind: 'rmcs',
  create: (order, config, rand, botIds) => new RmcsGame(order, config, rand, botIds),
  view: (g, meId, seated) => ({ kind: 'rmcs', rmcs: g.view(meId, seated) }),
  move(g, playerId, raw) {
    const m = parseRmcsMove(raw);
    return m.type === 'open' ? g.open(playerId) : g.guess(playerId, m.target);
  },
  describe,
  auto,
  clock: () => null,
  botMove: (g, botId, _level, rand) => (g.phase === 'guess' && g.turnId === botId ? { type: 'guess', target: botGuess(g, rand) } : { type: 'open' }),
  turnKey: (g) => `${g.stepSeq}|${g.phase}`,
  inPlay: (g, id) => g.inPlay(id),
  tallies: (g, id) => ({ ...((g.stats.get(id)?.tallies as RmcsTally | undefined) ?? {}) }),
  missionCounts: () => ({}),
};
