import { GameError } from '../game.js';
import type { GameEvent } from '../models.js';
import type { Room } from '../rooms.js';
import { RANG_CHAT, type ChatEvent } from '../types.js';
import type { Rand, RangAction, RangPersonality } from './bot-models.js';
import { decide, fallback, makePersonality, pickStyle, seatView } from './brain.js';
import type { RangGame } from './game.js';
import { RangMemory } from './memory.js';

/** what the socket layer does with a bot's moves, the same as with a person's */
export interface RangBotHooks {
  onMove(room: Room, events: GameEvent[]): void;
  onChat(room: Room, chat: ChatEvent): void;
}

type Timer = ReturnType<typeof setTimeout>;

/** a person who just went down to one card gets this long to say "last card" before a bot moves on */
const LAST_CALL_GRACE_MS = 3500;

/** chance a bot forgets to say "last card" before playing its second-last card, by style; it may say it late and get caught */
const FORGET: Record<string, number> = { striker: 0.06, hoarder: 0.03, shifter: 0.08, counter: 0.02 };

interface Seat {
  id: string;
  me: RangPersonality;
  mem: RangMemory | null;
  game: RangGame | null;
  timer: Timer | null;
  /** the table state a planned move was planned for */
  key: string | null;
  callTimer: Timer | null;
  /** forgot to say "last card" with its second-last card */
  forgot?: boolean;
}

// lines a bot may say after big moments, from Rang's own set
export const RANG_BOT_LINES = {
  fired: ['Le, +4 😈', 'Rang badal diya 🎨', 'Kya chaal hai! 🔥'],
  stacked: ['Wapas de diya! 🔁', 'Kya chaal hai! 🔥'],
  hit: ['Sar pe +4 aa gaya 🤯', 'Haath bhar gaya 😭'],
  caught: ['Last card bhool gaya? 😂', 'Pakad liya! 👀'],
  doubted: ['Pakka +4 sahi tha? 🤨', 'Pakad liya! 👀'],
  fair: ['Mere paas aur rang nahi tha 😇', 'Check kar lo 😉'],
  won: ['Aaj meri raat hai 🌙', 'GG 🎉'],
  gameOver: ['GG 🎉', 'Ek aur round! 🔁'],
} as const;
const LINES = RANG_BOT_LINES;
const lineIndex = (text: string) => RANG_CHAT.messages.indexOf(text);

/** changes with every move; a planned move is dropped if the table moved on */
const tableKey = (g: RangGame) => `${g.moveSeq}|${g.turnId}|${g.penalty}|${g.picks}`;

/** runs one move through the rules, saying "last card" with the second-last card unless it forgot */
function run(g: RangGame, id: string, a: RangAction, forgot = false): GameEvent[] {
  const events: GameEvent[] = [];
  if (a.kind === 'play') {
    if (g.hand(id).length === 2 && g.canCall(id) && !forgot) events.push(...g.call(id));
    events.push(...g.play(id, a.cardId, { color: a.color, targetId: a.targetId, extra: a.extra }));
    if (!g.over && g.atRisk === id && g.canCall(id) && !forgot) events.push(...g.call(id));
  } else if (a.kind === 'pick') {
    events.push(...g.pick(id));
    // force play may have put the picked card down, leaving one
    if (!g.over && g.atRisk === id && g.canCall(id)) events.push(...g.call(id));
  }
  else if (a.kind === 'pass') events.push(...g.pass(id));
  else events.push(...g.challenge(id));
  return events;
}

/** plays every Rang bot in every room: thinks at a human pace, acts through the same game rules */
export class RangBots {
  private tables = new Map<Room, Map<string, Seat>>();
  private chatTimers = new Map<Room, Set<Timer>>();
  /** turn timer: a bot brain per person that watches the game and plays their turn when it runs out */
  private standins = new Map<Room, Map<string, Seat>>();

