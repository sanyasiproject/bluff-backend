import { GameError } from '../game.js';
import type { GameEvent } from '../models.js';
import type { Room } from '../rooms.js';
import { QUICK_MESSAGES, REACTIONS, type ChatEvent } from '../types.js';
import type { Crazy7Action, Crazy7Personality, Rand } from './bot-models.js';
import { decide, fallback, makePersonality, pickStyle, seatView } from './brain.js';
import type { Crazy7Game } from './game.js';
import { Crazy7Memory } from './memory.js';

/** what the socket layer does with a bot's moves, the same as with a person's */
export interface Crazy7BotHooks {
  onMove(room: Room, events: GameEvent[]): void;
  onChat(room: Room, chat: ChatEvent): void;
}

type Timer = ReturnType<typeof setTimeout>;

/** a person who just went down to one card gets this long to say "last card" before a bot moves on */
const LAST_CALL_GRACE_MS = 3500;

/** chance a bot forgets to say "last card" before playing its second-last card, by style; it may say it late and get caught */
const FORGET: Record<string, number> = { hunter: 0.06, guardian: 0.03, switcher: 0.08, counter: 0.02 };

interface Seat {
  id: string;
  me: Crazy7Personality;
  mem: Crazy7Memory | null;
  game: Crazy7Game | null;
  timer: Timer | null;
  /** the table state a planned move was planned for */
  key: string | null;
  callTimer: Timer | null;
  /** forgot to say "last card" with its second-last card */
  forgot?: boolean;
}

// lines a bot may say after big moments
const LINES = {
  fired: ['Ab tu gaya 😈', 'Bhai tu toh gaya kaam se 💀', 'Kya chaal hai! 🔥'],
  stacked: ['Nice try 😏', 'Bach gaya! 😅', 'Kya chaal hai! 🔥'],
  hit: ['Kismat kharab hai yaar 🤦', 'Bas kar bhai 😂', 'Patte dekh ke rona aa gaya 😭'],
  caught: ['Hasna mana hai 🤐', 'Bas kar bhai 😂', 'Nice try 😏'],
  won: ['Aaj meri raat hai 😎', 'GG 🎉'],
  gameOver: ['GG 🎉', 'Ek aur round! 🔁'],
} as const;
const lineIndex = (text: string) => (QUICK_MESSAGES as readonly string[]).indexOf(text);

/** changes with every move; a planned move is dropped if the table moved on */
const tableKey = (g: Crazy7Game) => `${g.moveSeq}|${g.turnId}|${g.penalty}|${g.picks}`;

/** plays every Crazy 7 bot in every room: thinks at a human pace, acts through the same game rules */
export class Crazy7Bots {
  private tables = new Map<Room, Map<string, Seat>>();
  private chatTimers = new Map<Room, Set<Timer>>();

  constructor(
    private readonly hooks: Crazy7BotHooks,
    private readonly isOpen: (room: Room) => boolean,
    /** 1 = human pace; tests use a small number */
    private readonly speed = 1,
    private readonly rand: Rand = Math.random,
  ) {}

  /** every bot at the table remembers what just happened */
  observe(room: Room, events: GameEvent[]): void {
    const g = room.c7;
    const seats = this.seats(room);
    if (!g || events.length === 0 || seats.size === 0) return;
    for (const seat of seats.values()) if (g.order.includes(seat.id)) this.memoryOf(seat, g).observe(events);
    this.react(room, seats, events);
  }

