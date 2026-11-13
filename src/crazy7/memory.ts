import type { GameEvent } from '../models.js';
import type { Card, Crazy7View, GameConfig, Rank, Suit } from '../types.js';
import type { OpponentRead } from './bot-models.js';

/** the card breaks what was worked out about the hand it came from */
export const breaksRead = (r: OpponentRead, c: Card) => r.voidSuits.has(c.suit) || r.voidRanks.has(c.rank);

/** what one bot remembers of a Crazy 7 game; all of it is something any seated player could have seen */
export class Crazy7Memory {
  /** the pile from bottom to top, as far as seen */
  pile: Card[] = [];
  /** every card each player put down */
  readonly played = new Map<string, Card[]>();
  /** what each opponent can't be holding */
  readonly reads = new Map<string, OpponentRead>();

  constructor(
    readonly meId: string,
    readonly config: GameConfig,
  ) {}

  read(id: string): OpponentRead {
    let r = this.reads.get(id);
    if (!r) {
      r = { voidSuits: new Set(), voidRanks: new Set(), fresh: 0 };
      this.reads.set(id, r);
    }
    return r;
  }

  observe(events: GameEvent[]): void {
    for (const e of events) {
      switch (e.kind) {
        case 'c7play': {
          this.pile.push(e.card);
          const list = this.played.get(e.playerId) ?? [];
          list.push(e.card);
          this.played.set(e.playerId, list);
          if (e.playerId === this.meId) break;
          // a card the read says they couldn't have must be one they picked since
          const r = this.read(e.playerId);
          if (breaksRead(r, e.card)) r.fresh = Math.max(0, r.fresh - 1);
          break;
        }
        case 'c7pick': {
          if (e.playerId === this.meId) break;
          const r = this.read(e.playerId);
          // picked because nothing matched: no card of that suit or number in hand right then
          if (e.forced && e.top) this.narrow(r, [e.top.suit], [e.top.rank]);
          r.fresh += e.count;
          break;
        }
        case 'c7penalty': {
          if (e.playerId === this.meId) break;
          const r = this.read(e.playerId);
          // took the pick without answering: no 7 in hand (only telling when stacking was allowed)
          if (e.forced && !e.missed && this.config.stack7) this.narrow(r, [], ['7']);
          r.fresh += e.count;
          break;
        }
        case 'c7shuffle':
          // the pile went back into the deck; only its top card stays
          this.pile = this.pile.slice(-1);
          break;
        default:
          break;
      }
    }
  }

  /** lines memory up with the table: the top card shown is always the top of the pile */
  sync(c7: Crazy7View): void {
    const top = c7.top;
    if (top && this.pile[this.pile.length - 1]?.id !== top.id) {
      this.pile = this.pile.filter((c) => c.id !== top.id);
      this.pile.push(top);
    }
    if (this.pile.length > c7.pileCount) this.pile = this.pile.slice(this.pile.length - c7.pileCount);
  }

  /** a new certainty about their whole hand; older ones only held for cards they no longer surely have */
  private narrow(r: OpponentRead, suits: Suit[], ranks: Rank[]): void {
    if (r.fresh > 0) {
      r.voidSuits.clear();
      r.voidRanks.clear();
    }
    suits.forEach((s) => r.voidSuits.add(s));
    ranks.forEach((k) => r.voidRanks.add(k));
    r.fresh = 0;
  }
}
