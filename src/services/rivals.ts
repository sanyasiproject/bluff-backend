import type { Document, ObjectId } from 'mongodb';
import type { Collections, UserDoc } from '../db/documents.js';
import { levelOf, MIN_REWARD_GAME_SEC, RIVAL_MIN_GAMES, type RivalRecord, type RivalsResponse } from '../types.js';
import { avatarOf, statsOf } from './users.js';

/** a friendship's key: both user ids sorted and joined, as in services/friends.ts */
const pairOf = (a: ObjectId, b: ObjectId) => [a.toHexString(), b.toHexString()].sort().join('_');

/** my games together with one opponent, as the aggregation sums them up */
interface Tally {
  _id: ObjectId;
  games: number;
  ahead: number;
  behind: number;
  iCaught: number;
  theyCaught: number;
}

/** the account fields a record shows */
type Shown = Pick<UserDoc, '_id' | 'username' | 'displayName' | 'avatar' | 'stats'>;
const SHOWN = { username: 1, displayName: 1, avatar: 1, stats: 1 } as const;

/** a seat that counts: a logged-in person the host didn't remove (bots and guests have no userId) */
const person = (seat: string): Document => ({ [`${seat}.kicked`]: { $ne: true }, [`${seat}.bot`]: { $ne: true } });
const won = (seat: string): Document => ({ $eq: [`$${seat}.won`, true] });
const placed = (seat: string): Document => ({ $isNumber: `$${seat}.place` });

/** one game for me against one opponent: 1 when I finished ahead, -1 behind, 0 when neither was */
const AHEAD: Document = {
  $switch: {
    branches: [
      // a win beats not winning
      { case: { $ne: [won('mine'), won('them')] }, then: { $cond: [won('mine'), 1, -1] } },
      // both finished: the better place is ahead
      { case: { $and: [placed('mine'), placed('them')] }, then: { $cmp: ['$them.place', '$mine.place'] } },
      // finishing beats not finishing
      { case: { $ne: [placed('mine'), placed('them')] }, then: { $cond: [placed('mine'), 1, -1] } },
    ],
    default: 0,
  },
};

/** times `by` caught `of` lying in this game; older games have no catches */
const caught = (by: unknown, of: unknown): Document => ({
  $sum: {
    $map: {
      input: { $filter: { input: { $ifNull: ['$catches', []] }, as: 'c', cond: { $and: [{ $eq: ['$$c.by', by] }, { $eq: ['$$c.of', of] }] } } },
      as: 'c',
      in: '$$c.n',
    },
  },
});

/** a tag once enough games had one of us ahead: nemesis when they were ahead in 60% or more, rival when 40% to 60%; never one for being ahead */
export function rivalTag(ahead: number, behind: number): RivalRecord['tag'] {
  const decided = ahead + behind;
  if (decided < RIVAL_MIN_GAMES) return null;
  // whole numbers, so 60% and 40% are exact
  if (behind * 5 >= decided * 3) return 'nemesis';
  if (behind * 5 >= decided * 2) return 'rival';
  return null;
}

const recordOf = (u: Shown, t: Tally): RivalRecord => ({
  id: u._id.toHexString(),
  username: u.username,
  displayName: u.displayName,
  avatar: avatarOf(u),
  level: levelOf(statsOf(u)),
  games: t.games,
  ahead: t.ahead,
  behind: t.behind,
  iCaught: t.iCaught,
  theyCaught: t.theyCaught,
  tag: rivalTag(t.ahead, t.behind),
});

/** head-to-head records and the Dosti meter between friends, worked out from saved games */
export class RivalService {
  constructor(private readonly cols: Collections) {}

  /** my record against every friend I've finished a game with */
  async list(me: ObjectId): Promise<RivalsResponse> {
    const links = await this.cols.friends
      .find({ status: 'accepted', $or: [{ requester: me }, { recipient: me }] }, { projection: { requester: 1, recipient: 1 } })
      .toArray();
    const tallies = await this.tally(
      me,
      links.map((f) => (f.requester.equals(me) ? f.recipient : f.requester)),
    );
    if (tallies.length === 0) return { records: [] };
    // blocked accounts stay hidden, as on profiles
    const users = await this.cols.users.find({ _id: { $in: tallies.map((t) => t._id) }, blocked: { $ne: true } }, { projection: SHOWN }).toArray();
    const byId = new Map(users.map((u) => [u._id.toHexString(), u]));
    const records = tallies.flatMap((t) => {
      const u = byId.get(t._id.toHexString());
      return u ? [recordOf(u, t)] : [];
    });
    // most games together first, then by name
    records.sort((a, b) => b.games - a.games || a.displayName.localeCompare(b.displayName) || a.username.localeCompare(b.username));
    return { records };
  }

  /** my record against one friend by username; null when they aren't my friend or we never finished a game together */
  async withFriend(me: ObjectId, username: string): Promise<RivalRecord | null> {
    const them = await this.cols.users.findOne({ username, blocked: { $ne: true } }, { projection: SHOWN });
    if (!them || them._id.equals(me)) return null;
    const friends = await this.cols.friends.countDocuments({ pair: pairOf(me, them._id), status: 'accepted' }, { limit: 1 });
    if (friends === 0) return null;
    const [t] = await this.tally(me, [them._id]);
    return t ? recordOf(them, t) : null;
  }

  /** my finished games with each of these accounts where we both played as people, summed up per opponent */
  private async tally(me: ObjectId, opponents: ObjectId[]): Promise<Tally[]> {
    if (opponents.length === 0) return [];
    return this.cols.games
      .aggregate<Tally>([
        // my finished games with at least one of them (indexed on players.userId)
        // finished games of a minute or more, like the league and missions
        { $match: { status: 'finished', durationSec: { $gte: MIN_REWARD_GAME_SEC }, $and: [{ 'players.userId': me }, { 'players.userId': { $in: opponents } }] } },
        { $project: { catches: 1, 'players.userId': 1, 'players.won': 1, 'players.place': 1, 'players.kicked': 1, 'players.bot': 1 } },
        // my own seat: a game the host removed me from doesn't count
        { $set: { mine: { $arrayElemAt: [{ $filter: { input: '$players', as: 'p', cond: { $eq: ['$$p.userId', me] } } }, 0] } } },
        { $match: person('mine') },
        { $unwind: '$players' },
        { $project: { catches: 1, mine: 1, them: '$players' } },
        { $match: { 'them.userId': { $in: opponents }, ...person('them') } },
        { $set: { ahead: AHEAD, iCaught: caught(me, '$them.userId'), theyCaught: caught('$them.userId', me) } },
        {
          $group: {
            _id: '$them.userId',
            games: { $sum: 1 },
            ahead: { $sum: { $cond: [{ $eq: ['$ahead', 1] }, 1, 0] } },
            behind: { $sum: { $cond: [{ $eq: ['$ahead', -1] }, 1, 0] } },
            iCaught: { $sum: '$iCaught' },
            theyCaught: { $sum: '$theyCaught' },
          },
        },
      ])
      .toArray();
  }
}