  /** after any change: plan what each bot does next */
  wake(room: Room): void {
    if (!this.isOpen(room)) return this.forget(room);
    const seats = this.seats(room);
    if (seats.size === 0) return;
    const g = room.c7;
    // bots wait while no person is connected, so nobody comes back to a game played without them
    if (!g || g.over || !this.someoneHere(room)) {
      for (const seat of seats.values()) this.cancel(seat);
      return;
    }
    const key = tableKey(g);
    for (const seat of seats.values()) {
      if (!g.order.includes(seat.id) || g.hand(seat.id).length === 0) {
        this.cancel(seat);
        continue;
      }
      this.memoryOf(seat, g);
      // down to one card without saying it (it always says it before playing, so only as a safety net)
      if (g.atRisk === seat.id && !seat.callTimer) {
        // a bot that forgot remembers a little late, so a quick player can catch it
        const late = seat.forgot ? 1500 + this.rand() * 3000 : 300 + this.rand() * 400;
        seat.callTimer = setTimeout(() => this.sayLastCard(room, seat, g), late * this.speed);
      }
      if (g.turnId !== seat.id) {
        this.clearTurn(seat);
        continue;
      }
      if (seat.key === key) continue;
      this.clearTurn(seat);
      seat.key = key;
      seat.timer = setTimeout(() => this.turn(room, seat, g, key), this.thinkMs(seat, g, room));
    }
  }

  forget(room: Room): void {
    for (const seat of this.tables.get(room)?.values() ?? []) this.cancel(seat);
    for (const t of this.chatTimers.get(room) ?? []) clearTimeout(t);
    this.tables.delete(room);
    this.chatTimers.delete(room);
  }

  /** lets go of rooms that closed without a word */
  prune(): void {
    for (const room of [...this.tables.keys()]) if (!this.isOpen(room)) this.forget(room);
  }

  stop(): void {
    for (const room of [...this.tables.keys()]) this.forget(room);
  }

  private turn(room: Room, seat: Seat, g: Crazy7Game, key: string): void {
    seat.timer = null;
    // planned for this moment only; whatever happens next gets planned afresh
    seat.key = null;
    if (!this.live(room, g) || tableKey(g) !== key || g.turnId !== seat.id) return;
    const view = seatView(room.view(seat.id));
    if (!view) return;
    const mem = this.memoryOf(seat, g);
    mem.sync(view.c7);
    let action: Crazy7Action;
    try {
      action = decide({ view, mem, me: seat.me, rand: this.rand });
    } catch (err) {
      console.error('[crazy7 bots] decision failed:', (err as Error).message);
      action = fallback(view);
    }
    if (this.apply(room, seat, g, action)) return;
    const again = seatView(room.view(seat.id));
    if (again && this.live(room, g) && g.turnId === seat.id) this.apply(room, seat, g, fallback(again));
  }

  /** runs a move through the rules, saying "last card" with the second-last card. False if refused */
  private apply(room: Room, seat: Seat, g: Crazy7Game, action: Crazy7Action): boolean {
    try {
      const events: GameEvent[] = [];
      if (action.kind === 'play') {
        seat.forgot = g.hand(seat.id).length === 2 && this.rand() < (FORGET[seat.me.style] ?? 0.04);
        if (g.hand(seat.id).length === 2 && g.canCall(seat.id) && !seat.forgot) events.push(...g.call(seat.id));
        events.push(...g.play(seat.id, action.cardId));
        if (g.atRisk === seat.id && g.canCall(seat.id) && !seat.forgot) events.push(...g.call(seat.id));
      } else if (action.kind === 'pick') {
        events.push(...g.pick(seat.id));
      } else {
        events.push(...g.pass(seat.id));
      }
      this.hooks.onMove(room, events);
      return true;
    } catch (err) {
      if (!(err instanceof GameError)) console.error('[crazy7 bots] move failed:', err);
      return false;
    }
  }

  private sayLastCard(room: Room, seat: Seat, g: Crazy7Game): void {
    seat.callTimer = null;
    if (!this.isOpen(room) || room.c7 !== g || g.atRisk !== seat.id || !g.canCall(seat.id)) return;
    try {
      this.hooks.onMove(room, g.call(seat.id));
    } catch {
      // the moment passed
    }
  }

