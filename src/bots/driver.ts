import { GameError, type Game } from '../game.js';
import type { GameEvent, Member } from '../models.js';
import type { Room } from '../rooms.js';
import { QUICK_MESSAGES, REACTIONS, type Card, type ChatEvent, type LifetimeStats } from '../types.js';
import { chooseTurn, decideCall, type Peek, type Situation } from './brain.js';
import { BotMemory } from './memory.js';
import type { BotMove, Personality, Rand, Read } from './models.js';
import { drift, makePersonality, pickName, pickStyle } from './personality.js';

/** what the socket layer does with a bot's actions, the same as for a person's */
export interface BotHooks {
  onMove: (room: Room, events: GameEvent[]) => void;
  onPeek: (room: Room, bot: Member) => void;
  onChat: (room: Room, chat: ChatEvent) => void;
}

type Timer = ReturnType<typeof setTimeout>;

interface Seat {
  id: string;
  /** drawn when the bot sat down */
  me: Personality;
  /** with this game's mood */
  today: Personality;
  /** what it saw each player do, kept for the next games in this room */
  reads: Map<string, Read>;
  mem: BotMemory | null;
  game: Game | null;
  turnTimer: Timer | null;
  turnKey: string | null;
  callTimer: Timer | null;
  /** the last play it already thought about calling */
  considered: string | null;
}

// lines a bot may say after big moments; indexes into QUICK_MESSAGES
const LINES = {
  caughtSomeone: ['Mujhe sab pata hai 🧐', 'Nice try 😏', 'Bluff hai! 🤥', 'Chal jhooth mat bol 🙄', 'Ab tu gaya 😈'],
  gotCaught: ['Sorry yaar 🙏', 'Kismat kharab hai yaar 🤦', 'Hasna mana hai 🤐', 'Bas kar bhai 😂'],
  wrongCall: ['Patte dekh ke rona aa gaya 😭', 'Kismat kharab hai yaar 🤦'],
  stoodUp: ['Sach bol raha hoon 😇', 'Main toh seedha-saadha hoon 😇', 'Trust me 😉', 'Soch le, phir mat bolna 😏'],
  bigClaim: ['Pakka? 🤨', 'Itne saare? Pakka jhooth 🤣', 'Chehra bata raha hai, jhooth hai 👀'],
  finished: ['Aaj meri raat hai 😎', 'Kya chaal hai! 🔥'],
  gameOver: ['GG 🎉', 'Ek aur round! 🔁'],
} as const;
const lineIndex = (text: string) => (QUICK_MESSAGES as readonly string[]).indexOf(text);

/** state that changes with every move; a planned turn is dropped if it changed */
const tableKey = (g: Game) =>
  [g.lastPlay?.id ?? '-', g.turnId, g.roundRank ?? '-', g.passed.size, g.pile.length, g.places.length, [...g.hands.values()].reduce((n, h) => n + h.length, 0)].join('|');

/** plays every bot in every room: listens to moves, thinks at a human pace, acts through the same game rules */
export class BotDriver {
  private tables = new Map<Room, Map<string, Seat>>();
  private chatTimers = new Map<Room, Set<Timer>>();

  constructor(
    private readonly hooks: BotHooks,
    private readonly isOpen: (room: Room) => boolean,
    /** 1 = human pace; tests use a small number */
    private readonly speed = 1,
    private readonly rand: Rand = Math.random,
  ) {}

  /** the host seats a bot: a free name and a style nobody at the table has */
  add(room: Room, by: string): { bot: Member; stakeLowered: boolean } {
    const name = pickName(
      room.members.map((m) => m.name),
      this.rand,
    );
    if (!name) throw new GameError('No more bots to add');
    const seats = this.seats(room);
    const added = room.addBot(by, name);
    const taken = [...seats.values()].map((x) => x.me.style);
    const me = makePersonality(pickStyle(taken, this.rand), this.rand);
    seats.set(added.bot.id, {
      id: added.bot.id,
      me,
      today: me,
      reads: new Map(),
      mem: null,
      game: null,
      turnTimer: null,
      turnKey: null,
      callTimer: null,
      considered: null,
    });
    return added;
  }

