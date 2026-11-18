import { ObjectId, type Filter } from 'mongodb';
import { istDay } from '../days.js';
import type { Actor, Collections, RankedDoc, UserDoc } from '../db/documents.js';
import { DEFAULT_RATING, rate, type Rating } from '../rating.js';
import { divisionOf, RANK_DAILY_CAP, type CoinResult, type PublicProfile, type RankView } from '../types.js';
import { ApiError } from '../http/errors.js';
import { rankedSeasonNow, type SettingsService } from './settings.js';

/** rank points for each point of hidden skill (mu) won or lost */
const POINTS_PER_MU = 40;
/** a write that lost to another one is tried again, up to this many tries in all */
const MAX_TRIES = 5;

/** one player of a finished ranked game */
export interface RankedSeat {
  memberId: string;
  userId: ObjectId;
  won: boolean;
  /** finishing place, or null when they didn't finish (the last player, a walk-out) */
  place: number | null;
}

/** one player's result from a rated game */
export type RankResult = NonNullable<CoinResult['rank']>;

/** the stored standing if it's from this season; another season's starts fresh */
const ofSeason = (doc: RankedDoc | undefined, season: number): RankedDoc | null => (doc && doc.season === season ? doc : null);

/** the hidden skill to rate from: the stored one, or a fresh start */
const ratingOf = (doc: RankedDoc | null): Rating =>
  doc && Number.isFinite(doc.mu) && Number.isFinite(doc.sigma) && doc.sigma > 0 ? { mu: doc.mu, sigma: doc.sigma } : { ...DEFAULT_RATING };

/** my standing this season for my own screens; null before my first ranked game of the season */
export function rankViewOf(doc: RankedDoc | undefined, season = rankedSeasonNow(), now = new Date()): RankView | null {
  const r = ofSeason(doc, season);
  if (!r) return null;
  return {
    season: r.season,
    points: r.points,
    division: divisionOf(r.points).id,
    floor: r.floor,
    games: r.games,
    wins: r.wins,
    today: r.day === istDay(now) ? r.today : 0,
  };
}

/** division and points for a player card; null before a ranked game this season */
export function rankBadgeOf(doc: RankedDoc | undefined, season = rankedSeasonNow()): PublicProfile['rank'] {
  const r = ofSeason(doc, season);
  return r ? { division: divisionOf(r.points).id, points: r.points } : null;
}

/** finishing order as ranks (1 is best): winners 1, then 1 + place, and everyone who didn't finish tied last */
export function ranksOf(seats: Pick<RankedSeat, 'won' | 'place'>[]): number[] {
  const last = Math.max(0, ...seats.map((s) => s.place ?? 0)) + 2;
  return seats.map((s) => (s.won ? 1 : s.place !== null ? 1 + s.place : last));
}

/** a standing after one rated game: hidden skill moves freely; points move within the daily cap and never below the floor */
export function nextStanding(
  prev: RankedDoc | null,
  season: number,
  before: Rating,
  after: Rating,
  won: boolean,
  day: string,
): { doc: RankedDoc; result: RankResult } {
  const points0 = prev?.points ?? 0;
  const floor0 = prev?.floor ?? 0;
  const debt0 = prev?.debt ?? 0;
  const sofar = prev && prev.day === day ? prev.today : 0;
  const raw = Math.round(POINTS_PER_MU * (after.mu - before.mu));
  // a gain first pays back losses the floor or the cap held off, so taking turns to win can't lift both players
  const payback = raw > 0 ? Math.min(debt0, raw) : 0;
  const wanted = raw - payback;
  // today's total stays within the cap either way, and a win never turns into a loss
  const allowed = Math.min(Math.max(wanted, Math.min(0, -RANK_DAILY_CAP - sofar)), Math.max(0, RANK_DAILY_CAP - sofar));
  const points = Math.max(floor0, points0 + allowed);
  const change = points - points0;
  // the part of a loss that was held off is owed
  const debt = debt0 - payback + (raw < 0 ? change - raw : 0);
  const doc: RankedDoc = {
    season,
    mu: after.mu,
    sigma: after.sigma,
    points,
    // reaching a division makes its start the floor for the rest of the season
    floor: Math.max(floor0, divisionOf(points).min),
    games: (prev?.games ?? 0) + 1,
    wins: (prev?.wins ?? 0) + (won ? 1 : 0),
    day,
    today: sofar + change,
    debt,
  };
  // the floor is what stopped it when it bit last; otherwise the daily cap, if it trimmed anything; otherwise a payback
  const held = points !== points0 + allowed ? 'floor' : allowed !== wanted ? 'cap' : payback > 0 ? 'debt' : null;
  return { doc, result: { before: points0, after: points, division: divisionOf(points).id, held } };
}