  /** bots sometimes say something after a big moment */
  private react(room: Room, seats: Map<string, Seat>, events: GameEvent[]): void {
    const say = (id: string, lines: readonly string[], odds = 1) => {
      const seat = seats.get(id);
      if (seat && this.rand() < seat.me.chatty * odds) this.say(room, id, lines);
    };
    const anyBot = () => [...seats.keys()][Math.floor(this.rand() * seats.size)];
    for (const e of events) {
      if (e.kind === 'c7play' && e.card.rank === '7') {
        say(e.playerId, e.penalty > 2 ? LINES.stacked : LINES.fired);
      } else if (e.kind === 'c7penalty' && !e.missed && e.count >= 2) {
        say(e.playerId, LINES.hit);
      } else if (e.kind === 'c7missed' && !seats.has(e.playerId)) {
        const other = anyBot();
        if (other) say(other, LINES.caught, 1.5);
      } else if (e.kind === 'finish') {
        say(e.playerId, LINES.won, 2);
      } else if (e.kind === 'gameOver') {
        const other = anyBot();
        if (other) say(other, LINES.gameOver, 1.5);
      }
    }
  }

  private say(room: Room, id: string, lines: readonly string[]): void {
    const timers = this.chatTimers.get(room) ?? new Set<Timer>();
    this.chatTimers.set(room, timers);
    const t = setTimeout(() => {
      timers.delete(t);
      if (!this.isOpen(room) || !room.members.some((m) => m.id === id)) return;
      // now and then an emoji instead of words
      const asEmoji = this.rand() < 0.3;
      const index = asEmoji ? Math.floor(this.rand() * REACTIONS.length) : lineIndex(lines[Math.floor(this.rand() * lines.length)]);
      if (index < 0) return;
      try {
        this.hooks.onChat(room, room.chat(id, asEmoji ? 'reaction' : 'message', index));
      } catch {
        // too soon after its last message
      }
    }, (500 + this.rand() * 1300) * this.speed);
    timers.add(t);
  }

  /** the room's bots, each with its own style (no two alike while styles last) */
  private seats(room: Room): Map<string, Seat> {
    const bots = room.members.filter((m) => m.bot);
    let seats = this.tables.get(room);
    if (!seats) {
      if (bots.length === 0) return new Map();
      seats = new Map();
      this.tables.set(room, seats);
    }
    for (const [id, seat] of seats) {
      if (bots.some((b) => b.id === id)) continue;
      this.cancel(seat);
      seats.delete(id);
    }
    for (const bot of bots) {
      if (seats.has(bot.id)) continue;
      const taken = [...seats.values()].map((s) => s.me.style);
      const me = makePersonality(pickStyle(taken, this.rand), this.rand);
      seats.set(bot.id, { id: bot.id, me, mem: null, game: null, timer: null, key: null, callTimer: null });
    }
    return seats;
  }

  /** a fresh memory for each new game */
  private memoryOf(seat: Seat, g: Crazy7Game): Crazy7Memory {
    if (!seat.mem || seat.game !== g) {
      seat.game = g;
      seat.mem = new Crazy7Memory(seat.id, g.config);
    }
    return seat.mem;
  }

  /** drawn before it knows what it'll do, so a pause never gives anything away; a follow-up after a pick is quicker */
  private thinkMs(seat: Seat, g: Crazy7Game, room: Room): number {
    const base = g.picks > 0 ? 500 + this.rand() * 700 : 900 + this.rand() * 1700;
    const ms = base * seat.me.tempo * this.speed;
    // never catch a person out before they've had a fair moment to tap the button
    const person = g.atRisk !== null && !room.isBot(g.atRisk);
    return person ? Math.max(ms, LAST_CALL_GRACE_MS * this.speed) : ms;
  }

  private live(room: Room, g: Crazy7Game): boolean {
    return this.isOpen(room) && room.c7 === g && !g.over && this.someoneHere(room);
  }

  private someoneHere(room: Room): boolean {
    return room.members.some((m) => !m.bot && m.socketId !== null);
  }

  private clearTurn(seat: Seat): void {
    if (seat.timer) clearTimeout(seat.timer);
    seat.timer = null;
    seat.key = null;
  }

  private cancel(seat: Seat): void {
    this.clearTurn(seat);
    if (seat.callTimer) clearTimeout(seat.callTimer);
    seat.callTimer = null;
  }
}
