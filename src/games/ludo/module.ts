import { ordinal } from '../../cards.js';
import { GameError } from '../../game.js';
import type { GameEvent } from '../../models.js';
import { LUDO_TOKENS, type AnnounceKind, type LudoMoveInput } from '../../types.js';
import type { GameModule } from '../module.js';
import { decide } from './brain.js';
import { LudoGame, type LudoTally } from './game.js';

/** pause before each automatic step (ms at speed 1): the dice is seen first */
const PACE = { pass: 900, threeSixes: 1100, move: 700 } as const;

/** a game:move payload's Ludo part: { type: 'roll' } or { type: 'move', token: 0..3 } */
export function parseLudoMove(raw: unknown): LudoMoveInput {
  const p = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  if (p.type === 'roll') return { type: 'roll' };
  if (p.type === 'move') {
    if (!Number.isInteger(p.token) || (p.token as number) < 0 || (p.token as number) >= LUDO_TOKENS) throw new GameError('Pick one of your gotis');
    return { type: 'move', token: p.token as number };
  }
  throw new GameError('Invalid move');
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : `${n} ${many}`);

function describe(g: LudoGame, e: GameEvent, n: (id: string | null) => string): [AnnounceKind, string] | null {
  if (e.kind === 'finish') {
    if (g.teams && !g.over) {
      const p = g.partnerOf(e.playerId);
      return ['finish', `${n(e.playerId)} has every goti home and now rolls for ${n(p)} 🤝`];
    }
    return ['finish', e.place === 1 ? `${n(e.playerId)} is home first! 🏆` : `${n(e.playerId)} finished ${ordinal(e.place)}`];
  }
  if (e.kind === 'gameOver') {
    if (g.aborted) return ['over', g.teams ? 'Game stopped, a team lost a player. No coins moved' : 'Game stopped, not enough players left. No coins moved'];
    const won = g.winners();
    const names = won.map(n).join(' and ');
    if (g.timedOut) {
      const pts = won.length > 0 ? (g.teams ? won.reduce((s, id) => s + g.seatOf(id).score, 0) : g.seatOf(won[0]).score) : 0;
      if (g.teams && won.length > 2) return ['over', `Time's up! Both teams tie on points`];
      return ['over', won.length > (g.teams ? 2 : 1) ? `Time's up! ${names} share first with ${pts} points ⏰` : `Time's up! ${names} ${g.teams ? 'win' : 'wins'} with ${pts} points ⏰`];
    }
    if (g.closed && won.length === 0) return ['over', 'Game over. Only bots are left playing'];
    if (won.length === 0) return ['over', 'Game over'];
    return ['over', `Game over. ${names} ${won.length > 1 ? 'win' : 'wins'} 🎉`];
  }
  if (e.kind !== 'ludo') return null;
  const x = e.ev;
  switch (x.type) {
    case 'move': {
      if (x.captured.length > 0) {
        const by = new Map<string, number>();
        for (const c of x.captured) by.set(c.playerId, (by.get(c.playerId) ?? 0) + 1);
        const whose = [...by].map(([id, k]) => plural(k, `${n(id)}'s goti`, `of ${n(id)}'s gotis`)).join(' and ');
        return ['play', `${n(x.playerId)} knocked ${whose} home! 💥`];
      }
      if (x.home) return ['round', x.owner === x.playerId ? `${n(x.playerId)}'s goti made it home 🏠` : `${n(x.playerId)} brought ${n(x.owner)}'s goti home 🏠`];
      return null;
    }
    case 'pass':
      return x.threeSixes ? ['pass', `Three 6s for ${n(x.playerId)}, turn lost 😵`] : null;
    case 'unlock':
      return ['round', 'Nobody could move, so the gates open: every goti may go home now 🔓'];
    default:
      return null;
  }
}

export const ludoModule: GameModule<LudoGame> = {
  kind: 'ludo',
  create: (order, config, rand) => new LudoGame(order, config, rand),
  view: (g) => ({ kind: 'ludo', ludo: g.view() }),
  move(g, playerId, raw) {
    const m = parseLudoMove(raw);
    return m.type === 'roll' ? g.roll(playerId) : g.move(playerId, m.token);
  },
  describe,
  auto(g) {
    if (!g.autoDue) return null;
    const none = g.movable().length === 0;
    return { delayMs: none ? (g.sixes >= 3 ? PACE.threeSixes : PACE.pass) : PACE.move, run: () => g.stepAuto() };
  },
  clock: (g) => (g.endsAt !== null && !g.over ? { endsAt: g.endsAt, run: () => g.timeUp() } : null),
  botMove: (g, botId, level, rand) => decide(g, botId, level, rand),
  turnKey: (g) => `${g.stepSeq}|${g.turnId}`,
  inPlay: (g, id) => g.inPlay(id),
  tallies: (g, id) => ({ ...((g.stats.get(id)?.tallies as LudoTally | undefined) ?? {}) }),
  missionCounts: (t, won) => ({
    ludoGames: 1,
    ludoWins: won ? 1 : 0,
    ludoKills: t.kills ?? 0,
    ludoHome: t.home ?? 0,
    ludoSixes: t.sixes ?? 0,
  }),
};
