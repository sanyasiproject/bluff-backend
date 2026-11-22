import type { GameEvent } from '../models.js';
import type { Room } from '../rooms.js';
import type { RangGame } from './game.js';

type Timer = ReturnType<typeof setTimeout>;

/** Rang's game time: when it runs out the game ends and everyone is ranked by the points they hold */
export class RangClock {
  private timers = new Map<Room, { timer: Timer; game: RangGame }>();

  constructor(
    private readonly onMove: (room: Room, events: GameEvent[]) => void,
    private readonly isOpen: (room: Room) => boolean,
  ) {}

  /** after any change: arm the timer once for this game, or drop it once the game is gone */
  wake(room: Room): void {
    const g = room.rang;
    const cur = this.timers.get(room);
    if (cur && cur.game === g && g && !g.over) return;
    if (cur) this.forget(room);
    if (!g || g.over || g.endsAt === null) return;
    const timer = setTimeout(() => {
      this.timers.delete(room);
      if (room.rang !== g || g.over || !this.isOpen(room)) return;
      this.onMove(room, g.timeUp());
    }, Math.max(0, g.endsAt - Date.now()));
    timer.unref?.();
    this.timers.set(room, { timer, game: g });
  }

  forget(room: Room): void {
    const cur = this.timers.get(room);
    if (cur) clearTimeout(cur.timer);
    this.timers.delete(room);
  }

  prune(): void {
    for (const room of [...this.timers.keys()]) if (!this.isOpen(room)) this.forget(room);
  }

  stop(): void {
    for (const room of [...this.timers.keys()]) this.forget(room);
  }
}
