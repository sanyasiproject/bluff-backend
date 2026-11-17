import type { GameEvent, Habits } from '../models.js';
import type { Card, LifetimeStats, Rank, RoomView } from '../types.js';
import type { PileEntry, Read } from './models.js';
import { holdChance, unseenOf } from './odds.js';

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
  /** other people's cards that left the game in discarded piles (their ranks unknown, but they're in nobody's hand) */
  othersGone = 0;
  /** of those, copies of each rank they probably were: the real cards of plays that stood */
  readonly likelyGone: RankCounts = new Map();
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
    /** how each person really played their past games, saved on their account; null for guests and bots */
    readonly habits: Map<string, Habits | null> = new Map(),
  ) {}

  /** the pile entry of a play still in the pile */
  entryOf(playId: string): PileEntry | undefined {
    return this.pile.find((e) => e.id === playId);
  }

  read(id: string): Read {
    let r = this.reads.get(id);
    if (!r) {
      r = {
        caught: 0,
        honest: 0,
        goodCalls: 0,
        wrongCalls: 0,
        chances: 0,
        lack: 0,
        passes: 0,
        firstTried: 0,
        firstFound: 0,
        lastTried: 0,
        lastFound: 0,
        midTried: 0,
        midFound: 0,
        openCaught: 0,
        openHonest: 0,
        followCaught: 0,
        followHonest: 0,
        endCaught: 0,
        endHonest: 0,
        expected: 0,
        found: 0,
      };
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
          // following a round: how likely they were to have none of the rank
          if (this.pile.length > 0 && e.playerId !== this.meId) this.followed(view, e.playerId, e.rank, e.count, false);
          const mine = e.playerId === this.meId ? this.pendingMine : null;
          const knownBefore = mine ? 0 : (this.counts(e.playerId).get(e.rank) ?? 0);
          if (mine) this.pendingMine = null;
          // cards I knew they held of that rank most likely went out first
          else this.counts(e.playerId).set(e.rank, Math.max(0, knownBefore - e.count));
          const id = view.lastPlay?.playerId === e.playerId ? view.lastPlay.id : null;
          const left = view.players.find((p) => p.id === e.playerId)?.cardCount ?? 0;
          this.pile.push({ id, playerId: e.playerId, count: e.count, rank: e.rank, mine, opening: this.pile.length === 0, left, knownBefore, realEst: null, seen: [], read: null });
          const partner = partnerIn(view, e.playerId);
          for (const p of view.players) if (p.id !== e.playerId && p.id !== partner && p.cardCount > 0) this.read(p.id).chances++;
          break;
        }
        case 'bluff': {
          // the pile goes to the loser: my own cards in it, plus whatever was turned face up
          const shown = view.reveal?.callerId === e.callerId ? view.reveal.cards.filter((c): c is Card => c !== null) : [];
          const picked = new Map<string, Card>();
          for (const entry of this.pile) for (const c of [...(entry.mine ?? []), ...entry.seen]) picked.set(c.id, c);
          for (const c of shown) picked.set(c.id, c);
          if (e.loserId !== this.meId) for (const c of picked.values()) bump(this.counts(e.loserId), c.rank, 1);
          // the called play opened the round if it's the only one in the pile
          this.learnPositions(view, e.callerId, e.playerId, this.pile.length <= 1);
          // a play that would have finished them: do they fake their way out?
          const called = this.pile[this.pile.length - 1];
          if (called?.playerId === e.playerId && called.left === 0) {
            const r = this.read(e.playerId);
            if (e.bluff) r.endCaught = (r.endCaught ?? 0) + 1;
            else r.endHonest = (r.endHonest ?? 0) + (view.config.bluffRule === 'all' ? 1 : 1 / Math.max(1, called.count));
          }
          // how good my read of that play was: called plays are the suspicious ones, so this is what keeps my reads honest
          if (called?.playerId === e.playerId && called.read && view.reveal?.callerId === e.callerId) {
            const at = view.reveal.pickedIndex;
            this.checkRead(e.playerId, at === null ? called.read.lie : (called.read.spots[at] ?? called.read.lie), e.bluff);
          }
          if (e.bluff) {
            this.read(e.playerId).caught++;
            this.read(e.callerId).goodCalls++;
          } else {
            // with "pick one" only one card was checked: one real card of three proves little
            const size = view.reveal?.callerId === e.callerId ? view.reveal.cards.length : 1;
            this.read(e.playerId).honest += view.config.bluffRule === 'all' ? 1 : 1 / Math.max(1, size);
            this.read(e.callerId).wrongCalls++;
          }
          if (e.playerId === this.meId && e.bluff) this.mood = clamp(this.mood + 0.6 * tilt, -1, 1);
          if (e.callerId === this.meId) this.mood = clamp(this.mood + (e.bluff ? 0.2 : -0.25), -1, 1);
          this.pile = [];
          break;
        }
        case 'pass':
          if (this.pile.length > 0 && e.playerId !== this.meId) this.followed(view, e.playerId, this.pile[0].rank, 0, true);
          break;
        case 'roundEnd':
          // my own cards and any I peeked at leave the game with the pile
          for (const entry of this.pile) for (const c of [...(entry.mine ?? []), ...entry.seen]) bump(this.gone, c.rank, 1);
          // everyone else's go too: unknown cards, but most likely the real ones I reckoned each play held
          for (const entry of this.pile) {
            if (entry.mine) continue;
            const seenReal = entry.seen.filter((c) => c.rank === entry.rank).length;
            this.othersGone += entry.count - entry.seen.length;
            const likely = Math.max(0, (entry.realEst ?? entry.count * 0.55) - seenReal);
            this.likelyGone.set(entry.rank, (this.likelyGone.get(entry.rank) ?? 0) + likely);
          }
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

  /** a turn in a running round: add their chance of holding none of the rank, and whether they passed */
  private followed(view: RoomView, id: string, rank: Rank, played: number, passed: boolean): void {
    const hand = (view.players.find((p) => p.id === id)?.cardCount ?? 0) + played;
    if (hand === 0) return;
    const r = this.read(id);
    r.lack += 1 - holdChance(this.unseen(view, rank), hand, 1);
    if (passed) r.passes++;
  }

  /** a called play of 2+ cards: where the fakes sat, as far as the reveal shows, and whether it was padded */
  private learnPositions(view: RoomView, callerId: string, playerId: string, opened: boolean): void {
    const rv = view.reveal;
    if (!rv || rv.callerId !== callerId || rv.playerId !== playerId || rv.cards.length < 2) return;
    const r = this.read(playerId);
    const n = rv.cards.length;
    const held = view.config.bluffRule === 'all' ? 1 : 1 / n;
    if (opened) {
      if (rv.bluff) r.openCaught++;
      else r.openHonest += held;
    } else if (rv.bluff) r.followCaught++;
    else r.followHonest += held;
    rv.cards.forEach((c, i) => {
      if (!c) return;
      const fake = c.rank !== rv.rank ? 1 : 0;
      if (i === 0) {
        r.firstTried++;
        r.firstFound += fake;
      } else if (i === n - 1) {
        r.lastTried++;
        r.lastFound += fake;
      } else {
        r.midTried++;
        r.midFound += fake;
      }
    });
  }

  /** a card of their play turned over: what my read expected against what it was */
  checkRead(playerId: string, expected: number, fake: boolean): void {
    const r = this.read(playerId);
    // reads kept from before these counts existed start them at 0
    r.expected = (r.expected ?? 0) + Math.min(1, Math.max(0, expected));
    r.found = (r.found ?? 0) + (fake ? 1 : 0);
  }

  /** what this bot can't see of a rank: everything but its hand, its partner's, its pile cards and known discards */
  unseen(view: RoomView, rank: Rank) {
    const mine = [...view.hand, ...(view.partnerHand ?? [])];
    for (const entry of this.pile) mine.push(...(entry.mine ?? []));
    return unseenOf(rank, view.config.decks, mine, this.gone);
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
