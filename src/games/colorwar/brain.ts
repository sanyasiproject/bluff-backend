import { COLORWAR_BURST, type BotLevel, type ColorWarCell } from '../../types.js';
import { applyTap, neighbours } from './board.js';
import type { ColorWarGame } from './game.js';

/** one tap's outcome for the bot: rival cells it removed, its own cells, and cells it leaves open to a rival's burst */
export function scoreTap(g: ColorWarGame, id: string, cell: number): number {
  const cells: ColorWarCell[] = g.cells.map((c) => ({ ...c }));
  const rivalsBefore = cells.filter((c) => c.owner !== null && c.owner !== id).length;
  const first = g.firstMove.has(id);
  const waiting = [...g.firstMove].some((p) => p !== id);
  applyTap(g.size, cells, id, cell, first, waiting);
  const rivals = cells.filter((c) => c.owner !== null && c.owner !== id).length;
  const mine = cells.filter((c) => c.owner === id).length;
  // the rival wiped out: nothing better
  if (rivals === 0 && !waiting) return 10_000;
  let danger = 0;
  cells.forEach((c, i) => {
    if (c.owner !== id) return;
    const ns = neighbours(g.size, i);
    const ripe = ns.some((j) => cells[j].owner !== null && cells[j].owner !== id && cells[j].dots === COLORWAR_BURST - 1);
    // my ripe cell next to their ripe cell: whoever moves first takes it
    if (ripe) danger += c.dots === COLORWAR_BURST - 1 ? 3 : 1 + c.dots / 2;
  });
  // my ripe cells next to theirs that aren't ripe are threats I keep
  let threat = 0;
  cells.forEach((c, i) => {
    if (c.owner !== id || c.dots !== COLORWAR_BURST - 1) return;
    threat += neighbours(g.size, i).filter((j) => cells[j].owner !== null && cells[j].owner !== id).length * 0.5;
  });
  return (rivalsBefore - rivals) * 4 + mine * 1.5 - danger * 2 + threat;
}

/** a bot's tap: Normal often picks at random, Hard the best scored tap, Expert also checks the reply it allows */
export function decide(g: ColorWarGame, id: string, level: BotLevel, rand: () => number): { type: 'tap'; cell: number } {
  const legal = g.legal(id);
  if (level === 'normal' && rand() < 0.45) return { type: 'tap', cell: legal[Math.floor(rand() * legal.length) % legal.length] };
  let scored = legal.map((cell) => ({ cell, s: scoreTap(g, id, cell) + rand() * 0.5 }));
  if (level === 'expert') {
    // the best few, each checked against the strongest reply of the next player
    scored = scored.sort((a, b) => b.s - a.s).slice(0, 6).map(({ cell, s }) => ({ cell, s: s - 0.6 * replyHarm(g, id, cell) }));
  }
  scored.sort((a, b) => b.s - a.s);
  return { type: 'tap', cell: scored[0].cell };
}

/** cells of mine the next player could take right after this tap */
function replyHarm(g: ColorWarGame, id: string, cell: number): number {
  const cells = g.cells.map((c) => ({ ...c }));
  const waiting = [...g.firstMove].some((p) => p !== id);
  applyTap(g.size, cells, id, cell, g.firstMove.has(id), waiting);
  const at = g.order.indexOf(id);
  const next = g.order.map((_, k) => g.order[(at + k + 1) % g.order.length]).find((p) => p !== id && g.alive().includes(p));
  if (!next || g.firstMove.has(next)) return 0;
  const mine = cells.filter((c) => c.owner === id).length;
  let worst = 0;
  cells.forEach((c, i) => {
    if (c.owner !== next || c.dots !== COLORWAR_BURST - 1) return;
    const sim = cells.map((x) => ({ ...x }));
    applyTap(g.size, sim, next, i, false, false);
    worst = Math.max(worst, mine - sim.filter((x) => x.owner === id).length);
  });
  return worst;
}
