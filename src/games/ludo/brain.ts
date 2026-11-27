import { LUDO_BASE, LUDO_HOME, LUDO_LAST_RING, LUDO_RING, ludoIsSafe, ludoRingOf, type BotLevel, type LudoMoveInput, type LudoSeat } from '../../types.js';
import type { LudoGame } from './game.js';

type Rand = () => number;

/** how often a Hard bot picks any goti instead of its best */
const HARD_SLIP = 0.2;

/** what one goti move does */
interface MoveFacts {
  token: number;
  from: number;
  to: number;
  /** progress of each opponent goti it knocks off */
  victims: number[];
  home: boolean;
  lane: boolean;
  safe: boolean;
  open: boolean;
  /** chance of being knocked off before / after the move (0..1) */
  riskBefore: number;
  riskAfter: number;
  /** a partner's goti under threat from a goti this move knocks off */
  savesPartner: boolean;
}

/** chance an opponent lands on this ring square next turn: 1/6 for each goti 1..6 behind, 1/36 for 7..12 (a 6 first); deep: count the 6+n ones too */
export function riskAt(g: LudoGame, side: string, ring: number, deep: boolean, skip: { seat: LudoSeat; token: number }[] = []): number {
  if (ludoIsSafe(ring)) return 0;
  let safe = 1;
  for (const s of g.seats) {
    if (s.playerId === side || g.partnerOf(side) === s.playerId || g.isOut(s.playerId)) continue;
    let base = false;
    s.tokens.forEach((q, k) => {
      if (skip.some((x) => x.seat === s && x.token === k)) return;
      if (q <= LUDO_BASE) {
        base = true;
        return;
      }
      if (q > LUDO_LAST_RING) return;
      const d = (ring - ludoRingOf(s.color, q)! + LUDO_RING) % LUDO_RING;
      if (d === 0 || q + d > LUDO_LAST_RING) return;
      if (d <= 6) safe *= 5 / 6;
      else if (deep && d <= 12) safe *= 35 / 36;
    });
    // a goti in base comes out with a 6 and then moves on
    if (base && deep) {
      const d = (ring - ludoRingOf(s.color, 0)! + LUDO_RING) % LUDO_RING;
      if (d >= 1 && d <= 6) safe *= 35 / 36;
    }
  }
  return 1 - safe;
}

function factsOf(g: LudoGame, id: string, seat: LudoSeat, token: number, roll: number, deep: boolean): MoveFacts {
  const from = seat.tokens[token];
  const to = from <= LUDO_BASE ? 0 : from + roll;
  const ring = ludoRingOf(seat.color, to);
  const victims: number[] = [];
  const knocked: { seat: LudoSeat; token: number }[] = [];
  let savesPartner = false;
  if (ring !== null && !ludoIsSafe(ring)) {
    for (const s of g.seats) {
      if (s.playerId === seat.playerId || g.partnerOf(seat.playerId) === s.playerId) continue;
      s.tokens.forEach((q, k) => {
        if (ludoRingOf(s.color, q) !== ring) return;
        victims.push(q);
        knocked.push({ seat: s, token: k });
      });
    }
  }
  // 2v2: a partner's goti 1..6 ahead of a goti we knock off is safer afterwards
  const partner = g.partnerOf(id);
  if (partner && knocked.length > 0) {
    const ps = g.seatOf(partner);
    savesPartner = ps.tokens.some((q) => {
      const pr = ludoRingOf(ps.color, q);
      if (pr === null || ludoIsSafe(pr)) return false;
      const d = (pr - ring! + LUDO_RING) % LUDO_RING;
      return d >= 1 && d <= 6;
    });
  }
  const fromRing = ludoRingOf(seat.color, from);
  return {
    token,
    from,
    to,
    victims,
    home: to === LUDO_HOME,
    lane: from <= LUDO_LAST_RING && to > LUDO_LAST_RING,
    safe: ring !== null && ludoIsSafe(ring),
    open: from <= LUDO_BASE,
    riskBefore: fromRing === null ? 0 : riskAt(g, seat.playerId, fromRing, deep),
    riskAfter: ring === null ? 0 : riskAt(g, seat.playerId, ring, deep, knocked),
    savesPartner,
  };
}