/** ranked play: a hidden skill rating per season, shown as rank points with divisions, floors and a daily cap */
export class RankedService {
  constructor(
    private readonly cols: Collections,
    private readonly settings: SettingsService,
  ) {}

  /** rates one finished ranked game; each rated player's result by member id */
  async rate(seats: RankedSeat[], now = new Date(), teams = false): Promise<Map<string, RankResult>> {
    const out = new Map<string, RankResult>();
    if (seats.length < 2) return out;
    // 2v2: the winning pair against the losing pair; otherwise everyone on their own, in finishing order
    const won = seats.flatMap((s, i) => (s.won ? [i] : []));
    const lost = seats.flatMap((s, i) => (s.won ? [] : [i]));
    const groups = teams && won.length > 0 && lost.length > 0 ? [won, lost] : seats.map((_, i) => [i]);
    const ranks = groups.length === 2 && teams ? [1, 2] : ranksOf(seats);
    const day = istDay(now);
    const season = this.settings.rankedSeason;
    const users = await this.cols.users.find({ _id: { $in: seats.map((s) => s.userId) } }, { projection: { ranked: 1 } }).toArray();
    const stored = new Map(users.map((u) => [u._id.toHexString(), u.ranked]));
    // everyone's skill going into the game
    const before = seats.map((s) => ratingOf(ofSeason(stored.get(s.userId.toHexString()), season)));
    for (const [i, seat] of seats.entries()) {
      const key = seat.userId.toHexString();
      if (!stored.has(key)) continue;
      const result = await this.save(seat, i, before, groups, ranks, stored.get(key), day, season);
      if (result) out.set(seat.memberId, result);
    }
    return out;
  }

  /** starts a new season for everyone; returns its number. from: the season the admin saw, so a stale screen can't start an extra one */
  async newSeason(by: Actor, from?: number): Promise<number> {
    if (from !== undefined && from !== this.settings.rankedSeason) throw new ApiError(409, 'The season already changed. Have a look first');
    const season = await this.settings.nextRankedSeason(by.userId);
    // in the admin's own history, like the other app-wide settings
    if (by.userId) {
      await this.cols.audit.insertOne({
        _id: new ObjectId(),
        action: 'settings',
        targetUserId: by.userId,
        byUserId: by.userId,
        via: by.via,
        detail: `Ranked season ${season} started`,
        createdAt: new Date(),
      });
    }
    return season;
  }

  /** saves one player's new standing, guarded by what was read, so another game or a new season in between is never overwritten; null if the account is gone */
  private async save(
    seat: RankedSeat,
    i: number,
    before: Rating[],
    groups: number[][],
    ranks: number[],
    first: RankedDoc | undefined,
    day: string,
    season: number,
  ): Promise<RankResult | null> {
    let stored = first;
    const g = groups.findIndex((group) => group.includes(i));
    for (let tries = 0; tries < MAX_TRIES; tries++) {
      // a new season started since this game was read: it belongs to the old one, which is over
      if (stored && stored.season > season) return null;
      const prev = ofSeason(stored, season);
      // my rating as it is now; everyone else's as it was going into this game
      const mine = ratingOf(prev);
      const after = rate(groups.map((group) => group.map((j) => (j === i ? mine : before[j]))), ranks)[g][groups[g].indexOf(i)];
      const { doc, result } = nextStanding(prev, season, mine, after, seat.won, day);
      const guard: Filter<UserDoc> = stored
        ? { _id: seat.userId, 'ranked.season': stored.season, 'ranked.games': stored.games }
        : { _id: seat.userId, ranked: { $exists: false } };
      if ((await this.cols.users.updateOne(guard, { $set: { ranked: doc } })).matchedCount === 1) return result;
      const user = await this.cols.users.findOne({ _id: seat.userId }, { projection: { ranked: 1 } });
      if (!user) return null;
      stored = user.ranked;
    }
    console.error('[ranked] gave up saving a rank after', MAX_TRIES, 'tries');
    return null;
  }
}
