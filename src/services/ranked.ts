import { ObjectId, type Filter, type UpdateFilter, type WithId } from 'mongodb';
import { istDay } from '../days.js';
import type { Actor, Collections, RankedDoc, UserDoc } from '../db/documents.js';
import { DEFAULT_RATING, rate, type Rating } from '../rating.js';
import {
  divisionOf,
  RANK_DAILY_CAP,
  RANK_DIVISIONS,
  RANK_PROTECTION,
  RANK_SEASON_DROP,
  SEASON_START_DELAY_DAYS,
  type CoinResult,
  type PublicProfile,
  type RankView,
  type SeasonResult,
} from '../types.js';
import { ApiError } from '../http/errors.js';
import { rankedSeasonDates, rankedSeasonNow, type SettingsService } from './settings.js';

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

/** the top division has no end, so it counts as this wide when working out how far into it someone is */
const TOP_DIVISION_WIDTH = 700;
const DAY_MS = 86_400_000;

/** points as one scale of divisions: the division's index plus how far into it (Gold 950 is 2.5) */
export function divisionPosition(points: number): number {
  const i = RANK_DIVISIONS.indexOf(divisionOf(points));
  const from = RANK_DIVISIONS[i].min;
  const to = RANK_DIVISIONS[i + 1]?.min ?? from + TOP_DIVISION_WIDTH;
  return i + (points - from) / (to - from);
}

/** the points at a place on that scale; nothing below 0 */
function pointsAt(position: number): number {
  if (position <= 0) return 0;
  const i = Math.min(Math.floor(position), RANK_DIVISIONS.length - 1);
  const from = RANK_DIVISIONS[i].min;
  const to = RANK_DIVISIONS[i + 1]?.min ?? from + TOP_DIVISION_WIDTH;
  return Math.round(from + (position - i) * (to - from));
}

/** where a new season starts someone who ended the last one on these points: RANK_SEASON_DROP divisions lower */
export const seasonStartPoints = (points: number): number => pointsAt(divisionPosition(points) - RANK_SEASON_DROP);

/** the division shown for these points: the one they're in, or the one above while within RANK_PROTECTION of its start (floor) */
export const shownDivision = (points: number, floor = 0) => divisionOf(Math.max(points, floor));

/** the start of the division shown after a change: up when points reach a new division, kept within the protection, else down */
export function shownFloor(points: number, floor0: number): number {
  const reached = divisionOf(points).min;
  if (reached >= floor0) return reached;
  return points >= floor0 - RANK_PROTECTION ? floor0 : reached;
}

/** one finished season, for the history */
const resultOf = (doc: RankedDoc): SeasonResult => ({
  season: doc.season,
  division: shownDivision(doc.points, doc.floor).id,
  points: doc.points,
  games: doc.games,
  wins: doc.wins,
});

/**
 * the standing to use in this season: the stored one when it's this season's; one from an earlier season carried into this one
 * (dropped a little for each season since, skill kept, games counted again); null with none stored or one from a later season
 */
export function standingIn(doc: RankedDoc | undefined, season: number): RankedDoc | null {
  if (!doc || doc.season > season) return null;
  if (doc.season === season) return doc;
  let points = doc.points;
  for (let s = doc.season; s < season; s++) points = seasonStartPoints(points);
  return { season, mu: doc.mu, sigma: doc.sigma, points, floor: divisionOf(points).min, games: 0, wins: 0, day: '', today: 0, debt: 0 };
}

/** earlier seasons played, newest first: the saved ones plus a stored standing not yet moved into the season now on */
export function seasonsPlayed(u: Pick<UserDoc, 'ranked' | 'rankHistory'>, season = rankedSeasonNow()): SeasonResult[] {
  const list = [...(u.rankHistory ?? [])];
  const doc = u.ranked;
  if (doc && doc.season < season && doc.games > 0 && !list.some((h) => h.season === doc.season)) list.push(resultOf(doc));
  return list.filter((h) => h.season < season).sort((a, b) => b.season - a.season);
}

/** the hidden skill to rate from: the stored one, or a fresh start */
const ratingOf = (doc: RankedDoc | null): Rating =>
  doc && Number.isFinite(doc.mu) && Number.isFinite(doc.sigma) && doc.sigma > 0 ? { mu: doc.mu, sigma: doc.sigma } : { ...DEFAULT_RATING };

/** my standing this season for my own screens; everyone starts at Bronze 0, or where last season's standing carries them */
export function rankViewOf(
  doc: RankedDoc | undefined,
  season = rankedSeasonNow(),
  now = new Date(),
  history: SeasonResult[] = [],
): RankView {
  const r = standingIn(doc, season);
  const dates = rankedSeasonDates();
  return {
    season,
    points: r?.points ?? 0,
    division: shownDivision(r?.points ?? 0, r?.floor ?? 0).id,
    floor: r?.floor ?? 0,
    games: r?.games ?? 0,
    wins: r?.wins ?? 0,
    today: r && r.day === istDay(now) ? r.today : 0,
    startedAt: dates.startedAt?.toISOString() ?? null,
    nextAt: dates.nextAt?.toISOString() ?? null,
    history,
  };
}

