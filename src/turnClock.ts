import { fallback, seatView } from './crazy7/brain.js';
import { GameError } from './game.js';
import type { GameEvent } from './models.js';
import type { Room } from './rooms.js';
import { claimsAllowed, RANG_COLORS, TURN_TIMER, type Announcement, type Card, type Rank } from './types.js';

type Timer = ReturnType<typeof setTimeout>;

/** hidden time after the shown clock runs out, so a server or network pause of up to 5 s never costs anyone their turn */
export const TURN_GRACE_MS = 5_000;
/** the timer fired this late: the server itself was stuck and moves sent meanwhile may still be queued, so it waits one more grace */
const LATE_MS = 1_500;

/** the turn the clock runs for: a person's turn in a game on, with someone connected; null otherwise */
function dueTurn(room: Room): { key: string; playerId: string } | null {
  if (!room.config.turnTimer) return null;
  const g = room.table;
  if (!g || g.over || !g.turnId || room.isBot(g.turnId)) return null;
  if (!room.members.some((m) => !m.bot && m.socketId !== null)) return null;
  if (room.rang) {
    // Rang's automatic picks and passes play themselves too
    if (room.rang.autoDue) return null;
    return { key: `rg|${room.rang.moveSeq}|${room.rang.turnSeq}`, playerId: g.turnId };
  }
  if (room.c7) {
    // Crazy 7's automatic picks and passes play themselves
    if (room.c7.autoDue) return null;
    return { key: `c7|${room.c7.moveSeq}|${room.c7.turnSeq}`, playerId: g.turnId };
  }
  const b = room.game!;
  const cards = [...b.hands.values()].reduce((n, h) => n + h.length, 0);
  return { key: ['b', b.lastPlay?.id ?? '-', b.turnId, b.roundRank ?? '-', b.passed.size, b.pile.length, b.places.length, cards].join('|'), playerId: g.turnId };
}

/** Bluff: pass when allowed, else one card said truthfully when it can be */
function bluffMove(room: Room, id: string): GameEvent[] {
  const g = room.game!;
  if (g.lastPlay) {
    try {
      return g.pass(id);
    } catch (err) {
      if (!(err instanceof GameError)) throw err;
    }
  }
  const hand = g.hand(id);
  const claims: readonly Rank[] = g.roundRank ? claimsAllowed(g.roundRank, g.config.seedhi) : [];
  if (claims.length === 0) return g.play(id, [hand[0].id], hand[0].rank);
  const honest = (c: Card) => claims.find((r) => g.backs(c, r));
  const card = hand.find((c) => honest(c)) ?? hand[0];
  return g.play(id, [card.id], honest(card) ?? claims[0]);
}

/** Crazy 7: a matching card (saying last card), else pick, else pass */
function crazy7Move(room: Room, id: string): GameEvent[] {
  const g = room.c7!;
  const view = seatView(room.view(id));
  if (!view) return [];
  const action = fallback(view);
  const events: GameEvent[] = [];
  if (action.kind === 'play') {
    if (g.hand(id).length === 2 && g.canCall(id)) events.push(...g.call(id));
    events.push(...g.play(id, action.cardId, action.suit));
    if (g.atRisk === id && g.canCall(id)) events.push(...g.call(id));
  } else if (action.kind === 'pick') {
    events.push(...g.pick(id));
  } else {
    events.push(...g.pass(id));
  }
  return events;
}

