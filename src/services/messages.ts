import { ObjectId } from 'mongodb';
import type { Collections, MessageDoc } from '../db/documents.js';
import { ApiError } from '../http/errors.js';
import { DM_PAGE_SIZE, type DirectMessage, type DmHistoryResponse, type DmUnreadResponse } from '../types.js';
import type { FriendService } from './friends.js';

/** messages kept per pair; older ones are deleted as new ones arrive */
export const DM_KEEP = 200;

const pairOf = (a: string, b: string) => [a, b].sort().join('_');

export const messageView = (m: MessageDoc): DirectMessage => ({
  id: m._id.toHexString(),
  from: m.from.toHexString(),
  to: m.to.toHexString(),
  text: m.text,
  at: m.at.toISOString(),
  read: m.read,
});

/** private 1:1 messages between accepted friends */
export class MessageService {
  constructor(
    private readonly cols: Collections,
    private readonly friends: FriendService,
  ) {}

  /** saves a message from me to a friend; text is already checked */
  async send(me: string, friendId: string, text: string): Promise<DirectMessage> {
    await this.requireFriend(me, friendId);
    const to = await this.cols.users.findOne({ _id: new ObjectId(friendId), blocked: { $ne: true } }, { projection: { _id: 1 } });
    if (!to) throw new ApiError(404, "You can't message this player");
    const doc: MessageDoc = { _id: new ObjectId(), pair: pairOf(me, friendId), from: new ObjectId(me), to: to._id, text, at: new Date(), read: false };
    await this.cols.messages.insertOne(doc);
    await this.prune(doc.pair);
    return messageView(doc);
  }

  /** the newest page before a time (or now), oldest first */
  async history(me: string, friendId: string, before?: Date): Promise<DmHistoryResponse> {
    await this.requireFriend(me, friendId);
    const docs = await this.cols.messages
      .find({ pair: pairOf(me, friendId), ...(before ? { at: { $lt: before } } : {}) })
      .sort({ at: -1, _id: -1 })
      .limit(DM_PAGE_SIZE + 1)
      .toArray();
    const more = docs.length > DM_PAGE_SIZE;
    return { messages: docs.slice(0, DM_PAGE_SIZE).reverse().map(messageView), more };
  }

  /** marks everything the friend sent me as read; returns how many changed */
  async markRead(me: string, friendId: string): Promise<number> {
    const res = await this.cols.messages.updateMany(
      { pair: pairOf(me, friendId), to: new ObjectId(me), read: false },
      { $set: { read: true } },
    );
    return res.modifiedCount;
  }

  /** unread counts, only from people who are still friends */
  async unread(me: string): Promise<DmUnreadResponse> {
    const rows = await this.cols.messages
      .aggregate<{ _id: ObjectId; n: number }>([{ $match: { to: new ObjectId(me), read: false } }, { $group: { _id: '$from', n: { $sum: 1 } } }])
      .toArray();
    if (rows.length === 0) return { total: 0, byFriend: {} };
    const friends = new Set(await this.friends.friendIdsOf(me));
    const byFriend: Record<string, number> = {};
    let total = 0;
    for (const r of rows) {
      const id = r._id.toHexString();
      if (!friends.has(id)) continue;
      byFriend[id] = r.n;
      total += r.n;
    }
    return { total, byFriend };
  }

  private async requireFriend(me: string, friendId: string): Promise<void> {
    if (me === friendId) throw new ApiError(400, "That's you!");
    if (!(await this.friends.areFriends(me, friendId))) throw new ApiError(403, 'You can only message friends');
  }

  /** keeps the newest DM_KEEP of a pair */
  private async prune(pair: string): Promise<void> {
    const old = await this.cols.messages.find({ pair }, { projection: { _id: 1 } }).sort({ at: -1, _id: -1 }).skip(DM_KEEP).limit(100).toArray();
    if (old.length > 0) await this.cols.messages.deleteMany({ _id: { $in: old.map((m) => m._id) } });
  }
}