/** Hard: greedy points for what a move does */
function hardScore(f: MoveFacts, locked: boolean): number {
  let n = 0;
  for (const v of f.victims) n += 50 + v + (locked ? 30 : 0);
  if (f.home) n += 40;
  if (f.lane) n += 25;
  if (f.safe) n += 12;
  if (f.open) n += 20;
  if (f.riskBefore > 0) n += 18;
  if (f.riskAfter > 0) n -= 22;
  return n + f.to / 10;
}

/** opponent gotis 1..6 squares ahead of a ring square, by what they've covered: a target for the next roll */
function preyAt(g: LudoGame, side: string, ring: number): number {
  let n = 0;
  for (const s of g.seats) {
    if (s.playerId === side || g.partnerOf(side) === s.playerId || g.isOut(s.playerId)) continue;
    for (const q of s.tokens) {
      const r = ludoRingOf(s.color, q);
      if (r === null || ludoIsSafe(r)) continue;
      const d = (r - ring + LUDO_RING) % LUDO_RING;
      if (d >= 1 && d <= 6) n += (q + 15) / 6;
    }
  }
  return n;
}

/** weights of the Expert's extra terms: kill per square and flat, home, lane per square, opening (none out / some out), stake base, risk, prey */
const W = [1.2, 25, 10, 0.3, 25, 24, 10, 1.5, 0.5] as const;

/** Expert, on top of Hard: the move's worth in squares, weighed by the real chance of losing a goti before and after, and gotis it can hunt next */
function expertScore(g: LudoGame, f: MoveFacts, seat: LudoSeat, locked: boolean, w: readonly number[] = W): number {
  const from = Math.max(0, f.from);
  let n = f.to - from;
  for (const v of f.victims) n += v * w[0] + w[1] + (locked ? 30 : 0);
  if (f.home) n += w[2];
  // the lane is out of reach for good
  if (f.lane) n += f.to * w[3];
  const onBoard = seat.tokens.filter((p) => p >= 0 && p < LUDO_HOME).length;
  if (f.open) n += onBoard === 0 ? w[4] : w[5];
  n += f.riskBefore * (from + w[6]) * w[7];
  n -= f.riskAfter * (f.to + w[6]) * w[7];
  const ring = ludoRingOf(seat.color, f.to);
  if (ring !== null && f.riskAfter < 0.3) n += preyAt(g, seat.playerId, ring) * w[8];
  if (f.savesPartner) n += 15;
  return n;
}

/** a bot's move: roll, or pick a goti by its level */
export function decide(g: LudoGame, id: string, level: BotLevel, rand: Rand = Math.random): LudoMoveInput {
  if (!g.rolled) return { type: 'roll' };
  const moves = g.movable();
  if (moves.length <= 1) return { type: 'move', token: moves[0] ?? 0 };
  const seat = g.moverOf(id);
  const roll = g.dice!;
  const deep = level === 'expert';
  const facts = moves.map((t) => factsOf(g, id, seat, t, roll, deep));
  if (level === 'normal') {
    const kills = facts.filter((f) => f.victims.length > 0);
    const pool = kills.length > 0 && rand() < 0.35 ? kills : facts;
    return { type: 'move', token: pool[Math.floor(rand() * pool.length)].token };
  }
  const locked = g.mode === 'master' && !seat.unlocked;
  // Hard slips now and then; Expert never does
  if (level === 'hard' && rand() < HARD_SLIP) return { type: 'move', token: facts[Math.floor(rand() * facts.length)].token };
  const scored = facts.map((f) => ({ f, n: hardScore(f, locked) + (level === 'expert' ? expertScore(g, f, seat, locked) : 0) }));
  const best = Math.max(...scored.map((s) => s.n));
  const top = scored.filter((s) => s.n >= best - 1e-9);
  return { type: 'move', token: top[Math.floor(rand() * top.length)].f.token };
}
