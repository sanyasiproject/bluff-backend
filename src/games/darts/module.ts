import { ordinal } from '../../cards.js';
import { GameError } from '../../game.js';
import type { GameEvent } from '../../models.js';
import type { AnnounceKind, DartsMoveInput } from '../../types.js';
import type { GameModule } from '../module.js';
import { decide } from './brain.js';
import { DARTS_TURN_PAUSE_MS, DartsGame, type DartsTally } from './game.js';

/** a game:move payload's Darts part: { type: 'throw', x, y } in board units (scoring radius 1) */
export function parseDartsMove(raw: unknown): DartsMoveInput {
  const p = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  if (p.type !== 'throw') throw new GameError('Invalid move');
  if (typeof p.x !== 'number' || typeof p.y !== 'number' || !Number.isFinite(p.x) || !Number.isFinite(p.y)) throw new GameError('Aim at the board');
  // far off the board is a miss anyway
  const clamp = (v: number) => Math.max(-2, Math.min(2, v));
  return { type: 'throw', x: clamp(p.x), y: clamp(p.y) };
}

function describe(g: DartsGame, e: GameEvent, n: (id: string | null) => string): [AnnounceKind, string] | null {
  if (e.kind === 'finish') {
    if (g.over && g.left.get(e.playerId)! > 0) return null;
    return ['finish', e.place === 1 ? `${n(e.playerId)} checked out first! 🏆` : `${n(e.playerId)} checked out ${ordinal(e.place)}`];
  }
  if (e.kind === 'gameOver') {
    if (g.aborted) return ['over', 'Game stopped, not enough players left. No coins moved'];
    const won = g.winners();
    if (g.closed && won.length === 0) return ['over', 'Game over. Only bots are left playing'];
    if (won.length === 0) return ['over', 'Game over'];
    return ['over', `Game over. ${won.map(n).join(' and ')} wins 🎉`];
  }
  if (e.kind !== 'darts') return null;
  const x = e.ev;
  if (x.type === 'turnEnd') {
    if (x.t180) return ['play', `ONE HUNDRED AND EIGHTY! 🎯 ${n(x.playerId)}`];
    if (x.bust) return ['pass', `Bust! ${n(x.playerId)} stays on ${g.left.get(x.playerId)}`];
    return null;
  }
  return x.dart.ring === 'bull' ? ['round', `Bullseye for ${n(x.dart.playerId)}! 🐂`] : null;
}

export const dartsModule: GameModule<DartsGame> = {
  kind: 'darts',
  create: (order, config, rand, botIds) => new DartsGame(order, config, rand, botIds),
  view: (g) => ({ kind: 'darts', darts: g.view() }),
  move(g, playerId, raw) {
    const m = parseDartsMove(raw);
    return g.throw(playerId, m.x, m.y);
  },
  describe,
  // the finished turn shows, then the next player steps up; bots throw here at a human pace
  auto(g) {
    const id = g.turnId;
    if (g.over || !id) return null;
    if (g.turnDone) return { delayMs: DARTS_TURN_PAUSE_MS, run: () => g.nextTurn() };
    if (!g.bots.has(id)) return null;
    return {
      delayMs: g.botPaceMs,
      run: () => {
        const m = decide(g, id, g.config.botLevel, g.jitter);
        return g.throw(id, m.x, m.y);
      },
    };
  },
  clock: () => null,
  botMove: (g, botId, level, rand) => decide(g, botId, level, rand),
  turnKey: (g) => `${g.stepSeq}|${g.turnId}`,
  inPlay: (g, id) => g.inPlay(id),
  tallies: (g, id) => ({ ...((g.stats.get(id)?.tallies as DartsTally | undefined) ?? {}) }),
  missionCounts: () => ({}),
};