/** Rang: a card that fits (a wild names the colour held most, a 7 swaps with the smallest hand), else pick, else pass */
function rangMove(room: Room, id: string): GameEvent[] {
  const g = room.rang!;
  const events: GameEvent[] = [];
  const legal = g.playable(id);
  if (legal.length > 0) {
    const hand = g.hand(id);
    const card = legal.find((c) => c.color !== null) ?? legal[0];
    const most = RANG_COLORS.reduce((best, c) => (hand.filter((x) => x.color === c).length > hand.filter((x) => x.color === best).length ? c : best), RANG_COLORS[0]);
    const others = g.order.filter((p) => p !== id && g.hand(p).length > 0);
    const smallest = others.reduce<string | undefined>((best, p) => (!best || g.hand(p).length < g.hand(best).length ? p : best), undefined);
    const swap = g.config.rangSwap && card.value === '7' && hand.length > 1;
    if (hand.length === 2 && g.canCall(id)) events.push(...g.call(id));
    events.push(...g.play(id, card.id, { color: card.color === null ? most : undefined, targetId: swap ? smallest : undefined }));
    if (g.atRisk === id && g.canCall(id)) events.push(...g.call(id));
  } else if (g.canPick(id)) {
    events.push(...g.pick(id));
  } else {
    events.push(...g.pass(id));
  }
  return events;
}

/**
 * The turn timer (a room setting): each person's turn shows config.turnSec (awaySec once they're away). The server acts only
 * TURN_GRACE_MS after the shown clock ends, and waits again if its own timer fired late, so a short server stall never skips a turn.
 */
export class TurnClock {
  private timers = new Map<Room, Timer>();

  constructor(
    private readonly onMove: (room: Room, events: GameEvent[], notes: Announcement[]) => void,
    private readonly isOpen: (room: Room) => boolean,
    /** 1 = real seconds; tests use a small number */
    private readonly speed = 1,
    /** the bot brain's move for a person whose time ran out; [] falls back to a plain safe move */
    private readonly brain: (room: Room, id: string) => GameEvent[] = () => [],
  ) {}

  /** after any change, before the room's views go out: start a fresh clock for a new turn, keep the running one, or stop */
  wake(room: Room): void {
    const due = this.isOpen(room) ? dueTurn(room) : null;
    if (!due) {
      this.forget(room);
      return;
    }
    if (room.turnClock?.key === due.key && this.timers.has(room)) return;
    this.clearTimer(room);
    const sec = room.isAway(due.playerId) ? TURN_TIMER.awaySec : (room.config.turnSec ?? TURN_TIMER.turnSec);
    room.turnClock = { ...due, endsAt: Date.now() + sec * 1000 * this.speed };
    this.schedule(room, room.turnClock.endsAt + TURN_GRACE_MS * this.speed);
  }

  forget(room: Room): void {
    this.clearTimer(room);
    room.turnClock = null;
  }

  prune(): void {
    for (const room of [...this.timers.keys()]) if (!this.isOpen(room)) this.forget(room);
  }

  stop(): void {
    for (const room of [...this.timers.keys()]) this.forget(room);
  }

  private schedule(room: Room, at: number): void {
    this.timers.set(room, setTimeout(() => this.fire(room, at), Math.max(0, at - Date.now())));
  }

  private clearTimer(room: Room): void {
    const t = this.timers.get(room);
    if (t) clearTimeout(t);
    this.timers.delete(room);
  }

  private fire(room: Room, at: number): void {
    this.timers.delete(room);
    const clock = room.turnClock;
    if (!clock || !this.isOpen(room) || dueTurn(room)?.key !== clock.key) return;
    // fired late: the server was stuck, so queued moves get a chance to land first
    if (Date.now() - at > LATE_MS * this.speed) {
      this.schedule(room, Date.now() + TURN_GRACE_MS * this.speed);
      return;
    }
    const id = clock.playerId;
    let events: GameEvent[];
    try {
      events = this.brain(room, id);
      if (events.length === 0) events = room.rang ? rangMove(room, id) : room.c7 ? crazy7Move(room, id) : bluffMove(room, id);
    } catch (err) {
      console.error('[turn timer] auto move failed:', (err as Error).message);
      return;
    }
    const wasAway = room.isAway(id);
    room.turnMisses.set(id, (room.turnMisses.get(id) ?? 0) + 1);
    const name = room.members.find((m) => m.id === id)?.name ?? 'Someone';
    const notes = [room.note('room', `⏰ ${name} ran out of time`)];
    if (!wasAway && room.isAway(id)) notes.push(room.note('room', `💤 ${name} is away: short turns until they play`));
    room.turnClock = null;
    this.onMove(room, events, notes);
  }
}
