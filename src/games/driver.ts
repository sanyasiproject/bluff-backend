import { GameError } from '../game.js';
import type { GameEvent } from '../models.js';
import type { Room } from '../rooms.js';
import { chatSetOf, isPlugged, type ChatEvent } from '../types.js';
import { moduleOf } from './registry.js';
import type { GameModule, PluggedGame } from './module.js';

/** what the socket layer does with a bot's or an automatic step, the same as with a person's */
export interface PluggedHooks {
  onMove(room: Room, events: GameEvent[]): void;
  onChat(room: Room, chat: ChatEvent): void;
}

type Timer = ReturnType<typeof setTimeout>;

/** a bot's pause before rolling, and before picking a goti once it has rolled (ms at speed 1) */
const THINK = { roll: [800, 1600], move: [700, 1300] } as const;

// lines a bot may say after big moments
const LINES = {
  hunted: ['Kaat diya! 😈', 'Sorry, kaatna pada 😅', 'Hehe, phir se kaat diya 😜'],
  hit: ['Please mera goti mat kaato 🥺', 'Arre yaar, mera goti! 😭', 'Agli baari tu gaya 😏'],
  won: ['Main jeet raha hoon 🏆', 'GG 🎉'],
  gameOver: ['GG 🎉', 'Ek aur game! 🔁'],
} as const;

/** the registry game on in this room, with its module; null for Bluff, Crazy 7 and Rang */
function pluggedOf(room: Room): { g: PluggedGame; mod: GameModule<PluggedGame> } | null {
  const g = room.plugged;
  if (!g || !isPlugged(g.config.game)) return null;
  return { g, mod: moduleOf(g.config.game) };
}

/**
 * One driver for every registry game: plays its automatic steps (no choice to make) and its bots at a human pace,
 * ends a timed game when time runs out, and plays a person's turn when their turn timer runs out.
 */
export class PluggedDriver {
  private steps = new Map<Room, { key: string; timer: Timer }>();
  private clocks = new Map<Room, { game: PluggedGame; timer: Timer }>();
  private chatTimers = new Map<Room, Set<Timer>>();

  constructor(
    private readonly hooks: PluggedHooks,
    private readonly isOpen: (room: Room) => boolean,
    /** 1 = human pace; tests use a small number */
    private readonly speed = 1,
    private readonly rand: () => number = Math.random,
  ) {}

  /** after any change: arm the game clock, then plan the next automatic step or bot move */
  wake(room: Room): void {
    if (!this.isOpen(room)) return this.forget(room);
    this.armClock(room);
    const p = pluggedOf(room);
    // bots and automatic steps wait while no person is connected
    if (!p || p.g.over || !this.someoneHere(room)) return this.cancel(room);
    const { g, mod } = p;
    const key = mod.turnKey(g);
    if (this.steps.get(room)?.key === key) return;
    this.cancel(room);
    const auto = mod.auto(g);
    if (auto) {
      this.schedule(room, key, auto.delayMs, () => {
        const events = auto.run();
        // a real-time game's step that changed nothing: plan the next one without sending views
        if (auto.quiet && events.length === 0) this.wake(room);
        else this.hooks.onMove(room, events);
      });
      return;
    }
    const id = g.turnId;
    if (!id || !room.isBot(id)) return;
    const move = mod.botMove(g, id, g.config.botLevel, this.rand);
    const [lo, hi] = (move as { type?: string }).type === 'roll' ? THINK.roll : THINK.move;
    this.schedule(room, key, lo + this.rand() * (hi - lo), () => this.play(room, g, mod, id, move));
  }

  /** every bot at the table may react to what just happened */
  observe(room: Room, events: GameEvent[]): void {
    if (!room.plugged || events.length === 0) return;
    const bots = room.members.filter((m) => m.bot).map((m) => m.id);
    if (bots.length === 0) return;
    const say = (id: string, lines: readonly string[], odds: number) => {
      if (bots.includes(id) && this.rand() < odds) this.say(room, id, lines);
    };
    for (const e of events) {
      if (e.kind === 'ludo' && e.ev.type === 'move' && e.ev.captured.length > 0) {
        say(e.ev.playerId, LINES.hunted, 0.3);
        for (const c of e.ev.captured) say(c.playerId, LINES.hit, 0.3);
      } else if (e.kind === 'snakes' && e.ev.type === 'move' && e.ev.move.bitten.length > 0) {
        say(e.ev.move.playerId, LINES.hunted, 0.3);
        for (const b of e.ev.move.bitten) say(b.playerId, LINES.hit, 0.3);
      } else if (e.kind === 'finish' && e.place === 1) say(e.playerId, LINES.won, 0.5);
      else if (e.kind === 'gameOver') say(bots[Math.floor(this.rand() * bots.length)], LINES.gameOver, 0.4);
    }
  }

