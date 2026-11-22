import type { AnyBulkWriteOperation, ObjectId } from 'mongodb';
import type { Collections, GameDoc, GamePlayerDoc, RivalTallyDoc, UserDoc } from '../db/documents.js';
import { levelOf, MIN_REWARD_GAME_SEC, RIVAL_MIN_GAMES, type RivalRecord, type RivalsResponse } from '../types.js';
import { avatarOf, statsOf } from './users.js';

/** a friendship's key: both user ids sorted and joined, as in services/friends.ts */
const pairOf = (a: ObjectId, b: ObjectId) => [a.toHexString(), b.toHexString()].sort().join('_');

/** my games together with one opponent, from the running totals */
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

type Seat = Pick<GamePlayerDoc, 'userId' | 'won' | 'place' | 'kicked' | 'bot'>;

/** one game for x against y: 1 when x finished ahead, -1 behind, 0 when neither was */
export function aheadOf(x: Seat, y: Seat): number {
  // a win beats not winning
  if (!!x.won !== !!y.won) return x.won ? 1 : -1;
  const px = typeof x.place === 'number';
  const py = typeof y.place === 'number';
  // both placed: the better place is ahead; placed beats not placed
  if (px && py) return Math.sign(y.place! - x.place!);
  if (px !== py) return px ? 1 : -1;
  return 0;
}

/** what one saved game adds to each pair of accounts in it: finished, a minute or more, both seated as people */
export function tallyOps(game: Pick<GameDoc, 'status' | 'durationSec' | 'players' | 'catches'>): AnyBulkWriteOperation<RivalTallyDoc>[] {
  if (game.status !== 'finished' || game.durationSec < MIN_REWARD_GAME_SEC) return [];
  const people = game.players.filter((p) => p.userId && !p.kicked && !p.bot);
  const caught = (by: ObjectId, of: ObjectId) =>
    (game.catches ?? []).reduce((n, c) => (c.by.equals(by) && c.of.equals(of) ? n + c.n : n), 0);
  const ops: AnyBulkWriteOperation<RivalTallyDoc>[] = [];
  for (let i = 0; i < people.length; i++) {
    for (let j = i + 1; j < people.length; j++) {
      const [x, y] = people[i].userId!.toHexString() < people[j].userId!.toHexString() ? [people[i], people[j]] : [people[j], people[i]];
      const [a, b] = [x.userId!, y.userId!];
      if (a.equals(b)) continue;
      const ahead = aheadOf(x, y);
      ops.push({
        updateOne: {
          filter: { _id: pairOf(a, b) },
          update: {
            $setOnInsert: { a, b },
            $inc: { games: 1, aAhead: ahead === 1 ? 1 : 0, bAhead: ahead === -1 ? 1 : 0, aCaught: caught(a, b), bCaught: caught(b, a) },
          },
          upsert: true,
        },
      });
    }
  }
  return ops;
}

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

  /** my running totals against each of these accounts (kept up to date as games are saved) */
  private async tally(me: ObjectId, opponents: ObjectId[]): Promise<Tally[]> {
    if (opponents.length === 0) return [];
    const docs = await this.cols.rivals.find({ _id: { $in: opponents.map((o) => pairOf(me, o)) } }).toArray();
    return docs.flatMap((d) => {
      if (d.games <= 0) return [];
      const iAmA = d.a.equals(me);
      return [
        {
          _id: iAmA ? d.b : d.a,
          games: d.games,
          ahead: iAmA ? d.aAhead : d.bAhead,
          behind: iAmA ? d.bAhead : d.aAhead,
          iCaught: iAmA ? d.aCaught : d.bCaught,
          theyCaught: iAmA ? d.bCaught : d.aCaught,
        },
      ];
    });
  }

  /** adds one saved game to the pairs' totals */
  async count(game: Pick<GameDoc, 'status' | 'durationSec' | 'players' | 'catches'>): Promise<void> {
    const ops = tallyOps(game);
    if (ops.length > 0) await this.cols.rivals.bulkWrite(ops, { ordered: false });
  }

  /** adds every game not counted yet (games saved before the totals existed); each game is claimed first, so none counts twice */
  async backfill(): Promise<number> {
    let added = 0;
    const cursor = this.cols.games.find(
      { status: 'finished', durationSec: { $gte: MIN_REWARD_GAME_SEC }, rivalsCounted: { $ne: true } },
      { projection: { status: 1, durationSec: 1, players: 1, catches: 1 } },
    );
    for await (const g of cursor) {
      const claimed = await this.cols.games.updateOne({ _id: g._id, rivalsCounted: { $ne: true } }, { $set: { rivalsCounted: true } });
      if (claimed.modifiedCount === 0) continue;
      await this.count(g);
      added++;
    }
    return added;
  }

  /** the backfill once per database: skipped for good once it has finished */
  async backfillOnce(): Promise<void> {
    const s = await this.cols.settings.findOne({ _id: 'app' }, { projection: { rivalsBackfilled: 1 } });
    if (s?.rivalsBackfilled) return;
    const added = await this.backfill();
    await this.cols.settings.updateOne({ _id: 'app' }, { $set: { rivalsBackfilled: true } });
    if (added > 0) console.log(`[rivals] added ${added} older games to the head-to-head totals`);
  }
}