  constructor(
    private readonly hooks: RangBotHooks,
    private readonly isOpen: (room: Room) => boolean,
    /** 1 = human pace; tests use a small number */
    private readonly speed = 1,
    private readonly rand: Rand = Math.random,
  ) {}

  /** every bot at the table remembers what just happened */
  observe(room: Room, events: GameEvent[]): void {
    const g = room.rang;
    if (g && room.config.turnTimer) for (const seat of this.standinsOf(room, g).values()) this.memoryOf(seat, g).observe(events);
    const seats = this.seats(room);
    if (!g || events.length === 0 || seats.size === 0) return;
    for (const seat of seats.values()) if (g.order.includes(seat.id)) this.memoryOf(seat, g).observe(events);
    this.react(room, seats, events);
  }

  /** after any change: plan what each bot does next */
  wake(room: Room): void {
    if (!this.isOpen(room)) return this.forget(room);
    const g = room.rang;
    // people's stand-ins start watching from the deal
    if (g && !g.over && room.config.turnTimer) for (const seat of this.standinsOf(room, g).values()) this.memoryOf(seat, g).see(g.hand(seat.id));
    const seats = this.seats(room);
    if (seats.size === 0) return;
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
      // its own hand as it stands, so a swap that follows tells it who now holds these cards
      this.memoryOf(seat, g).see(g.hand(seat.id));
      // down to one card without saying it (it always says it before playing, so mostly a safety net; also after a swap)
      if ((g.atRisk === seat.id || (g.hand(seat.id).length === 1 && g.canCall(seat.id))) && !seat.callTimer) {
        // a bot that forgot remembers a little late, so a quick player can catch it
        const late = seat.forgot && g.atRisk === seat.id ? 1500 + this.rand() * 3000 : 300 + this.rand() * 400;
        seat.callTimer = setTimeout(() => this.sayLastCard(room, seat, g), late * this.speed);
      }
      // not its turn, or the room is about to pick or pass for it (RangAuto)
      if (g.turnId !== seat.id || g.autoDue) {
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
    this.standins.delete(room);
    this.tables.delete(room);
    this.chatTimers.delete(room);
  }

  /** lets go of rooms that closed without a word */
  prune(): void {
    for (const room of [...this.tables.keys()]) if (!this.isOpen(room)) this.forget(room);
    for (const room of [...this.standins.keys()]) if (!this.isOpen(room)) this.standins.delete(room);
  }

  stop(): void {
    for (const room of [...this.tables.keys()]) this.forget(room);
    this.standins.clear();
  }

  /** a person's turn timer ran out: the bot brain picks their move like a bot's, always saying last card; [] if nothing worked */
  playFor(room: Room, id: string): GameEvent[] {
    const g = room.rang;
    if (!g || g.over || g.turnId !== id || g.autoDue) return [];
    const seat = this.standinsOf(room, g).get(id);
    const view = seatView(room.view(id));
    if (!seat || !view) return [];
    const action = this.think(seat, g, view, 'stand-in');
    const attempt = (a: RangAction): GameEvent[] | null => {
      try {
        return run(g, id, a);
      } catch (err) {
        if (!(err instanceof GameError)) console.error('[rang bots] stand-in move failed:', err);
        return null;
      }
    };
    return attempt(action) ?? attempt(fallback(seatView(room.view(id)) ?? view)) ?? [];
  }

  private turn(room: Room, seat: Seat, g: RangGame, key: string): void {
    seat.timer = null;
    // planned for this moment only; whatever happens next gets planned afresh
    seat.key = null;
    if (!this.live(room, g) || tableKey(g) !== key || g.turnId !== seat.id || g.autoDue) return;
    const view = seatView(room.view(seat.id));
    if (!view) return;
    const action = this.think(seat, g, view, 'decision');
    if (this.apply(room, seat, g, action)) return;
    const again = seatView(room.view(seat.id));
    if (again && this.live(room, g) && g.turnId === seat.id) this.apply(room, seat, g, fallback(again));
  }

  /** the brain's move from this seat's own view; the safe move if the search fails */
  private think(seat: Seat, g: RangGame, view: NonNullable<ReturnType<typeof seatView>>, what: string): RangAction {
    const mem = this.memoryOf(seat, g);
    mem.sync(view);
    try {
      return decide({ view, mem, me: seat.me, rand: this.rand });
    } catch (err) {
      console.error(`[rang bots] ${what} failed:`, (err as Error).message);
      return fallback(view);
    }
  }

  /** runs a move through the rules, saying "last card" with the second-last card. False if refused */
  private apply(room: Room, seat: Seat, g: RangGame, action: RangAction): boolean {
    try {
      if (action.kind === 'play') seat.forgot = g.hand(seat.id).length === 2 && this.rand() < (FORGET[seat.me.style] ?? 0.04);
      this.hooks.onMove(room, run(g, seat.id, action, action.kind === 'play' && !!seat.forgot));
      return true;
    } catch (err) {
      if (!(err instanceof GameError)) console.error('[rang bots] move failed:', err);
      return false;
    }
  }

  private sayLastCard(room: Room, seat: Seat, g: RangGame): void {
    seat.callTimer = null;
    if (!this.isOpen(room) || room.rang !== g || !g.canCall(seat.id)) return;
    if (g.atRisk !== seat.id && g.hand(seat.id).length !== 1) return;
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
      if (e.kind === 'rgplay' && (e.card.value === 'draw2' || e.card.value === 'wild4')) {
        say(e.playerId, e.penalty > (e.card.value === 'draw2' ? 2 : 4) ? LINES.stacked : LINES.fired);
      } else if (e.kind === 'rgpenalty' && !e.missed && e.count >= 4) {
        say(e.playerId, LINES.hit);
      } else if (e.kind === 'rgchallenge') {
        if (e.guilty) say(e.playerId, LINES.doubted, 1.5);
        else say(e.targetId, LINES.fair, 1.5);
      } else if (e.kind === 'rgmissed' && !seats.has(e.playerId)) {
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
      const index = asEmoji ? Math.floor(this.rand() * RANG_CHAT.reactions.length) : lineIndex(lines[Math.floor(this.rand() * lines.length)]);
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

  /** one stand-in per person seated in this game */
  private standinsOf(room: Room, g: RangGame): Map<string, Seat> {
    let seats = this.standins.get(room);
    if (!seats) {
      seats = new Map();
      this.standins.set(room, seats);
    }
    for (const id of g.order) {
      if (room.isBot(id) || seats.has(id)) continue;
      seats.set(id, { id, me: makePersonality(pickStyle([], this.rand), this.rand), mem: null, game: null, timer: null, key: null, callTimer: null });
    }
    return seats;
  }

  /** a fresh memory for each new game */
  private memoryOf(seat: Seat, g: RangGame): RangMemory {
    if (!seat.mem || seat.game !== g) {
      seat.game = g;
      seat.mem = new RangMemory(seat.id, g.config, g.order);
    }
    return seat.mem;
  }

  /** drawn before it knows what it'll do, so a pause never gives anything away; a follow-up after a pick is quicker */
  private thinkMs(seat: Seat, g: RangGame, room: Room): number {
    // never faster than a person could follow
    const base = g.picks > 0 ? 900 + this.rand() * 800 : 1300 + this.rand() * 1700;
    const ms = Math.max(g.picks > 0 ? 800 : 1100, base * seat.me.tempo) * this.speed;
    // never catch a person out before they've had a fair moment to tap the button
    const person = g.atRisk !== null && !room.isBot(g.atRisk);
    return person ? Math.max(ms, LAST_CALL_GRACE_MS * this.speed) : ms;
  }

  private live(room: Room, g: RangGame): boolean {
    return this.isOpen(room) && room.rang === g && !g.over && this.someoneHere(room);
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
