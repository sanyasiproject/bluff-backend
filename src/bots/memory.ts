import type { GameEvent, Habits } from '../models.js';
import { backsClaim, claimsAllowed, type Card, type LifetimeStats, type Rank, type RoomView } from '../types.js';
import type { PileEntry, Plan, Read } from './models.js';
import { convolve, copiesFor, holdChance, meanOf, realOdds, unseenOf, type Unseen } from './odds.js';

type RankCounts = Map<Rank, number>;

const bump = (m: RankCounts, rank: Rank, n: number) => m.set(rank, Math.max(0, (m.get(rank) ?? 0) + n));
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** chance of 0, 1, 2… real cards among the cards of a play this bot hasn't seen (seen real ones are counted for sure elsewhere) */
export function hiddenReal(e: PileEntry, kismat: Rank | null): number[] {
  const seenReal = e.seen.filter((c) => backsClaim(c, e.rank, kismat)).length;
  const hidden = Math.max(0, e.count - e.seen.length);
  const out = new Array<number>(hidden + 1).fill(0);
  realOdds(e.count, e.fakes).forEach((p, j) => (out[clamp(j - seenReal, 0, hidden)] += p));
  return out;
}

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
  /** of those, the chance that 0, 1, 2… real copies of each rank went (index = copies): a play read as honest may have been all fakes */
  readonly goneReal = new Map<Rank, number[]>();
  /** plays in the current pile */
  pile: PileEntry[] = [];
  /** cards of my next play, matched with its 'play' event */
  pendingMine: Card[] | null = null;
  /** -1..1: how its last moments went (caught or right) */
  mood = 0;
  /** rounds opened so far this game */
  rounds = 0;
  /** what it's up to for the next few rounds; null draws a new one */
  plan: Plan | null = null;

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
        overCaught: 0,
        overHonest: 0,
        keptLies: 0,
      };
      this.reads.set(id, r);
    }
    return r;
  }

  /** real copies of a rank that most likely went out with other people's thrown-away piles (index = copies); real Kismat claims count too */
  goneOf(rank: Rank, kismat: Rank | null): number[] {
    const own = this.goneReal.get(rank) ?? [1];
    return !!kismat && kismat !== rank ? convolve(own, this.goneReal.get(kismat) ?? [1]) : own;
  }

  /** real copies of a rank that most likely went out with other people's thrown-away piles */
  goneMean(rank: Rank, kismat: Rank | null): number {
    return meanOf(this.goneOf(rank, kismat));
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
          // following a round: how likely they were to have none of the ranks they could claim
          if (this.pile.length > 0 && e.playerId !== this.meId) this.followed(view, e.playerId, this.allowed(view), e.count, false);
          const mine = e.playerId === this.meId ? this.pendingMine : null;
          const wild = view.kismat && view.kismat !== e.rank ? view.kismat : null;
          const natural = this.counts(e.playerId).get(e.rank) ?? 0;
          const knownBefore = mine ? 0 : natural + (wild ? (this.counts(e.playerId).get(wild) ?? 0) : 0);
          if (mine) this.pendingMine = null;
          else {
            // cards I knew they held of that rank most likely went out first, then Kismat cards
            this.counts(e.playerId).set(e.rank, Math.max(0, natural - e.count));
            if (wild && e.count > natural) bump(this.counts(e.playerId), wild, natural - e.count);
          }
          if (this.pile.length === 0) this.rounds++;
          const id = view.lastPlay?.playerId === e.playerId ? view.lastPlay.id : null;
          const left = view.players.find((p) => p.id === e.playerId)?.cardCount ?? 0;
          this.pile.push({
            id,
            playerId: e.playerId,
            count: e.count,
            rank: e.rank,
            mine,
            opening: this.pile.length === 0,
            left,
            knownBefore,
            realEst: null,
            seen: [],
            seenAt: [],
            read: null,
            fakes: null,
            sure: null,
            trapped: false,
          });
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
          // a claim that clashes with the round: lying, or real cards springing a trap on whoever believed the earlier claims?
          const mine = called?.playerId === e.playerId;
          const clash = mine && this.clash(called, view.config.decks, view.kismat);
          // real cards known in it: turned over now, or seen in my peeks
          const real = mine ? new Set([...shown, ...called.seen].filter((c) => backsClaim(c, called.rank, view.kismat)).map((c) => c.id)).size : 0;
          if (mine && !e.bluff) this.noteTrap(called, real, view.config.decks, view.kismat);
          if (clash) {
            const r = this.read(e.playerId);
            if (e.bluff) r.overCaught = (r.overCaught ?? 0) + 1;
            // under "pick one" a real card turned over says little about the rest, like any other read
            else r.overHonest = (r.overHonest ?? 0) + (real >= called.count ? 1 : 1 / Math.max(1, called.count));
          }
          // how good my read of that play was: called plays are the suspicious ones, so this is what keeps my reads honest
          // (not a clash or a sprung trap: those are about the round, and this player isn't more honest for one holding up)
          if (mine && !clash && !called.trapped && called.read && view.reveal?.callerId === e.callerId) {
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
          // caught, or a wrong call: whatever it was up to is known now, so it thinks again
          if ((e.playerId === this.meId && e.bluff) || (e.callerId === this.meId && !e.bluff)) this.plan = null;
          this.pile = [];
          break;
        }
        case 'pass':
          if (this.pile.length > 0 && e.playerId !== this.meId) this.followed(view, e.playerId, this.allowed(view), 0, true);
          break;
        case 'roundEnd':
          // my own cards and any I peeked at leave the game with the pile
          for (const entry of this.pile) for (const c of [...(entry.mine ?? []), ...entry.seen]) bump(this.gone, c.rank, 1);
          // everyone else's go too: unknown cards, most likely the real ones I reckoned each play held, kept as a spread
          for (const entry of this.pile) {
            if (entry.mine) continue;
            this.othersGone += entry.count - entry.seen.length;
            this.goneReal.set(entry.rank, convolve(this.goneReal.get(entry.rank) ?? [1], hiddenReal(entry, view.kismat)));
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

  /**
   * The play can't be true along with the round's earlier claims (so one claim of the round is a lie), though its own claim alone could be:
   * everyone's claims together go past the copies, or other people's do with the copies only I know of (my hand, my pile cards, my
   * discards). Such a play is judged by the round, not by how honest its player is.
   */
  clash(entry: PileEntry, decks: number, kismat: Rank | null): boolean {
    const copies = copiesFor(entry.rank, decks, kismat);
    const at = this.pile.indexOf(entry);
    if (at <= 0 || entry.count > copies) return false;
    // with Seedhi only the round's claims of the same rank add up
    const upTo = this.pile.slice(0, at + 1).filter((en) => en.rank === entry.rank);
    if (upTo.reduce((n, en) => n + en.count, 0) > copies) return true;
    if (entry.sure === null || entry.count + entry.sure > copies) return false;
    return upTo.reduce((n, en) => (en.mine ? n : n + en.count), 0) + entry.sure > copies;
  }

  /**
   * Real cards seen in a play prove a trap only when they can't all be real along with the player's earlier claims this round:
   * the copies I'm sure of, those real cards and their earlier claims add up to more than exist. Then an earlier claim of theirs was
   * fake while they held these real cards back; remembered once per play.
   */
  noteTrap(entry: PileEntry, real: number, decks: number, kismat: Rank | null): void {
    if (entry.trapped || entry.sure === null || real <= 0) return;
    const before = this.pile.slice(0, this.pile.indexOf(entry)).reduce((n, en) => (en.playerId === entry.playerId && en.rank === entry.rank ? n + en.count : n), 0);
    if (before === 0 || entry.sure + real + before <= copiesFor(entry.rank, decks, kismat)) return;
    entry.trapped = true;
    const r = this.read(entry.playerId);
    r.keptLies = (r.keptLies ?? 0) + 1;
  }

  /** ranks the turn being seen could claim: the round's, or with Seedhi the last claim's neighbours */
  private allowed(view: RoomView): readonly Rank[] {
    return claimsAllowed(this.pile[this.pile.length - 1].rank, view.config.seedhi);
  }

  /** a turn in a running round: add their chance of holding none of the ranks they could claim, and whether they passed */
  private followed(view: RoomView, id: string, ranks: readonly Rank[], played: number, passed: boolean): void {
    const hand = (view.players.find((p) => p.id === id)?.cardCount ?? 0) + played;
    if (hand === 0) return;
    const r = this.read(id);
    r.lack += 1 - holdChance(this.unseenAny(view, ranks), hand, 1);
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
      const fake = backsClaim(c, rv.rank, view.kismat) ? 0 : 1;
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
  unseen(view: RoomView, rank: Rank): Unseen {
    return unseenOf(rank, view.config.decks, this.mine(view), this.gone, view.kismat);
  }

  /** what this bot can't see of any of these ranks (and the Kismat rank): the copies of each added up */
  private unseenAny(view: RoomView, ranks: readonly Rank[]): Unseen {
    if (ranks.length === 1) return this.unseen(view, ranks[0]);
    const mine = this.mine(view);
    const all = new Set<Rank>(view.kismat ? [...ranks, view.kismat] : ranks);
    let copies = 0;
    for (const rank of all) copies += unseenOf(rank, view.config.decks, mine, this.gone).copies;
    return { cards: unseenOf(ranks[0], view.config.decks, mine, this.gone).cards, copies };
  }

  /** cards this bot knows aren't in anyone else's hand: its hand, its partner's and its pile cards */
  private mine(view: RoomView): Card[] {
    const mine = [...view.hand, ...(view.partnerHand ?? [])];
    for (const entry of this.pile) mine.push(...(entry.mine ?? []));
    return mine;
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