  /** every bot at the table learns from what just happened */
  observe(room: Room, events: GameEvent[]): void {
    const seats = this.tables.get(room);
    if (!seats || !room.game || events.length === 0) return;
    for (const seat of seats.values()) {
      if (!room.game.order.includes(seat.id)) continue;
      this.memoryOf(room, seat).observe(events, room.view(seat.id), seat.today.tilt);
    }
    this.react(room, seats, events);
  }

  /** after any change: plan what each bot does next */
  wake(room: Room): void {
    const seats = this.tables.get(room);
    if (!seats) return;
    if (!this.isOpen(room)) return this.forget(room);
    for (const [id, seat] of seats) {
      if (room.members.some((m) => m.id === id)) continue;
      this.cancel(seat);
      seats.delete(id);
    }
    const g = room.game;
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
      this.memoryOf(room, seat);
      if (g.turnId === seat.id) {
        if (seat.turnKey !== key) {
          this.clear(seat, 'turn');
          seat.turnKey = key;
          seat.turnTimer = setTimeout(() => this.turn(room, seat, g, key), this.thinkMs(seat, g));
        }
        continue;
      }
      this.clear(seat, 'turn');
      // anyone's play can be called at any moment, not only on your turn
      const play = g.lastPlay;
      if (play && play.playerId !== seat.id && seat.considered !== play.id && g.bluffCallsLeft(seat.id) > 0 && g.partnerOf(seat.id) !== play.playerId) {
        seat.considered = play.id;
        this.clear(seat, 'call');
        seat.callTimer = setTimeout(() => this.maybeCall(room, seat, g, play.id), this.reactMs(seat));
      }
    }
  }

  forget(room: Room): void {
    for (const seat of this.tables.get(room)?.values() ?? []) this.cancel(seat);
    for (const t of this.chatTimers.get(room) ?? []) clearTimeout(t);
    this.tables.delete(room);
    this.chatTimers.delete(room);
  }

  /** lets go of rooms that closed without a word (idle or emptied by the sweep) */
  prune(): void {
    for (const room of [...this.tables.keys()]) if (!this.isOpen(room)) this.forget(room);
  }

  stop(): void {
    for (const room of [...this.tables.keys()]) this.forget(room);
  }

  private turn(room: Room, seat: Seat, g: Game, key: string): void {
    seat.turnTimer = null;
    if (!this.live(room, g) || tableKey(g) !== key || g.turnId !== seat.id) return;
    const s = this.situation(room, seat);
    let move: BotMove;
    try {
      move = chooseTurn(s, this.peekFor(room, seat, g));
    } catch (err) {
      console.error('[bots] turn decision failed:', (err as Error).message);
      move = this.fallback(g, seat.id);
    }
    // a peek may have changed the table meanwhile
    if (!this.live(room, g) || g.turnId !== seat.id) return;
    if (!this.apply(room, seat, g, move)) this.apply(room, seat, g, this.fallback(g, seat.id));
  }

  private maybeCall(room: Room, seat: Seat, g: Game, playId: string): void {
    seat.callTimer = null;
    if (!this.live(room, g) || g.lastPlay?.id !== playId || g.hand(seat.id).length === 0) return;
    const call = decideCall(this.situation(room, seat), false, this.peekFor(room, seat, g));
    if (call && g.lastPlay?.id === playId) this.apply(room, seat, g, { kind: 'call', cardIndex: call.cardIndex });
  }

  /** runs a move through the game rules; false if the rules refused it */
  private apply(room: Room, seat: Seat, g: Game, move: BotMove): boolean {
    try {
      let events: GameEvent[];
      if (move.kind === 'call') {
        events = g.callBluff(seat.id, g.lastPlay!.id, move.cardIndex, 0);
      } else if (move.kind === 'pass') {
        events = g.pass(seat.id);
      } else {
        const hand = g.hand(seat.id);
        seat.mem!.pendingMine = move.cardIds.map((id) => hand.find((c) => c.id === id)).filter((c): c is Card => c !== undefined);
        events = g.play(seat.id, move.cardIds, move.rank);
      }
      this.hooks.onMove(room, events);
      return true;
    } catch (err) {
      if (seat.mem) seat.mem.pendingMine = null;
      if (!(err instanceof GameError)) console.error('[bots] move failed:', err);
      return false;
    }
  }

  /** a move the rules always take: pass, or one card claimed as the round's rank */
  private fallback(g: Game, id: string): BotMove {
    if (g.lastPlay) return { kind: 'pass' };
    const card = g.hand(id)[0];
    return { kind: 'play', cardIds: [card.id], rank: g.roundRank ? undefined : card.rank };
  }

  /** a secret look at one played card; everyone hears that a peek happened */
  private peekFor(room: Room, seat: Seat, g: Game): Peek {
    return (index) => {
      const play = g.lastPlay;
      if (!play) return null;
      try {
        const card = g.peek(seat.id, play.id, index);
        const bot = room.members.find((m) => m.id === seat.id);
        if (bot) this.hooks.onPeek(room, bot);
        return card;
      } catch {
        return null;
      }
    };
  }

  /** bots sometimes say something after a big moment */
  private react(room: Room, seats: Map<string, Seat>, events: GameEvent[]): void {
    const say = (id: string, lines: readonly string[], odds = 1) => {
      const seat = seats.get(id);
      if (seat && this.rand() < seat.today.chatty * odds) this.say(room, id, lines);
    };
    const anyBot = () => [...seats.keys()][Math.floor(this.rand() * seats.size)];
    for (const e of events) {
      if (e.kind === 'bluff') {
        say(e.callerId, e.bluff ? LINES.caughtSomeone : LINES.wrongCall);
        say(e.playerId, e.bluff ? LINES.gotCaught : LINES.stoodUp);
      } else if (e.kind === 'play' && e.count >= 3) {
        const other = anyBot();
        if (other && other !== e.playerId) say(other, LINES.bigClaim, 0.5);
      } else if (e.kind === 'finish') {
        say(e.playerId, LINES.finished);
      } else if (e.kind === 'gameOver') {
        const other = anyBot();
        if (other) say(other, LINES.gameOver, 2);
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

  private memoryOf(room: Room, seat: Seat): BotMemory {
    if (!seat.mem || seat.game !== room.game) {
      seat.game = room.game;
      seat.today = drift(seat.me, this.rand);
      const lifetime = new Map<string, LifetimeStats | null>(room.members.map((m) => [m.id, m.stats]));
      seat.mem = new BotMemory(seat.id, seat.reads, lifetime);
      seat.considered = null;
    }
    return seat.mem;
  }

  private situation(room: Room, seat: Seat): Situation {
    return { view: room.view(seat.id), mem: this.memoryOf(room, seat), me: seat.today, rand: this.rand };
  }

  /** how long it thinks: drawn before it knows what it'll do, so the pause never gives a lie away */
  private thinkMs(seat: Seat, g: Game): number {
    const opening = g.roundRank ? 1 : 1.25;
    return (900 + this.rand() * 1700) * opening * seat.today.tempo * this.speed;
  }

  /** a reaction to someone else's play; sometimes a snap call, sometimes a slow one */
  private reactMs(seat: Seat): number {
    const snap = this.rand() < 0.15;
    return (snap ? 400 + this.rand() * 500 : 800 + this.rand() * 2400) * seat.today.tempo * this.speed;
  }

  private live(room: Room, g: Game): boolean {
    return this.isOpen(room) && room.game === g && !g.over && this.someoneHere(room);
  }

  private someoneHere(room: Room): boolean {
    return room.members.some((m) => !m.bot && m.socketId !== null);
  }

  private seats(room: Room): Map<string, Seat> {
    let seats = this.tables.get(room);
    if (!seats) {
      seats = new Map();
      this.tables.set(room, seats);
    }
    return seats;
  }

  private clear(seat: Seat, which: 'turn' | 'call'): void {
    if (which === 'turn') {
      if (seat.turnTimer) clearTimeout(seat.turnTimer);
      seat.turnTimer = null;
      seat.turnKey = null;
    } else {
      if (seat.callTimer) clearTimeout(seat.callTimer);
      seat.callTimer = null;
    }
  }

  private cancel(seat: Seat): void {
    this.clear(seat, 'turn');
    this.clear(seat, 'call');
  }
}
