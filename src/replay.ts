import type { Crazy7Game } from './crazy7/game.js';
import type { Game } from './game.js';
import type { GameEvent, TableGame } from './models.js';
import { REPLAY_MAX_STEPS, type GameKind, type GameReplay, type Rank, type ReplayClaim, type ReplayPlayer, type ReplayStep } from './types.js';

/** Records a game step by step while it runs; only public facts, plus Bluff's real cards when lies are shown */
export class ReplayRecorder {
  private readonly steps: ReplayStep[] = [];
  private truncated = false;
  /** the game-over step is in; nothing after it */
  private ended = false;
  /** Bluff's Kismat rank, read at the deal */
  private wild: Rank | null = null;
  /** the last claim seen, so a bluff call still shows what was called */
  private claim: ReplayClaim | null = null;

  constructor(
    private readonly game: GameKind,
    private readonly players: ReplayPlayer[],
    private readonly cards: boolean,
    private readonly max = REPLAY_MAX_STEPS,
  ) {}

  /** the deal: card counts and whose turn it is */
  start(table: TableGame, bluff: Game | null, c7: Crazy7Game | null, lines: string[] = []): void {
    this.steps.length = 0;
    this.ended = false;
    this.wild = bluff?.kismat ?? null;
    this.claim = null;
    this.push(this.stepOf(table, bluff, c7, lines, []), false);
  }

  /** the deal's opening lines once they're known */
  addStartLines(lines: string[]): void {
    this.steps[0]?.lines.push(...lines);
  }

  /** one move: what was said and the table right after */
  record(table: TableGame, bluff: Game | null, c7: Crazy7Game | null, lines: string[], events: GameEvent[]): void {
    if (this.steps.length === 0 || this.ended) return;
    this.ended = table.over;
    this.push(this.stepOf(table, bluff, c7, lines, events), table.over);
  }

  get length(): number {
    return this.steps.length;
  }

  toReplay(): GameReplay {
    return {
      game: this.game,
      players: this.players.map((p) => ({ ...p })),
      steps: this.steps.map((s) => ({ ...s, lines: [...s.lines] })),
      cards: this.cards,
      ...(this.wild ? { wild: this.wild } : {}),
      ...(this.truncated ? { truncated: true } : {}),
    };
  }

  private push(step: ReplayStep, last: boolean): void {
    if (this.steps.length < this.max) {
      this.steps.push(step);
      return;
    }
    this.truncated = true;
    // full: the game's end still replaces the last kept step
    if (last) this.steps[this.max - 1] = step;
  }

  private stepOf(table: TableGame, bluff: Game | null, c7: Crazy7Game | null, lines: string[], events: GameEvent[]): ReplayStep {
    const step: ReplayStep = {
      lines: [...lines],
      turnId: table.over ? null : table.turnId,
      counts: this.players.map((p) => table.hands.get(p.id)?.length ?? 0),
      pile: table.pile.length,
    };
    if (c7) {
      step.top = c7.top() ? { ...c7.top()! } : null;
      return step;
    }
    const call = events.find((e) => e.kind === 'bluff');
    const play = bluff?.lastPlay;
    if (play) {
      this.claim = {
        playerId: play.playerId,
        count: play.cards.length,
        rank: play.rank,
        ...(this.cards ? { cards: play.cards.map((c) => ({ ...c })) } : {}),
      };
    }
    // a call clears the pile, but the step still shows the play it turned over
    step.claim = play || call ? this.claim : null;
    if (!play && !call) this.claim = null;
    step.call = call && call.kind === 'bluff' ? { callerId: call.callerId, playerId: call.playerId, caught: call.bluff } : null;
    return step;
  }
}