  /** a person's turn timer ran out: the Hard bot brain plays their step; [] if nothing worked */
  playFor(room: Room, id: string): GameEvent[] {
    const p = pluggedOf(room);
    if (!p || p.g.over || p.g.turnId !== id || p.mod.auto(p.g)) return [];
    try {
      return p.mod.move(p.g, id, p.mod.botMove(p.g, id, 'hard', this.rand));
    } catch (err) {
      if (!(err instanceof GameError)) console.error('[games] stand-in move failed:', err);
      return [];
    }
  }

  forget(room: Room): void {
    this.cancel(room);
    const c = this.clocks.get(room);
    if (c) clearTimeout(c.timer);
    this.clocks.delete(room);
    for (const t of this.chatTimers.get(room) ?? []) clearTimeout(t);
    this.chatTimers.delete(room);
  }

  /** lets go of rooms that closed without a word */
  prune(): void {
    const rooms = new Set([...this.steps.keys(), ...this.clocks.keys(), ...this.chatTimers.keys()]);
    for (const room of rooms) if (!this.isOpen(room)) this.forget(room);
  }

  stop(): void {
    for (const room of new Set([...this.steps.keys(), ...this.clocks.keys(), ...this.chatTimers.keys()])) this.forget(room);
  }

  private play(room: Room, g: PluggedGame, mod: GameModule<PluggedGame>, id: string, move: unknown): void {
    if (!this.live(room, g) || g.turnId !== id) return;
    try {
      this.hooks.onMove(room, mod.move(g, id, move));
    } catch (err) {
      // planned for a moment that passed; the next wake plans again
      if (!(err instanceof GameError)) console.error('[games] bot move failed:', err);
    }
  }

  private schedule(room: Room, key: string, ms: number, run: () => void): void {
    const g = room.plugged;
    const timer = setTimeout(() => {
      if (this.steps.get(room)?.timer === timer) this.steps.delete(room);
      if (!g || !this.live(room, g) || pluggedOf(room)?.mod.turnKey(g) !== key) return;
      run();
    }, ms * this.speed);
    this.steps.set(room, { key, timer });
  }

  /** the game clock, armed once per game */
  private armClock(room: Room): void {
    const p = pluggedOf(room);
    const cur = this.clocks.get(room);
    if (cur && p && cur.game === p.g && !p.g.over) return;
    if (cur) clearTimeout(cur.timer);
    this.clocks.delete(room);
    const clock = p && !p.g.over ? p.mod.clock(p.g) : null;
    if (!p || !clock) return;
    const timer = setTimeout(() => {
      this.clocks.delete(room);
      if (room.plugged !== p.g || p.g.over || !this.isOpen(room)) return;
      this.hooks.onMove(room, clock.run());
    }, Math.max(0, clock.endsAt - Date.now()));
    timer.unref?.();
    this.clocks.set(room, { game: p.g, timer });
  }

  private say(room: Room, id: string, lines: readonly string[]): void {
    const timers = this.chatTimers.get(room) ?? new Set<Timer>();
    this.chatTimers.set(room, timers);
    const t = setTimeout(() => {
      timers.delete(t);
      if (!this.isOpen(room) || !room.members.some((m) => m.id === id)) return;
      // now and then an emoji instead of words
      const asEmoji = this.rand() < 0.3;
      // the table's own lists (Ludo has its own)
      const set = chatSetOf(room.config.game);
      const index = asEmoji ? Math.floor(this.rand() * set.reactions.length) : set.messages.indexOf(lines[Math.floor(this.rand() * lines.length)]);
      if (index < 0) return;
      try {
        this.hooks.onChat(room, room.chat(id, asEmoji ? 'reaction' : 'message', index));
      } catch {
        // too soon after its last message
      }
    }, (500 + this.rand() * 1300) * this.speed);
    timers.add(t);
  }

  private live(room: Room, g: PluggedGame): boolean {
    return this.isOpen(room) && room.plugged === g && !g.over && this.someoneHere(room);
  }

  private someoneHere(room: Room): boolean {
    return room.members.some((m) => !m.bot && m.socketId !== null);
  }

  private cancel(room: Room): void {
    const cur = this.steps.get(room);
    if (cur) clearTimeout(cur.timer);
    this.steps.delete(room);
  }
}
