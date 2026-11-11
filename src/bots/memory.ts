import type { GameEvent } from '../models.js';
import type { Card, LifetimeStats, Rank, RoomView } from '../types.js';
import type { PileEntry, Read } from './models.js';

type RankCounts = Map<Rank, number>;

const bump = (m: RankCounts, rank: Rank, n: number) => m.set(rank, Math.max(0, (m.get(rank) ?? 0) + n));
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** the partner of a player in 2v2, from the public view */
export const partnerIn = (v: RoomView, id: string): string | null => v.teams?.find((t) => t.includes(id))?.find((p) => p !== id) ?? null;

/** what one bot remembers about a game; all of it is something any seated player could have seen */
export class BotMemory {
  /** fewest copies of each rank a player surely holds (they picked up my cards, or cards everyone saw) */
  private readonly known = new Map<string, RankCounts>();
  /** copies that left the game in discarded piles (my own, the only ones I know) */
  readonly gone: RankCounts = new Map();
  /** plays in the current pile */
  pile: PileEntry[] = [];
  /** cards of my next play, matched with its 'play' event */
  pendingMine: Card[] | null = null;
  /** -1..1: how its last moments went (caught or right) */
  mood = 0;

  constructor(
    readonly meId: string,
    /** what this bot saw each player do, kept from game to game in the same room */
    readonly reads: Map<string, Read>,
    /** lifetime stats of the people, read when they joined; null for guests and bots */
    readonly lifetime: Map<string, LifetimeStats | null>,
  ) {}

  read(id: string): Read {
    let r = this.reads.get(id);
    if (!r) {
      r = { caught: 0, honest: 0, goodCalls: 0, wrongCalls: 0, chances: 0 };
      this.reads.set(id, r);
    }
    return r;
  }

  /** copies of a rank I'm sure a player holds, never more than their hand */
  knownOf(id: string, rank: Rank, cardCount: number): number {
    return Math.min(this.known.get(id)?.get(rank) ?? 0, cardCount);
  }

  /** learn from what just happened; view is the table as I see it after these events */
  observe(events: GameEvent[], view: RoomView, tilt: number): void {
    for (const e of events) {
      switch (e.kind) {
        case 'play': {
          const mine = e.playerId === this.meId ? this.pendingMine : null;
          if (mine) this.pendingMine = null;
          // cards I knew they held of that rank most likely went out first
          else this.counts(e.playerId).set(e.rank, Math.max(0, (this.counts(e.playerId).get(e.rank) ?? 0) - e.count));
          this.pile.push({ playerId: e.playerId, count: e.count, rank: e.rank, mine });
          const partner = partnerIn(view, e.playerId);
          for (const p of view.players) if (p.id !== e.playerId && p.id !== partner && p.cardCount > 0) this.read(p.id).chances++;
          break;
        }
        case 'bluff': {
          // the pile goes to the loser: my own cards in it, plus whatever was turned face up
          const shown = view.reveal?.callerId === e.callerId ? view.reveal.cards.filter((c): c is Card => c !== null) : [];
          const picked = new Map<string, Card>();
          for (const entry of this.pile) for (const c of entry.mine ?? []) picked.set(c.id, c);
          for (const c of shown) picked.set(c.id, c);
          if (e.loserId !== this.meId) for (const c of picked.values()) bump(this.counts(e.loserId), c.rank, 1);
          if (e.bluff) {
            this.read(e.playerId).caught++;
            this.read(e.callerId).goodCalls++;
          } else {
            // with "pick one" only one card was checked, so it proves less
            this.read(e.playerId).honest += view.config.bluffRule === 'all' ? 1 : 0.5;
            this.read(e.callerId).wrongCalls++;
          }
          if (e.playerId === this.meId && e.bluff) this.mood = clamp(this.mood + 0.6 * tilt, -1, 1);
          if (e.callerId === this.meId) this.mood = clamp(this.mood + (e.bluff ? 0.2 : -0.25), -1, 1);
          this.pile = [];
          break;
        }
        case 'roundEnd':
          for (const entry of this.pile) for (const c of entry.mine ?? []) bump(this.gone, c.rank, 1);
          this.pile = [];
          break;
        case 'finish':
          this.known.delete(e.playerId);
          break;
        default:
          break;
      }
    }
  }

  private counts(id: string): RankCounts {
    let m = this.known.get(id);
    if (!m) {
      m = new Map();
      this.known.set(id, m);
    }
    return m;
  }
}
