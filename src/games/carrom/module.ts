import { GameError } from '../../game.js';
import type { GameEvent } from '../../models.js';
import { gameOpt, type AnnounceKind, type CarromMoveInput, type GameConfig } from '../../types.js';
import type { GameModule } from '../module.js';
import { decide, decideNow, type CarromSeat } from './brain.js';
import { CarromGame, type CarromTally } from './game.js';

/** a game:move payload's Carrom part: { type: 'shot', x, dx, dy, power } (finite numbers; the game clamps them) */
export function parseCarromMove(raw: unknown): CarromMoveInput {
  const p = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const ok = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 10;
  if (p.type !== 'shot' || !ok(p.x) || !ok(p.dx) || !ok(p.dy) || !ok(p.power)) throw new GameError('Invalid shot');
  return { type: 'shot', x: p.x, dx: p.dx, dy: p.dy, power: p.power };
}

/** what a bot sees of the table */
export function seatOf(g: CarromGame, id: string): CarromSeat {
  return { mode: g.mode, me: id, side: g.sideOf(id), color: g.colors?.get(id) ?? null, coins: g.coins.map((c) => ({ ...c })), queen: { ...g.queen } };
}

function describe(g: CarromGame, e: GameEvent, n: (id: string | null) => string): [AnnounceKind, string] | null {
  if (e.kind === 'gameOver') {
    if (g.aborted) return ['over', 'Game stopped, not enough players left. No coins moved'];
    const won = g.winners();
    if (g.closed && won.length === 0) return ['over', 'Game over. Only bots are left playing'];
    if (won.length === 0) return ['over', 'Game over'];
    return ['over', `Game over. ${won.map(n).join(' and ')} ${won.length > 1 ? 'win' : 'wins'} 🎉`];
  }
  if (e.kind !== 'carrom') return null;
  const x = e.ev;
  if (x.type === 'board') {
    if (g.over) return null;
    return ['round', g.mode === 'classic' ? `Board ${x.board} to ${x.winners.map(n).join(' and ')} (+${x.points})` : `Board ${x.board} done`];
  }
  if (x.queen === 'covered') return ['play', `${n(x.playerId)} covered the queen! 👑`];
  if (x.queen === 'pocketed') return ['play', `${n(x.playerId)} pocketed the queen. Cover her!`];
  if (x.foul === 'striker') return ['pass', `Foul! ${n(x.playerId)}'s striker went in`];
  if (x.foul === 'lastCoin') return ['pass', `Foul! ${n(x.playerId)} pocketed a last coin before the queen was covered`];
  return null;
}

export const carromModule: GameModule<CarromGame> = {
  kind: 'carrom',
  create: (order, config, rand, botIds) => new CarromGame(order, config, rand, botIds),
  view: (g) => ({ kind: 'carrom', carrom: g.view() }),
  move(g, playerId, raw) {
    const m = parseCarromMove(raw);
    return g.shoot(playerId, m.x, m.dx, m.dy, m.power);
  },
  describe,
  // the coins roll, then the next shot; a person who runs out of time gets a soft straight shot
  auto(g) {
    const id = g.turnId;
    if (g.over || !id) return null;
    if (g.bots.has(id)) {
      if (g.settled) return null;
      return { delayMs: Math.max(0, g.settleAt - g.now()) + g.botPaceMs, run: () => g.settle(), quiet: true };
    }
    return { delayMs: Math.max(0, (g.deadline ?? g.now()) - g.now()), run: () => g.timeout() };
  },
  clock: () => null,
  botMove: (g, botId, level, rand) => decideNow(seatOf(g, botId), level, rand),
  // sims in short slices off the event loop
  botThink: (g, botId, rand) => decide(seatOf(g, botId), g.config.botLevel, rand),
  checkStart(config: GameConfig, players: number) {
    if (gameOpt<string>(config, 'mode') !== 'freestyle' && players === 3) throw new GameError('Classic carrom is for 2 or 4 players (2v2). Pick Freestyle for 3');
  },
  turnKey: (g) => `${g.stepSeq}|${g.turnId}`,
  inPlay: (g, id) => g.inPlay(id),
  tallies: (g, id) => ({ ...((g.stats.get(id)?.tallies as CarromTally | undefined) ?? {}) }),
  missionCounts: () => ({}),
};
