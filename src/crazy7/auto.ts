import type { GameEvent } from '../models.js';
import type { Room } from '../rooms.js';

type Timer = ReturnType<typeof setTimeout>;

/** pause before each automatic step, by kind (ms at speed 1) */
const PACE = {
  /** the turn just arrived: let people see whose turn it is before the card is picked */
  pick: [1100, 1500],
  /** a moment to see the picked card didn't help */
  pass: [800, 1100],
  /** a 7's pick, or the penalty for not saying last card */
  penalty: [1100, 1500],
} as const;

/**
 * Plays Crazy 7's automatic steps (a pick when nothing matches, a turn that passes by itself, a 7's pick with stacking off,
 * the missed-last-card penalty) one at a time with a human pause, so the table can follow them instead of seeing them all at once.
 */
export class Crazy7Auto {
  private pending = new Map<Room, { timer: Timer; key: string }>();

  constructor(
    private readonly onMove: (room: Room, events: GameEvent[]) => void,
    private readonly isOpen: (room: Room) => boolean,
    /** 1 = human pace; tests use a small number */
    private readonly speed = 1,
    private readonly rand: () => number = Math.random,
  ) {}

  /** after any change: schedule the next automatic step if one is due */
  wake(room: Room): void {
    const g = room.c7;
    const due = !!g && g.autoDue && this.isOpen(room) && room.members.some((m) => !m.bot && m.socketId !== null);
    const key = g ? `${g.moveSeq}|${g.turnSeq}` : '';
    const cur = this.pending.get(room);
    if (cur && (!due || cur.key !== key)) {
      clearTimeout(cur.timer);
      this.pending.delete(room);
    }
    if (!due || this.pending.has(room)) return;
    const timer = setTimeout(() => {
      this.pending.delete(room);
      if (room.c7 !== g || !g.autoDue || !this.isOpen(room)) return;
      const events = g.stepAuto();
      if (events.length > 0) this.onMove(room, events);
    }, this.pause(g) * this.speed);
    this.pending.set(room, { timer, key });
  }

  forget(room: Room): void {
    const cur = this.pending.get(room);
    if (cur) clearTimeout(cur.timer);
    this.pending.delete(room);
  }

  prune(): void {
    for (const room of [...this.pending.keys()]) if (!this.isOpen(room)) this.forget(room);
  }

  stop(): void {
    for (const room of [...this.pending.keys()]) this.forget(room);
  }

  private pause(g: NonNullable<Room['c7']>): number {
    const id = g.turnId;
    const kind = id && (g.missed.has(id) || g.penalty > 0) ? 'penalty' : g.picks === 0 ? 'pick' : 'pass';
    const [lo, hi] = PACE[kind];
    return lo + this.rand() * (hi - lo);
  }
}
