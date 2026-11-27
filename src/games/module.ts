import type { RandomInt } from '../cards.js';
import type { GameEvent, TableGame } from '../models.js';
import type { MissionCounts } from '../services/missions.js';
import type { AnnounceKind, BotLevel, Card, GameConfig, PluggedKind, PluggedView } from '../types.js';

/** a registry game's table: a TableGame with no cards (hands empty, pile []) */
export type PluggedGame = TableGame<Card>;

/** a forced or timed step the room plays by itself after a pause */
export interface AutoStep {
  delayMs: number;
  run(): GameEvent[];
  /** real-time games: a run with no events changed nothing anyone sees, so no views go out (the next step is still planned) */
  quiet?: boolean;
}

/** everything the room, sockets, bots and stats need from one registry game; every new game adds one of these */
export interface GameModule<G extends PluggedGame = PluggedGame> {
  kind: PluggedKind;
  /** a new game in this seat order (2v2: slot order, partners opposite) */
  create(order: string[], config: GameConfig, rand: RandomInt, botIds: string[]): G;
  /** the table as one member sees it; seated false for watchers */
  view(game: G, meId: string, seated: boolean): PluggedView;
  /** parses and checks a game:move payload, then plays it; throws GameError with a message players can read */
  move(game: G, playerId: string, raw: unknown): GameEvent[];
  /** what the table hears for an event; null for steps that only show on the board */
  describe(game: G, event: GameEvent, name: (id: string | null) => string): [AnnounceKind, string] | null;
  /** the next step the room plays itself (no choice to make), or null */
  auto(game: G): AutoStep | null;
  /** game time: when it runs out and what happens then; null with no limit */
  clock(game: G): { endsAt: number; run(): GameEvent[] } | null;
  /** a bot's (or a timed-out person's) move, as a game:move payload */
  botMove(game: G, botId: string, level: BotLevel, rand: () => number): unknown;
  /** changes with every step: timers are keyed on it */
  turnKey(game: G): string;
  /** still playing (not finished, not out): the room ends a game once no person is */
  inPlay(game: G, id: string): boolean;
  /** game:move events one connection may send per 10 s (real-time games); unset: the socket's usual limit for every event */
  moveRate?: number;
  /** real-time movement: events `is` marks live (positions) skip the replay and announcer and go out with the next view, at most every `ms` */
  live?: { ms: number; is(e: GameEvent): boolean };
  /** this player's counters for stats.perGame[kind] (best* counters keep the highest, the rest add up) */
  tallies(game: G, playerId: string): Record<string, number>;
  /** a saved game's counters (from tallies) for the mission counters */
  missionCounts(tallies: Record<string, number>, won: boolean): MissionCounts;
}
