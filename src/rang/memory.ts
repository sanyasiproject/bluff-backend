import type { GameEvent } from '../models.js';
import type { GameConfig, RangCard, RangColor, RangValue } from '../types.js';
import type { OpponentRead, RangSeatView } from './bot-models.js';

const wildValue = (v: RangValue) => v === 'wild' || v === 'wild4';

/** the card breaks what was worked out about the hand it came from */
export const breaksRead = (r: OpponentRead, c: RangCard) =>
  r.voidValues.has(c.value) || (!wildValue(c.value) && c.color !== null && r.voidColors.has(c.color));

const emptyRead = (): OpponentRead => ({ voidColors: new Set(), voidValues: new Set(), fresh: 0, known: [] });

/** what one bot remembers of a Rang game; all of it is something any seated player could have seen */
export class RangMemory {
  /** the pile from bottom to top, as far as seen */
  pile: RangCard[] = [];
  /** what each opponent can't be holding, and what they surely hold */
  reads = new Map<string, OpponentRead>();
  /** the colour to match and the direction of play, as last seen */
  color: RangColor | null = null;
  dir: 1 | -1 = 1;
  /** the unstacked +4 on top: who played it and the colour in play just before it */
  four: { by: string; color: RangColor | null } | null = null;
  /** how each player's challenged +4s turned out */
  readonly fours = new Map<string, { guilty: number; fair: number }>();
  /** my own hand as last seen (before the move being observed) */
  mine: RangCard[] = [];
  /** seats still holding cards, as last seen */
  private active: Set<string>;

  constructor(
    readonly meId: string,
    readonly config: GameConfig,
    readonly order: string[],
  ) {
    this.active = new Set(order);
  }

  read(id: string): OpponentRead {
    let r = this.reads.get(id);
    if (!r) {
      r = emptyRead();
      this.reads.set(id, r);
    }
    return r;
  }

  private top(): RangCard | null {
    return this.pile[this.pile.length - 1] ?? null;
  }

  observe(events: GameEvent[]): void {
    for (const e of events) {
      switch (e.kind) {
        case 'rgplay': {
          const before = this.color;
          // doubles put down several cards; the last is on top
          const cards = e.cards && e.cards.length > 0 ? e.cards : [e.card];
          this.pile.push(...cards);
          this.color = e.color;
          this.four = e.card.value === 'wild4' && e.penalty === 4 ? { by: e.playerId, color: before } : null;
          if (e.reversed) this.dir = this.dir === 1 ? -1 : 1;
          if (e.playerId === this.meId) this.mine = this.mine.filter((c) => !cards.some((x) => x.id === c.id));
          else {
            const r = this.read(e.playerId);
            for (const card of cards) {
              const k = r.known.findIndex((c) => c.id === card.id);
              if (k >= 0) r.known.splice(k, 1);
              // a card the read says they couldn't have must be one they picked since
              else if (breaksRead(r, card)) r.fresh = Math.max(0, r.fresh - 1);
            }
          }
          if (e.targetId && e.card.value === '7') this.swap(e.playerId, e.targetId);
          else if (e.rotated) this.rotate();
          break;
        }
        case 'rgpick': {
          if (e.playerId === this.meId) break;
          const r = this.read(e.playerId);
          // picked because nothing fit: no card of the colour, none of the top value, no wild
          if (e.forced) this.noFit(r);
          r.fresh += e.count;
          break;
        }
        case 'rgpass': {
          // the turn passed by itself: still nothing fits, picked cards included
          if (e.auto && e.playerId !== this.meId) this.noFit(this.read(e.playerId));
          break;
        }
        case 'rgpenalty': {
          if (e.playerId === this.meId) break;
          const r = this.read(e.playerId);
          // took the pick with stacking on: nothing that answers it (only a +4 answers a +4)
          if (!e.missed && this.config.rangStack) this.narrow(r, [], this.top()?.value === 'wild4' ? ['wild4'] : ['draw2', 'wild4']);
          r.fresh += e.count;
          this.four = null;
          break;
        }
        case 'rgchallenge': {
          const four = this.four;
          this.four = null;
          const record = this.fours.get(e.targetId) ?? { guilty: 0, fair: 0 };
          record[e.guilty ? 'guilty' : 'fair']++;
          this.fours.set(e.targetId, record);
          // a fair +4: its player held none of the colour in play
          if (!e.guilty && four?.color && e.targetId !== this.meId) this.narrow(this.read(e.targetId), [four.color], []);
          const who = e.guilty ? e.targetId : e.playerId;
          if (who !== this.meId) this.read(who).fresh += e.count;
          // a caught +4 goes back to its player: it leaves the pile
          if (e.guilty && this.pile[this.pile.length - 1]?.value === 'wild4') this.pile.pop();
          break;
        }
        case 'rgshuffle':
          // the pile went back into the deck; only its top card stays
          this.pile = this.pile.slice(-1);
          break;
        default:
          break;
      }
    }
  }

  /** my own hand as it stands now, so a swap that follows knows who holds these cards */
  see(hand: RangCard[]): void {
    this.mine = [...hand];
  }

  /** lines memory up with the table: the top card shown is always the top of the pile */
  sync(v: RangSeatView): void {
    const r = v.rang;
    this.mine = [...r.hand];
    this.color = r.color;
    this.dir = r.dir;
    this.active = new Set(v.players.filter((p) => p.cardCount > 0).map((p) => p.id));
    const top = r.top;
    if (top && this.top()?.id !== top.id) {
      this.pile = this.pile.filter((c) => c.id !== top.id);
      this.pile.push(top);
    }
    if (this.pile.length > r.pileCount) this.pile = this.pile.slice(this.pile.length - r.pileCount);
    if (!(r.penalty === 4 && top?.value === 'wild4')) this.four = null;
  }

  /** nothing in their hand fits the table right now */
  private noFit(r: OpponentRead): void {
    const top = this.top();
    const values: RangValue[] = ['wild', 'wild4'];
    if (top && !wildValue(top.value)) values.push(top.value);
    this.narrow(r, this.color ? [this.color] : [], values);
  }

  /** a new certainty about their whole hand; older ones only held for cards they no longer surely have */
  private narrow(r: OpponentRead, colors: RangColor[], values: RangValue[]): void {
    if (r.fresh > 0) {
      r.voidColors.clear();
      r.voidValues.clear();
    }
    colors.forEach((c) => r.voidColors.add(c));
    values.forEach((v) => r.voidValues.add(v));
    r.fresh = 0;
  }

  /** what follows a hand: my own old hand is known card for card, anyone else's read moves with it */
  private handOf(id: string): OpponentRead {
    if (id === this.meId) return { ...emptyRead(), known: [...this.mine] };
    return this.reads.get(id) ?? emptyRead();
  }

  /** a 7 swapped two hands */
  private swap(a: string, b: string): void {
    const ha = this.handOf(a);
    const hb = this.handOf(b);
    this.reads.set(a, hb);
    this.reads.set(b, ha);
    this.reads.delete(this.meId);
  }

  /** a 0 passed every hand on in the direction of play */
  private rotate(): void {
    const seats = this.order.filter((id) => this.active.has(id));
    const n = seats.length;
    const moved = new Map<string, OpponentRead>();
    seats.forEach((p, i) => moved.set(seats[(((i + this.dir) % n) + n) % n], this.handOf(p)));
    this.reads = moved;
    this.reads.delete(this.meId);
  }
}
