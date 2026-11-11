import { MongoServerError, ObjectId, type WithId } from 'mongodb';
import type { Collections, FriendDoc, UserDoc } from '../db/documents.js';
import { ApiError } from '../http/errors.js';
import { levelOf, type FriendView, type PlayerSearchResult, type PublicProfile } from '../types.js';
import { escapeRegex, statsOf } from './users.js';

const pairOf = (a: ObjectId, b: ObjectId) => [a.toHexString(), b.toHexString()].sort().join('_');

/** friend requests and friendships; one document per pair of users */
export class FriendService {
  constructor(private readonly cols: Collections) {}

  /** online and inRoom are filled in by the caller from live presence and rooms */
  async list(me: ObjectId): Promise<{ friends: FriendView[]; incoming: FriendView[]; outgoing: FriendView[] }> {
    const links = await this.cols.friends.find({ $or: [{ requester: me }, { recipient: me }] }).toArray();
    const otherOf = (f: FriendDoc) => (f.requester.equals(me) ? f.recipient : f.requester);
    const users = await this.cols.users
      .find({ _id: { $in: links.map(otherOf) } }, { projection: { username: 1, displayName: 1, stats: 1 } })
      .toArray();
    const byId = new Map(users.map((u) => [u._id.toHexString(), u]));
    const view = (f: FriendDoc): FriendView[] => {
      const u = byId.get(otherOf(f).toHexString());
      return u
        ? [{ id: u._id.toHexString(), username: u.username, displayName: u.displayName, online: false, level: levelOf(statsOf(u)), inRoom: null, roomPhase: null }]
        : [];
    };
    const byName = (a: FriendView, b: FriendView) => a.displayName.localeCompare(b.displayName);
    return {
      friends: links.filter((f) => f.status === 'accepted').flatMap(view).sort(byName),
      incoming: links.filter((f) => f.status === 'pending' && f.recipient.equals(me)).flatMap(view).sort(byName),
      outgoing: links.filter((f) => f.status === 'pending' && f.requester.equals(me)).flatMap(view).sort(byName),
    };
  }

  /** sends a request; if they already asked me, this accepts it instead */
  async request(me: WithId<UserDoc>, username: string): Promise<{ result: 'sent' | 'accepted'; otherId: ObjectId }> {
    const other = await this.cols.users.findOne({ username }, { projection: { _id: 1 } });
    if (!other) throw new ApiError(404, 'No player with that username');
    if (other._id.equals(me._id)) throw new ApiError(400, "That's you!");
    const pair = pairOf(me._id, other._id);
    const existing = await this.cols.friends.findOne({ pair });
    if (existing?.status === 'accepted') throw new ApiError(409, 'You are already friends');
    if (existing?.requester.equals(other._id)) {
      await this.cols.friends.updateOne({ _id: existing._id }, { $set: { status: 'accepted', acceptedAt: new Date() } });
      return { result: 'accepted', otherId: other._id };
    }
    if (existing) throw new ApiError(409, 'Request already sent');
    try {
      await this.cols.friends.insertOne({
        _id: new ObjectId(),
        pair,
        requester: me._id,
        recipient: other._id,
        status: 'pending',
        createdAt: new Date(),
      });
    } catch (err) {
      if (err instanceof MongoServerError && err.code === 11000) throw new ApiError(409, 'Request already sent');
      throw err;
    }
    return { result: 'sent', otherId: other._id };
  }

  async accept(me: ObjectId, otherId: ObjectId): Promise<void> {
    const res = await this.cols.friends.updateOne(
      { pair: pairOf(me, otherId), recipient: me, status: 'pending' },
      { $set: { status: 'accepted', acceptedAt: new Date() } },
    );
    if (res.matchedCount === 0) throw new ApiError(404, 'No friend request from that player');
  }

  /** declines, cancels or unfriends, whichever applies */
  async remove(me: ObjectId, otherId: ObjectId): Promise<void> {
    await this.cols.friends.deleteOne({ pair: pairOf(me, otherId) });
  }

  /** requests waiting for me to accept */
  async incomingCount(me: ObjectId): Promise<number> {
    return this.cols.friends.countDocuments({ recipient: me, status: 'pending' });
  }

  /** players whose username starts with, or display name contains, the text; online is filled in by the caller */
  async search(me: ObjectId, text: string): Promise<PlayerSearchResult[]> {
    const q = escapeRegex(text.trim().toLowerCase());
    if (q.length < 2) return [];
    const users = await this.cols.users
      .find(
        {
          _id: { $ne: me },
          blocked: { $ne: true },
          $or: [{ username: { $regex: `^${q}` } }, { displayName: { $regex: q, $options: 'i' } }],
        },
        { projection: { username: 1, displayName: 1, stats: 1 } },
      )
      .sort({ username: 1 })
      .limit(8)
      .toArray();
    const links = await this.cols.friends.find({ pair: { $in: users.map((u) => pairOf(me, u._id)) } }).toArray();
    const linkOf = new Map(links.map((l) => [l.pair, l]));
    return users.map((u) => {
      const link = linkOf.get(pairOf(me, u._id));
      const status: PlayerSearchResult['status'] = !link
        ? 'none'
        : link.status === 'accepted'
          ? 'friend'
          : link.requester.equals(me)
            ? 'sent'
            : 'incoming';
      return { id: u._id.toHexString(), username: u.username, displayName: u.displayName, level: levelOf(statsOf(u)), online: false, status };
    });
  }

  /** a player's public card by username; online is filled in by the caller. Blocked accounts are hidden */
  async profileOf(me: ObjectId, username: string): Promise<PublicProfile> {
    const u = await this.cols.users.findOne(
      { username, blocked: { $ne: true } },
      { projection: { username: 1, displayName: 1, stats: 1, createdAt: 1 } },
    );
    if (!u) throw new ApiError(404, 'No player with that username');
    let status: PublicProfile['status'] = 'me';
    if (!u._id.equals(me)) {
      const link = await this.cols.friends.findOne({ pair: pairOf(me, u._id) });
      status = !link ? 'none' : link.status === 'accepted' ? 'friend' : link.requester.equals(me) ? 'sent' : 'incoming';
    }
    const stats = statsOf(u);
    return {
      id: u._id.toHexString(),
      username: u.username,
      displayName: u.displayName,
      level: levelOf(stats),
      joinedAt: u.createdAt.toISOString(),
      online: false,
      stats,
      status,
    };
  }

  async countFor(me: ObjectId): Promise<number> {
    return this.cols.friends.countDocuments({ status: 'accepted', $or: [{ requester: me }, { recipient: me }] });
  }

  async areFriends(a: string, b: string): Promise<boolean> {
    const pair = [a, b].sort().join('_');
    return (await this.cols.friends.countDocuments({ pair, status: 'accepted' }, { limit: 1 })) === 1;
  }
}
