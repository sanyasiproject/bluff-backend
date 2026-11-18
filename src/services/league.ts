import type { AnyBulkWriteOperation, Document, ObjectId, WithId } from 'mongodb';
import { istWeek, nextIstWeek } from '../days.js';
import type { Collections, LeagueDoc, LeagueWeekDoc, UserDoc } from '../db/documents.js';
import { ApiError } from '../http/errors.js';
import { LEAGUE_CROWNS, LEAGUE_POINTS, levelOf, type LeagueBoard, type LeagueResponse, type LeagueRow, type LeagueStats } from '../types.js';
import { avatarOf, statsOf } from './users.js';

/** one counted game's numbers for one player, for the weekly league */
export interface LeagueGame {
  userId: ObjectId;
  won: boolean;
  goodCalls: number;
  cleanBluffs: number;
}

/** a board row before it's placed */
export type LeagueEntry = Omit<LeagueRow, 'place'>;

const WEEK_MS = 7 * 86_400_000;
const STAT_KEYS = ['points', 'games', 'wins', 'goodCalls', 'cleanBluffs'] as const satisfies readonly (keyof LeagueStats)[];
const NO_GAMES: LeagueStats = { points: 0, games: 0, wins: 0, goodCalls: 0, cleanBluffs: 0 };

/** a whole count that's never negative */
const whole = (n: number) => (Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);

/** the IST week (its Monday) before the one `now` is in */
export const lastIstWeek = (now = new Date()) => istWeek(new Date(now.getTime() - WEEK_MS));

/** league points for one game: each game, a win, liars caught and lies nobody caught */
export const leaguePointsOf = (g: Omit<LeagueGame, 'userId'>) =>
  LEAGUE_POINTS.game + (g.won ? LEAGUE_POINTS.win : 0) + whole(g.goodCalls) * LEAGUE_POINTS.goodCall + whole(g.cleanBluffs) * LEAGUE_POINTS.cleanBluff;

/** a player's counters for one week, from this week's or the kept last week's; null when they didn't play it */
export function weekOf(league: LeagueDoc | undefined, week: string): LeagueStats | null {
  const w: LeagueWeekDoc | null | undefined = league?.week === week ? league : league?.prev?.week === week ? league.prev : null;
  if (!w) return null;
  return { points: w.points ?? 0, games: w.games ?? 0, wins: w.wins ?? 0, goodCalls: w.goodCalls ?? 0, cleanBluffs: w.cleanBluffs ?? 0 };
}

/** sorts and places a week's rows (ties on points and wins share a place) and hands out its crowns */
export function boardOf(week: string, entries: LeagueEntry[]): LeagueBoard {
  const sorted = [...entries].sort(
    (a, b) =>
      b.points - a.points ||
      b.wins - a.wins ||
      b.goodCalls - a.goodCalls ||
      a.displayName.localeCompare(b.displayName) ||
      a.username.localeCompare(b.username),
  );
  const rows: LeagueRow[] = [];
  for (const [i, e] of sorted.entries()) {
    const above = rows[i - 1];
    rows.push({ ...e, place: above && above.points === e.points && above.wins === e.wins ? above.place : i + 1 });
  }
  // a crown goes to everyone with the top number, once someone scored for it
  const crowns = LEAGUE_CROWNS.flatMap((c) => {
    const value = Math.max(0, ...rows.map((r) => r[c.stat]));
    return value > 0 ? [{ id: c.id, userIds: rows.filter((r) => r[c.stat] === value).map((r) => r.id), value }] : [];
  });
  return { week, rows, crowns };
}

