import { MongoServerError, ObjectId, type Filter, type WithId } from 'mongodb';
import { hashPassword, verifyPassword } from '../auth/passwords.js';
import { hashToken, newToken } from '../auth/tokens.js';
import { istDay } from '../days.js';
import type { Actor, Collections, UserDoc } from '../db/documents.js';
import { ApiError } from '../http/errors.js';
import { LOGIN_BONUS, type AuthResponse, type LifetimeStats, type PublicUser } from '../types.js';

export interface UserServiceOptions {
  defaultCoins: number;
  sessionTtlDays: number;
}

const EMPTY_STATS: LifetimeStats = {
  gamesPlayed: 0,
  wins: 0,
  losses: 0,
  bluffs: 0,
  bluffsCaught: 0,
  goodCalls: 0,
  wrongCalls: 0,
  cardsPickedUp: 0,
};

export function toPublicUser(u: WithId<UserDoc>): PublicUser {
  return {
    id: u._id.toHexString(),
    username: u.username,
    displayName: u.displayName,
    role: u.role,
    coins: u.coins,
    stats: { ...EMPTY_STATS, ...u.stats },
    createdAt: u.createdAt.toISOString(),
  };
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function objectId(id: string): ObjectId {
  if (!/^[a-f0-9]{24}$/i.test(id)) throw new ApiError(404, 'User not found');
  return new ObjectId(id);
}

/** accounts, login sessions, coins and admin role */
export class UserService {
  // hashed once so a login for an unknown username takes as long as a wrong password
  private dummyHash = hashPassword('not-a-real-password');

  constructor(
    private readonly cols: Collections,
    private readonly opts: UserServiceOptions,
  ) {}

  async register(username: string, password: string, displayName: string): Promise<AuthResponse> {
    // sign-up counts as the first login of the day
    const doc: Omit<UserDoc, '_id'> = {
      username,
      displayName,
      passwordHash: await hashPassword(password),
      role: 'user',
      coins: this.opts.defaultCoins + LOGIN_BONUS,
      stats: { ...EMPTY_STATS },
      createdAt: new Date(),
      lastLoginAt: new Date(),
      lastLoginBonusDay: istDay(),
    };
    let insertedId: ObjectId;
    try {
      ({ insertedId } = await this.cols.users.insertOne(doc as UserDoc));
    } catch (err) {
      if (err instanceof MongoServerError && err.code === 11000) throw new ApiError(409, 'That username is taken');
      throw err;
    }
    return {
      token: await this.createSession(insertedId),
      user: toPublicUser({ ...doc, _id: insertedId }),
      bonus: LOGIN_BONUS,
    };
  }

  async login(username: string, password: string): Promise<AuthResponse> {
    const user = await this.cols.users.findOne({ username });
    const ok = await verifyPassword(password, user?.passwordHash ?? (await this.dummyHash));
    // one message for both cases, so nobody can probe which usernames exist
    if (!user || !ok) throw new ApiError(401, 'Wrong username or password');
    await this.cols.users.updateOne({ _id: user._id }, { $set: { lastLoginAt: new Date() } });
    const daily = await this.claimLoginBonus(user);
    return { token: await this.createSession(user._id), user: toPublicUser(daily.user), bonus: daily.bonus };
  }

  /** +LOGIN_BONUS once per IST day; the date check is in the update itself, so it can't pay twice */
  async claimLoginBonus(user: WithId<UserDoc>): Promise<{ user: WithId<UserDoc>; bonus: number }> {
    const today = istDay();
    if (user.lastLoginBonusDay === today) return { user, bonus: 0 };
    const updated = await this.cols.users.findOneAndUpdate(
      { _id: user._id, lastLoginBonusDay: { $ne: today } },
      { $inc: { coins: LOGIN_BONUS }, $set: { lastLoginBonusDay: today } },
      { returnDocument: 'after' },
    );
    return updated ? { user: updated, bonus: LOGIN_BONUS } : { user, bonus: 0 };
  }

  async getCoins(userIds: string[]): Promise<Map<string, number>> {
    const ids = userIds.filter((id) => /^[a-f0-9]{24}$/i.test(id)).map((id) => new ObjectId(id));
    const users = await this.cols.users.find({ _id: { $in: ids } }, { projection: { coins: 1 } }).toArray();
    return new Map(users.map((u) => [u._id.toHexString(), u.coins]));
  }

  async logout(token: string): Promise<void> {
    await this.cols.sessions.deleteOne({ tokenHash: hashToken(token) });
  }

  async userForToken(token: string): Promise<WithId<UserDoc> | null> {
    const session = await this.cols.sessions.findOne({ tokenHash: hashToken(token), expiresAt: { $gt: new Date() } });
    return session ? this.cols.users.findOne({ _id: session.userId }) : null;
  }

  async list(q: { search: string; limit: number; skip: number }): Promise<{ users: PublicUser[]; total: number }> {
    const re = { $regex: escapeRegex(q.search), $options: 'i' };
    const filter: Filter<UserDoc> = q.search ? { $or: [{ username: re }, { displayName: re }] } : {};
    const [users, total] = await Promise.all([
      this.cols.users.find(filter).sort({ createdAt: -1 }).skip(q.skip).limit(q.limit).toArray(),
      this.cols.users.countDocuments(filter),
    ]);
    return { users: users.map(toPublicUser), total };
  }

  /** positive gives coins, negative takes them; never below zero; every change is audited */
  async adjustCoins(userId: string, amount: number, reason: string, by: Actor): Promise<PublicUser> {
    const _id = objectId(userId);
    const filter: Filter<UserDoc> = amount < 0 ? { _id, coins: { $gte: -amount } } : { _id };
    const user = await this.cols.users.findOneAndUpdate(filter, { $inc: { coins: amount } }, { returnDocument: 'after' });
    if (!user) {
      const exists = await this.cols.users.countDocuments({ _id }, { limit: 1 });
      throw exists ? new ApiError(400, 'User does not have that many coins') : new ApiError(404, 'User not found');
    }
    await this.cols.audit.insertOne({
      _id: new ObjectId(),
      action: 'coins',
      targetUserId: _id,
      byUserId: by.userId,
      via: by.via,
      amount,
      balanceAfter: user.coins,
      reason: reason || undefined,
      createdAt: new Date(),
    });
    return toPublicUser(user);
  }

  async makeAdmin(username: string, by: Actor): Promise<PublicUser> {
    const user = await this.cols.users.findOneAndUpdate({ username }, { $set: { role: 'admin' } }, { returnDocument: 'after' });
    if (!user) throw new ApiError(404, 'User not found');
    await this.cols.audit.insertOne({
      _id: new ObjectId(),
      action: 'make_admin',
      targetUserId: user._id,
      byUserId: by.userId,
      via: by.via,
      createdAt: new Date(),
    });
    return toPublicUser(user);
  }

  private async createSession(userId: ObjectId): Promise<string> {
    const { token, hash } = newToken();
    const now = Date.now();
    await this.cols.sessions.insertOne({
      _id: new ObjectId(),
      userId,
      tokenHash: hash,
      createdAt: new Date(now),
      expiresAt: new Date(now + this.opts.sessionTtlDays * 86_400_000),
    });
    return token;
  }
}