/** division and points for a player card; Bronze 0 before any ranked game */
export function rankBadgeOf(doc: RankedDoc | undefined, season = rankedSeasonNow()): NonNullable<PublicProfile['rank']> {
  const r = standingIn(doc, season);
  return { division: shownDivision(r?.points ?? 0, r?.floor ?? 0).id, points: r?.points ?? 0 };
}

/** finishing order as ranks (1 is best): winners 1, then 1 + place, and everyone who didn't finish tied last */
export function ranksOf(seats: Pick<RankedSeat, 'won' | 'place'>[]): number[] {
  const last = Math.max(0, ...seats.map((s) => s.place ?? 0)) + 2;
  return seats.map((s) => (s.won ? 1 : s.place !== null ? 1 + s.place : last));
}

/** a standing after one rated game: hidden skill moves freely; points move within the daily cap and never below 0; the division shown has a RANK_PROTECTION buffer */
export function nextStanding(
  prev: RankedDoc | null,
  season: number,
  before: Rating,
  after: Rating,
  won: boolean,
  day: string,
  /** they hold a Rank Shield: a loss that would cost points costs none and uses it up */
  shield = false,
): { doc: RankedDoc; result: RankResult; shielded: boolean } {
  const points0 = prev?.points ?? 0;
  const floor0 = prev?.floor ?? 0;
  const debt0 = prev?.debt ?? 0;
  const sofar = prev && prev.day === day ? prev.today : 0;
  const skill = Math.round(POINTS_PER_MU * (after.mu - before.mu));
  // by the division shown: wins give less and losses weigh more the higher it is (1:4 in Bronze to 1:1.5 at the top)
  const division = shownDivision(points0, floor0);
  const raw = Math.round(skill * (skill < 0 ? division.loss : division.win));
  // a gain first pays back losses 0 points or the cap held off, so taking turns to win can't lift both players
  const payback = raw > 0 ? Math.min(debt0, raw) : 0;
  const wanted = raw - payback;
  // today's total stays within the cap either way, and a win never turns into a loss
  const allowed = Math.min(Math.max(wanted, Math.min(0, -RANK_DAILY_CAP - sofar)), Math.max(0, RANK_DAILY_CAP - sofar));
  const capped = Math.max(0, points0 + allowed);
  // a shield stops a loss that would really cost points; nothing is owed for it
  const shielded = shield && capped < points0;
  const points = shielded ? points0 : capped;
  const change = points - points0;
  // the part of a loss that was held off is owed (not when a shield took it)
  const debt = debt0 - payback + (raw < 0 && !shielded ? change - raw : 0);
  const doc: RankedDoc = {
    season,
    mu: after.mu,
    sigma: after.sigma,
    points,
    // the division shown: up on reaching a new one, kept while within the protection, down below it
    floor: shownFloor(points, floor0),
    games: (prev?.games ?? 0) + 1,
    wins: (prev?.wins ?? 0) + (won ? 1 : 0),
    day,
    today: sofar + change,
    debt,
  };
  // 0 points is what stopped it when it bit last; otherwise the daily cap, a payback, or the protection keeping the division
  const kept = change < 0 && points < doc.floor;
  const held = shielded
    ? 'shield'
    : points !== points0 + allowed
      ? 'floor'
      : allowed !== wanted
        ? 'cap'
        : payback > 0
          ? 'debt'
          : kept
            ? 'grace'
            : null;
  return { doc, result: { before: points0, after: points, division: shownDivision(points, doc.floor).id, held }, shielded };
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
    const users = await this.cols.users.find({ _id: { $in: seats.map((s) => s.userId) } }, { projection: { ranked: 1, 'shop.shields': 1 } }).toArray();
    const stored = new Map(users.map((u) => [u._id.toHexString(), u.ranked]));
    const shieldsOf = new Map(users.map((u) => [u._id.toHexString(), u.shop?.shields ?? 0]));
    // everyone's skill going into the game
    const before = seats.map((s) => ratingOf(standingIn(stored.get(s.userId.toHexString()), season)));
    for (const [i, seat] of seats.entries()) {
      const key = seat.userId.toHexString();
      if (!stored.has(key)) continue;
      const result = await this.save(seat, i, before, groups, ranks, stored.get(key), shieldsOf.get(key) ?? 0, day, season);
      if (result) out.set(seat.memberId, result);
    }
    return out;
  }

  /**
   * books the next season to start SEASON_START_DELAY_DAYS from now; the season now on and when the next starts.
   * from: the season the admin saw, so a stale screen can't book an extra one
   */
  async newSeason(by: Actor, from?: number, now = new Date()): Promise<{ season: number; nextSeasonAt: string }> {
    const season = this.settings.rankedSeason;
    if (from !== undefined && from !== season) throw new ApiError(409, 'The season already changed. Have a look first');
    const at = new Date(now.getTime() + SEASON_START_DELAY_DAYS * DAY_MS);
    if (!(await this.settings.scheduleNextSeason(by.userId, at, now))) throw new ApiError(409, 'The next season is already booked');
    await this.log(by, `Ranked season ${season + 1} booked to start on ${at.toISOString().slice(0, 10)}`);
    return { season, nextSeasonAt: at.toISOString() };
  }

  /** calls off the booked season before it starts */
  async cancelNewSeason(by: Actor): Promise<void> {
    if (!(await this.settings.cancelNextSeason(by.userId))) throw new ApiError(409, 'No new season is booked');
    await this.log(by, `Ranked season ${this.settings.rankedSeason + 1} called off`);
  }

  /** starts the booked season once its time has come; its number, or null when nothing was due */
  startDueSeason(now = new Date()): Promise<number | null> {
    return this.settings.startDueSeason(now);
  }

  /**
   * moves a standing from an earlier season into the one now on (when the player opens the app): the old season goes into the
   * history and the new one starts RANK_SEASON_DROP divisions lower. Guarded like a rated game, so neither overwrites the other
   */
  async rollover(u: WithId<UserDoc>): Promise<WithId<UserDoc>> {
    const season = this.settings.rankedSeason;
    const doc = u.ranked;
    if (!doc || doc.season >= season) return u;
    const update: UpdateFilter<UserDoc> = { $set: { ranked: standingIn(doc, season)! } };
    if (doc.games > 0) update.$push = { rankHistory: resultOf(doc) };
    const after = await this.cols.users.findOneAndUpdate({ _id: u._id, 'ranked.season': doc.season, 'ranked.games': doc.games }, update, {
      returnDocument: 'after',
    });
    return after ?? (await this.cols.users.findOne({ _id: u._id })) ?? u;
  }

  /** in the admin's own history, like the other app-wide settings */
  private async log(by: Actor, detail: string): Promise<void> {
    if (!by.userId) return;
    await this.cols.audit.insertOne({
      _id: new ObjectId(),
      action: 'settings',
      targetUserId: by.userId,
      byUserId: by.userId,
      via: by.via,
      detail,
      createdAt: new Date(),
    });
  }

  /** saves one player's new standing, guarded by what was read, so another game or a new season in between is never overwritten; null if the account is gone */
  private async save(
    seat: RankedSeat,
    i: number,
    before: Rating[],
    groups: number[][],
    ranks: number[],
    first: RankedDoc | undefined,
    firstShields: number,
    day: string,
    season: number,
  ): Promise<RankResult | null> {
    let stored = first;
    let shields = firstShields;
    const g = groups.findIndex((group) => group.includes(i));
    for (let tries = 0; tries < MAX_TRIES; tries++) {
      // a new season started since this game was read: it belongs to the old one, which is over
      if (stored && stored.season > season) return null;
      const prev = standingIn(stored, season);
      // my rating as it is now; everyone else's as it was going into this game
      const mine = ratingOf(prev);
      const after = rate(groups.map((group) => group.map((j) => (j === i ? mine : before[j]))), ranks)[g][groups[g].indexOf(i)];
      const { doc, result, shielded } = nextStanding(prev, season, mine, after, seat.won, day, shields > 0);
      const guard: Filter<UserDoc> = stored
        ? { _id: seat.userId, 'ranked.season': stored.season, 'ranked.games': stored.games }
        : { _id: seat.userId, ranked: { $exists: false } };
      // a shield is used up in the same write, and only if it's still there
      if (shielded) guard['shop.shields'] = { $gte: 1 };
      const update: UpdateFilter<UserDoc> = shielded ? { $set: { ranked: doc }, $inc: { 'shop.shields': -1, 'shop.rev': 1 } } : { $set: { ranked: doc } };
      // a standing from an earlier season moves into this one: that season goes into the history
      if (stored && stored.season < season && stored.games > 0) update.$push = { rankHistory: resultOf(stored) };
      if ((await this.cols.users.updateOne(guard, update)).matchedCount === 1) return result;
      const user = await this.cols.users.findOne({ _id: seat.userId }, { projection: { ranked: 1, 'shop.shields': 1 } });
      if (!user) return null;
      stored = user.ranked;
      shields = user.shop?.shields ?? 0;
    }
    console.error('[ranked] gave up saving a rank after', MAX_TRIES, 'tries');
    return null;
  }
}
