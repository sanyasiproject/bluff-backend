import { ordinal } from '../../cards.js';
import { GameError } from '../../game.js';
import type { GameEvent } from '../../models.js';
import type { AnnounceKind, SeaMoveInput, SeaShip } from '../../types.js';
import type { GameModule } from '../module.js';
import { decide } from './brain.js';
import { SEA_BOT_READY_MS, SeaGame, type SeaTally } from './game.js';

const isInt = (v: unknown): v is number => Number.isInteger(v);
const isId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length < 100;

/** a game:move payload's Sea Battle part (see SeaMoveInput) */
export function parseSeaMove(raw: unknown): SeaMoveInput {
  const p = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  if (p.type === 'ready') return { type: 'ready' };
  if (p.type === 'place') {
    if (p.ships === undefined) return { type: 'place' };
    if (!Array.isArray(p.ships) || p.ships.length > 5) throw new GameError('Invalid fleet');
    const ships: SeaShip[] = p.ships.map((s: unknown) => {
      const o = s && typeof s === 'object' ? (s as Record<string, unknown>) : {};
      if (!isInt(o.x) || !isInt(o.y) || !isInt(o.len) || typeof o.v !== 'boolean') throw new GameError('Invalid fleet');
      return { x: o.x, y: o.y, len: o.len, v: o.v };
    });
    return { type: 'place', ships };
  }
  if (!isId(p.target)) throw new GameError('Pick a fleet to fire at');
  if ((p.type === 'fire' || p.type === 'radar') && isInt(p.x) && isInt(p.y)) return { type: p.type, target: p.target, x: p.x, y: p.y };
  if (p.type === 'torpedo' && isInt(p.row)) return { type: 'torpedo', target: p.target, row: p.row };
  if (p.type === 'salvo' && Array.isArray(p.cells) && p.cells.length <= 3 && p.cells.every((c) => Array.isArray(c) && c.length === 2 && isInt(c[0]) && isInt(c[1]))) {
    return { type: 'salvo', target: p.target, cells: (p.cells as [number, number][]).map(([x, y]) => [x, y]) };
  }
  throw new GameError('Invalid move');
}

function play(g: SeaGame, id: string, m: SeaMoveInput): GameEvent[] {
  if (m.type === 'place') return g.place(id, m.ships);
  if (m.type === 'ready') return g.markReady(id);
  if (m.type === 'fire') return g.fire(id, m.target, m.x, m.y);
  if (m.type === 'radar') return g.radar(id, m.target, m.x, m.y);
  if (m.type === 'salvo') return g.salvo(id, m.target, m.cells);
  return g.torpedo(id, m.target, m.row);
}

/** a bot's shot from its own view; a plain random shot if its plan doesn't fit */
function botShot(g: SeaGame, id: string): GameEvent[] {
  try {
    return play(g, id, decide(g.view(id, true), id, g.config.botLevel, g.jitter));
  } catch (err) {
    if (!(err instanceof GameError) && !(err instanceof TypeError)) throw err;
    return g.timeout();
  }
}

function describe(g: SeaGame, e: GameEvent, n: (id: string | null) => string): [AnnounceKind, string] | null {
  if (e.kind === 'gameOver') {
    if (g.aborted) return ['over', 'Game stopped, not enough players left. No coins moved'];
    const won = g.winners();
    if (g.closed && won.length === 0) return ['over', 'Game over. Only bots are left playing'];
    if (won.length === 0) return ['over', 'Game over'];
    return ['over', `Game over. ${n(won[0])}'s fleet rules the sea 🎉`];
  }
  if (e.kind !== 'seabattle') return null;
  const x = e.ev;
  if (x.type === 'battle') return ['round', 'Fleets ready. Open fire! 🚢'];
  if (x.type === 'out') return ['play', `${n(x.playerId)}'s fleet is sunk 🌊${x.place > 1 ? ` (${ordinal(x.place)})` : ''}`];
  if (x.type === 'shot' && x.sunk.length > 0) return ['play', `${n(x.by)} sank ${n(x.target)}'s ${x.sunk.join(' and ')}-ship! 💥`];
  return null;
}

export const seabattleModule: GameModule<SeaGame> = {
  kind: 'seabattle',
  create: (order, config, rand, botIds) => new SeaGame(order, config, rand, botIds),
  view: (g, meId, seated) => ({ kind: 'seabattle', seabattle: g.view(meId, seated) }),
  move(g, playerId, raw) {
    return play(g, playerId, parseSeaMove(raw));
  },
  describe,
  // placement time, bots getting ready, bots' shots and timed-out shots
  auto(g) {
    if (g.over) return null;
    if (g.phase === 'place') {
      const bot = g.order.find((id) => g.bots.has(id) && g.alive(id) && !g.ready.has(id));
      if (bot) return { delayMs: SEA_BOT_READY_MS, run: () => g.markReady(bot) };
      return { delayMs: Math.max(0, g.placeEndsAt - g.now()), run: () => g.startBattle() };
    }
    const id = g.turnId;
    if (!id) return null;
    if (g.bots.has(id)) return { delayMs: g.botPaceMs, run: () => botShot(g, id) };
    return { delayMs: Math.max(0, (g.deadline ?? g.now()) - g.now()), run: () => g.timeout() };
  },
  clock: () => null,
  botMove: (g, botId, level, rand) => decide(g.view(botId, true), botId, level, rand),
  turnKey: (g) => `${g.stepSeq}|${g.turnId}`,
  inPlay: (g, id) => g.inPlay(id),
  tallies: (g, id) => ({ ...((g.stats.get(id)?.tallies as SeaTally | undefined) ?? {}) }),
  missionCounts: () => ({}),
};