/** the update that adds one game to an account's week, starting a new week when the stored one has passed */
function countUpdate(g: LeagueGame, week: string, lastWeek: string): Document[] {
  const add: LeagueStats = { points: leaguePointsOf(g), games: 1, wins: g.won ? 1 : 0, goodCalls: whole(g.goodCalls), cleanBluffs: whole(g.cleanBluffs) };
  const stored = (k: keyof LeagueStats) => ({ $ifNull: [`$league.${k}`, 0] });
  const sum = Object.fromEntries(STAT_KEYS.map((k) => [k, { $add: [stored(k), add[k]] }]));
  const old = Object.fromEntries(STAT_KEYS.map((k) => [k, stored(k)]));
  return [
    {
      $set: {
        league: {
          $switch: {
            branches: [
              // a later week is already there (the clock went back): leave it alone
              { case: { $gt: ['$league.week', week] }, then: '$league' },
              // the same week: add this game
              { case: { $eq: ['$league.week', week] }, then: { week, ...sum, prev: { $ifNull: ['$league.prev', null] } } },
            ],
            // a new week starts from this game; the old one is kept only if it was last week
            default: { week, ...add, prev: { $cond: [{ $eq: ['$league.week', lastWeek] }, { week: lastWeek, ...old }, null] } },
          },
        },
      },
    },
  ];
}

/** who a row is about */
function entryBase(u: WithId<UserDoc>): Omit<LeagueEntry, keyof LeagueStats | 'me'> {
  return { id: u._id.toHexString(), username: u.username, displayName: u.displayName, avatar: avatarOf(u), level: levelOf(statsOf(u)) };
}

/** the weekly friends league: counters per account per IST week, and each player's board of friends */
export class LeagueService {
  constructor(private readonly cols: Collections) {}

  /** adds one counted game (2+ logged-in people) to each of its players' week */
  async count(players: LeagueGame[], now = new Date()): Promise<void> {
    if (players.length === 0) return;
    const week = istWeek(now);
    const lastWeek = lastIstWeek(now);
    // one atomic update per player, so games saved at the same time all count
    const ops: AnyBulkWriteOperation<UserDoc>[] = players.map((g) => ({
      updateOne: { filter: { _id: g.userId }, update: countUpdate(g, week, lastWeek) },
    }));
    await this.cols.users.bulkWrite(ops, { ordered: false });
  }

  /** my board this week, and last week's final one */
  async board(me: ObjectId, now = new Date()): Promise<LeagueResponse> {
    const thisWeek = istWeek(now);
    const lastWeek = lastIstWeek(now);
    const friendIds = await this.friendIdsOf(me);
    const users = await this.cols.users
      .find(
        { _id: { $in: [me, ...friendIds] } },
        { projection: { username: 1, displayName: 1, avatar: 1, stats: 1, league: 1, leagueHidden: 1, blocked: 1 } },
      )
      .toArray();
    const mine = users.find((u) => u._id.equals(me));
    if (!mine) throw new ApiError(404, 'User not found');
    // friends who hid themselves (or were blocked) are left off; I always see myself
    const shown = users.filter((u) => u === mine || (!u.leagueHidden && !u.blocked));
    const entriesOf = (week: string, alwaysMe: boolean): LeagueEntry[] =>
      shown.flatMap((u) => {
        const stats = weekOf(u.league, week);
        const isMe = u === mine;
        if (!(stats && stats.games > 0) && !(isMe && alwaysMe)) return [];
        return [{ ...entryBase(u), ...(stats ?? NO_GAMES), me: isMe }];
      });
    const last = entriesOf(lastWeek, false);
    return {
      thisWeek: boardOf(thisWeek, entriesOf(thisWeek, true)),
      lastWeek: last.length > 0 ? boardOf(lastWeek, last) : null,
      resetAt: nextIstWeek(now).toISOString(),
      hidden: mine.leagueHidden === true,
    };
  }

  /** leaves me off my friends' boards, or puts me back on */
  async setHidden(me: ObjectId, hidden: boolean): Promise<void> {
    const res = await this.cols.users.updateOne({ _id: me }, { $set: { leagueHidden: hidden } });
    if (res.matchedCount === 0) throw new ApiError(404, 'User not found');
  }

  /** my accepted friends, as in FriendService.friendIdsOf */
  private async friendIdsOf(me: ObjectId): Promise<ObjectId[]> {
    const links = await this.cols.friends
      .find({ status: 'accepted', $or: [{ requester: me }, { recipient: me }] }, { projection: { requester: 1, recipient: 1 } })
      .toArray();
    return links.map((f) => (f.requester.equals(me) ? f.recipient : f.requester));
  }
}
