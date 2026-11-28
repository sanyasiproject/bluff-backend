import { gomokuCentre, type BotLevel, type GomokuMoveInput } from '../../types.js';
import type { GomokuGame } from './game.js';
import { DIRS, defenseScore, threatAt, threatScore } from './shape.js';

/** empty points within two of a stone (the centre on an empty board) */
export function candidates(cells: ArrayLike<number>, size: number): number[] {
  const out: number[] = [];
  let any = false;
  for (let i = 0; i < cells.length; i++) {
    if (cells[i] === -1) continue;
    any = true;
    break;
  }
  if (!any) return [gomokuCentre(size)];
  for (let i = 0; i < cells.length; i++) {
    if (cells[i] !== -1) continue;
    const x = i % size;
    const y = Math.floor(i / size);
    let near = false;
    for (let dy = -2; dy <= 2 && !near; dy++) {
      for (let dx = -2; dx <= 2 && !near; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if ((dx || dy) && nx >= 0 && ny >= 0 && nx < size && ny < size && cells[ny * size + nx] !== -1) near = true;
      }
    }
    if (near) out.push(i);
  }
  return out;
}

interface Scored {
  at: number;
  score: number;
  /** own shapes only */
  attack: number;
  win: boolean;
  /** what an opponent would make here: 3 five (they hold a four), 2 open four (an open three), 1 open three, 0 less */
  stop: number;
  /** the same for the next player only (with 3–4 players they block what comes before them) */
  stopNext: number;
  /** opponents (by turn distance, 0 next) who would make five here */
  fiveFor: number[];
}

// how urgent stopping a seat at a point is
function urgency(cells: ArrayLike<number>, size: number, at: number, seat: number): number {
  const t = threatAt(cells, size, at, seat);
  if (t.five) return 3;
  if (t.openFour || t.four >= 2) return 2;
  return t.openThree > 0 ? 1 : 0;
}

/** every candidate scored for `seat`: own attack plus the threats it stops (nearest opponents weigh most) */
function scoreAll(cells: ArrayLike<number>, size: number, seat: number, opponents: number[], defend = 0.9): Scored[] {
  return candidates(cells, size).map((at) => {
    const mine = threatAt(cells, size, at, seat);
    let block = 0;
    let stop = 0;
    let stopNext = 0;
    const fiveFor: number[] = [];
    opponents.forEach((o, k) => {
      const t = threatAt(cells, size, at, o);
      // with 3–4 players an open four can still be stopped by the others, so only fives are worth stopping (forced())
      block = Math.max(block, defenseScore(t) * (opponents.length > 1 ? 0.05 : 1));
      const u = urgency(cells, size, at, o);
      stop = Math.max(stop, u);
      if (k === 0) stopNext = u;
      if (u === 3) fiveFor.push(k);
    });
    const x = at % size;
    const y = Math.floor(at / size);
    const c = (size - 1) / 2;
    const centre = 4 - (Math.abs(x - c) + Math.abs(y - c)) / size;
    const attack = threatScore(mine) + centre;
    return { at, score: attack + block * defend, attack, win: mine.five > 0, stop, stopNext, fiveFor };
  });
}

/**
 * the forced part: win now, else stop a five, else make an open four, else stop an open three (Normal now and then
 * misses that). With 3–4 players a five is stopped when the players in between can't stop all of that player's
 */
function forced(list: Scored[], sloppy: boolean, many: boolean, rand: () => number): Scored | null {
  const best = (xs: Scored[]) => xs.sort((a, b) => b.score - a.score)[0] ?? null;
  const win = list.find((s) => s.win);
  if (win) return win;
  const fives = new Map<number, number>();
  for (const s of list) for (const k of s.fiveFor) fives.set(k, (fives.get(k) ?? 0) + 1);
  const must = (s: Scored) => s.fiveFor.some((k) => !many || ((fives.get(k) ?? 0) > k && !(sloppy && k > 0 && rand() < 0.5)));
  return best(list.filter(must)) ?? best(list.filter((s) => s.attack >= 100_000)) ?? (sloppy || many ? null : best(list.filter((s) => s.stop === 2)));
}

// empty points on seat's lines through p where seat would make five
function completions(cells: Int8Array, size: number, p: number, seat: number): number[] {
  const out = new Set<number>();
  const x0 = p % size;
  const y0 = Math.floor(p / size);
  for (const [dx, dy] of DIRS) {
    for (let k = -4; k <= 4; k++) {
      const x = x0 + dx * k;
      const y = y0 + dy * k;
      const q = y * size + x;
      if (k && x >= 0 && y >= 0 && x < size && y < size && cells[q] === -1 && threatAt(cells, size, q, seat).five) out.add(q);
    }
  }
  return [...out];
}

/** two players: a win by fours in a row (each one answered by the only block), as its first point, or null */
export function vcf(cells: Int8Array, size: number, me: number, foe: number, depth: number, budget: { n: number }): number | null {
  if (depth === 0 || --budget.n < 0) return null;
  for (const p of candidates(cells, size)) {
    const t = threatAt(cells, size, p, me);
    if (t.five) return p;
    if (!t.four && !t.openFour) continue;
    cells[p] = me;
    const wins = completions(cells, size, p, me);
    let ok = wins.length >= 2;
    if (wins.length === 1 && !threatAt(cells, size, wins[0], foe).five) {
      const q = wins[0];
      cells[q] = foe;
      // their forced block must not make them a four we'd have to answer
      ok = completions(cells, size, q, foe).length === 0 && vcf(cells, size, me, foe, depth - 1, budget) !== null;
      cells[q] = -1;
    }
    cells[p] = -1;
    if (ok) return p;
  }
  return null;
}

/** a bot's stone: always wins and stops fours; Normal greedy with noise, Hard greedy, Expert adds a threat search (2 players) */
export function decide(g: GomokuGame, botId: string, level: BotLevel, rand: () => number): GomokuMoveInput {
  const seat = g.seatOf(botId);
  const opponents = g.othersAfter(botId).map((o) => g.seatOf(o));
  const list = scoreAll(g.cells, g.size, seat, opponents, opponents.length > 1 ? 0.6 : 0.9);
  if (list.length === 1) return { type: 'place', at: list[0].at };
  const must = forced(list, level === 'normal' && rand() < 0.15, opponents.length > 1, rand);
  if (must) return { type: 'place', at: must.at };
  const noise = level === 'normal' ? 0.35 : level === 'hard' ? 0.08 : 0;
  const ranked = list.map((s) => ({ ...s, v: s.score * (1 + noise * (rand() * 2 - 1)) })).sort((a, b) => b.v - a.v);
  if (level === 'expert' && opponents.length === 1) {
    const cells = Int8Array.from(g.cells);
    // a forced win by fours, else the best move that leaves them none
    const win = vcf(cells, g.size, seat, opponents[0], 8, { n: 400 });
    if (win !== null) return { type: 'place', at: win };
    // a shallow min-max on forced wins: the best move after which they have no win by fours
    for (const s of ranked.slice(0, 6)) {
      cells[s.at] = seat;
      const lost = vcf(cells, g.size, opponents[0], seat, 6, { n: 150 }) !== null;
      cells[s.at] = -1;
      if (!lost) return { type: 'place', at: s.at };
    }
    const best = ranked[0];
    return { type: 'place', at: best.at };
  }
  return { type: 'place', at: ranked[0].at };
}
