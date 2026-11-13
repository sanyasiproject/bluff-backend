import { ObjectId } from 'mongodb';
import webpush from 'web-push';
import type { Collections } from '../db/documents.js';
import type { InviteEvent } from '../types.js';

/** an invite is useless after a while; the push service drops it if the phone stays offline longer */
const INVITE_TTL_SEC = 10 * 60;

/** the browser push service's address and keys for one phone */
export interface PushTarget {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** sends one encrypted message; tests pass a fake */
export type PushSend = (target: PushTarget, payload: string, options: { TTL: number }) => Promise<unknown>;

export interface PushOptions {
  publicKey: string;
  privateKey: string;
  /** mailto:… or an https URL the push services can reach the owner at */
  subject: string;
  send?: PushSend;
}

/** what the notification shows; the app's service worker reads it */
export interface InvitePush {
  kind: 'invite';
  title: string;
  body: string;
  /** opened on tap */
  url: string;
  /** a newer invite from the same friend replaces the older one */
  tag: string;
}

/** friend-invite notifications: phones per account, and sending to them */
export class PushService {
  /** null when push isn't set up on this server */
  readonly publicKey: string | null = null;
  private readonly send: PushSend | null = null;

  constructor(
    private readonly cols: Collections,
    opts: PushOptions | null,
  ) {
    if (!opts?.publicKey || !opts.privateKey || !opts.subject) return;
    try {
      if (!opts.send) webpush.setVapidDetails(opts.subject, opts.publicKey, opts.privateKey);
      this.send = opts.send ?? ((target, payload, options) => webpush.sendNotification(target, payload, options));
      this.publicKey = opts.publicKey;
    } catch (err) {
      // a bad key or subject turns push off instead of stopping the server
      console.error('[push] keys not usable, notifications are off:', (err as Error).message);
    }
  }

  /** the server has push keys (an admin can still switch invites off) */
  get ready(): boolean {
    return this.send !== null;
  }

  /** this phone gets the account's invites; the same phone moves to whoever subscribes last */
  async subscribe(userId: ObjectId, sub: { endpoint: string; p256dh: string; auth: string }): Promise<void> {
    const now = new Date();
    await this.cols.push.updateOne(
      { endpoint: sub.endpoint },
      { $set: { userId, p256dh: sub.p256dh, auth: sub.auth, updatedAt: now }, $setOnInsert: { _id: new ObjectId(), createdAt: now } },
      { upsert: true },
    );
  }

  async unsubscribe(userId: ObjectId, endpoint: string): Promise<void> {
    await this.cols.push.deleteOne({ endpoint, userId });
  }

  /** sends the invite to every phone of that account; returns how many took it. Phones the service says are gone are forgotten */
  async sendInvite(toUserId: string, invite: InviteEvent): Promise<number> {
    if (!this.send || !/^[a-f0-9]{24}$/i.test(toUserId)) return 0;
    const userId = new ObjectId(toUserId);
    // blocked accounts get nothing
    if ((await this.cols.users.countDocuments({ _id: userId, blocked: { $ne: true } }, { limit: 1 })) === 0) return 0;
    const phones = await this.cols.push.find({ userId }).toArray();
    const payload: InvitePush = {
      kind: 'invite',
      title: `${invite.fromName} invited you to Bluff`,
      body: `Tap to join room ${invite.code}`,
      url: `/?room=${invite.code}`,
      tag: `invite-${invite.fromId}`,
    };
    const text = JSON.stringify(payload);
    const results = await Promise.all(
      phones.map(async (p) => {
        try {
          await this.send!({ endpoint: p.endpoint, keys: { p256dh: p.p256dh, auth: p.auth } }, text, { TTL: INVITE_TTL_SEC });
          await this.cols.push.updateOne({ _id: p._id }, { $set: { lastSentAt: new Date() } });
          return 1;
        } catch (err) {
          const status = (err as { statusCode?: number }).statusCode;
          // the phone unsubscribed or the browser data was cleared
          if (status === 404 || status === 410) await this.cols.push.deleteOne({ _id: p._id });
          else console.error('[push] could not send:', status ?? (err as Error).message);
          return 0;
        }
      }),
    );
    return results.reduce<number>((a, b) => a + b, 0);
  }
}
