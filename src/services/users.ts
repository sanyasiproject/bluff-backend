import { MongoServerError, ObjectId, type Filter, type WithId } from 'mongodb';
import { hashPassword, verifyPassword } from '../auth/passwords.js';
import { hashToken, newToken } from '../auth/tokens.js';
import { istDay } from '../days.js';
import type { Actor, AuditDoc, Collections, UserDoc } from '../db/documents.js';
import { ApiError } from '../http/errors.js';
import type { AccountInfo } from '../models.js';
import {
  DAILY_GIFT_LIMIT,
  HISTORY_PAGE_SIZE,
  levelOf,
  LOGIN_BONUS,
  parseAvatar,
  type AdminUser,
  type AuditEntry,
  type AuthResponse,
  type GameKind,
  type LifetimeStats,
  type ProfileOverview,
  type PublicUser,
  type Role,
} from '../types.js';

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
  plays: 0,
  chances: 0,
  crazy7Games: 0,
};

/** lifetime stats, with zeros for any an older account is missing */
export const statsOf = (u: Pick<UserDoc, 'stats'>): LifetimeStats => ({ ...EMPTY_STATS, ...u.stats });

/** the saved avatar if it's still in the catalog, else null (the first letter) */
export const avatarOf = (u: Pick<UserDoc, 'avatar'>): string | null => (parseAvatar(u.avatar) ? u.avatar! : null);

/** coins an account can still give friends today */
export const giftLeftOf = (u: Pick<UserDoc, 'giftDay' | 'giftGiven'>, today = istDay()): number =>
  u.giftDay === today ? Math.max(0, DAILY_GIFT_LIMIT - (u.giftGiven ?? 0)) : DAILY_GIFT_LIMIT;

export function toPublicUser(u: WithId<UserDoc>): PublicUser {
  return {
    id: u._id.toHexString(),
    username: u.username,
    displayName: u.displayName,
    role: u.role,
    coins: u.coins,
    stats: statsOf(u),
    createdAt: u.createdAt.toISOString(),
    giftLeft: giftLeftOf(u),
    tutorials: u.tutorials ?? [],
    avatar: avatarOf(u),
  };
}

export function toAdminUser(u: WithId<UserDoc>): AdminUser {
  return { ...toPublicUser(u), lastLoginAt: u.lastLoginAt?.toISOString() ?? null, blocked: u.blocked ?? false };
}

/** fields an admin can change on an account */
export interface UserChanges {
  displayName?: string;
  role?: Role;
  blocked?: boolean;
}

const roleName = (r: Role) => (r === 'admin' ? 'admin' : 'player');

export const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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
    if (user.blocked) throw new ApiError(403, 'This account is blocked. Ask an admin');
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

  async getAccounts(userIds: string[]): Promise<Map<string, AccountInfo>> {
    const ids = userIds.filter((id) => /^[a-f0-9]{24}$/i.test(id)).map((id) => new ObjectId(id));
    const users = await this.cols.users.find({ _id: { $in: ids } }, { projection: { coins: 1, stats: 1, avatar: 1 } }).toArray();
    return new Map(users.map((u) => [u._id.toHexString(), { coins: u.coins, level: levelOf(statsOf(u)), stats: statsOf(u), avatar: avatarOf(u) }]));
  }

  async logout(token: string): Promise<void> {
    await this.cols.sessions.deleteOne({ tokenHash: hashToken(token) });
  }

  async userForToken(token: string): Promise<WithId<UserDoc> | null> {
    const session = await this.cols.sessions.findOne({ tokenHash: hashToken(token), expiresAt: { $gt: new Date() } });
    return session ? this.cols.users.findOne({ _id: session.userId, blocked: { $ne: true } }) : null;
  }

  async list(q: { search: string; limit: number; skip: number }): Promise<{ users: AdminUser[]; total: number }> {
    const re = { $regex: escapeRegex(q.search), $options: 'i' };
    const filter: Filter<UserDoc> = q.search ? { $or: [{ username: re }, { displayName: re }] } : {};
    const [users, total] = await Promise.all([
      this.cols.users.find(filter).sort({ createdAt: -1 }).skip(q.skip).limit(q.limit).toArray(),
      this.cols.users.countDocuments(filter),
    ]);
    return { users: users.map(toAdminUser), total };
  }

  /** coin rank and today's rewards, for the player's own profile page */
  async overview(user: WithId<UserDoc>): Promise<Omit<ProfileOverview, 'friends'>> {
    const today = istDay();
    const [richer, players] = await Promise.all([
      this.cols.users.countDocuments({ coins: { $gt: user.coins } }),
      this.cols.users.estimatedDocumentCount(),
    ]);
    return {
      coinRank: richer + 1,
      players,
      loginBonusToday: user.lastLoginBonusDay === today,
      gamesToday: user.gamesTodayDay === today ? (user.gamesToday ?? 0) : 0,
    };
  }

  /** an account as admins see it, with its admin history and logged-in devices */
  async adminView(
    userId: string,
  ): Promise<{ user: AdminUser; history: AuditEntry[]; historyTotal: number; activeSessions: number }> {
    const _id = objectId(userId);
    const [user, page, activeSessions] = await Promise.all([
      this.cols.users.findOne({ _id }),
      this.history(userId, 1),
      this.cols.sessions.countDocuments({ userId: _id, expiresAt: { $gt: new Date() } }),
    ]);
    if (!user) throw new ApiError(404, 'User not found');
    return { user: toAdminUser(user), history: page.history, historyTotal: page.total, activeSessions };
  }

  /** one page of admin changes to an account, newest first; page 1 is the newest */
  async history(userId: string, page: number): Promise<{ history: AuditEntry[]; total: number }> {
    const _id = objectId(userId);
    const [audit, total] = await Promise.all([
      this.cols.audit
        .find({ targetUserId: _id })
        .sort({ createdAt: -1, _id: -1 })
        .skip((page - 1) * HISTORY_PAGE_SIZE)
        .limit(HISTORY_PAGE_SIZE)
        .toArray(),
      this.cols.audit.countDocuments({ targetUserId: _id }),
    ]);
    const adminIds = [...new Set(audit.flatMap((a) => (a.byUserId ? [a.byUserId.toHexString()] : [])))].map((id) => new ObjectId(id));
    const admins = await this.cols.users.find({ _id: { $in: adminIds } }, { projection: { displayName: 1 } }).toArray();
    const nameOf = new Map(admins.map((a) => [a._id.toHexString(), a.displayName]));
    const history = audit.map((a: AuditDoc) => ({
      id: a._id.toHexString(),
      action: a.action,
      by: a.byUserId ? (nameOf.get(a.byUserId.toHexString()) ?? 'Deleted admin') : null,
      amount: a.amount,
      balanceAfter: a.balanceAfter,
      reason: a.reason,
      detail: a.detail,
      createdAt: a.createdAt.toISOString(),
    }));
    return { history, total };
  }

  /** rename, change role, block or unblock; blocking logs the user out everywhere */
  async update(userId: string, changes: UserChanges, by: Actor): Promise<AdminUser> {
    const _id = objectId(userId);
    const self = by.userId?.equals(_id) ?? false;
    if (self && (changes.role !== undefined || changes.blocked !== undefined)) {
      throw new ApiError(400, "You can't change your own role or block yourself");
    }
    const user = await this.cols.users.findOne({ _id });
    if (!user) throw new ApiError(404, 'User not found');

    const set: Partial<UserDoc> = {};
    const notes: string[] = [];
    if (changes.displayName !== undefined && changes.displayName !== user.displayName) {
      set.displayName = changes.displayName;
      notes.push(`Name: ${user.displayName} → ${changes.displayName}`);
    }
    if (changes.role !== undefined && changes.role !== user.role) {
      set.role = changes.role;
      notes.push(`Role: ${roleName(user.role)} → ${roleName(changes.role)}`);
    }
    if (changes.blocked !== undefined && changes.blocked !== (user.blocked ?? false)) {
      set.blocked = changes.blocked;
      notes.push(changes.blocked ? 'Blocked' : 'Unblocked');
    }
    if (notes.length === 0) return toAdminUser(user);

    const updated = await this.cols.users.findOneAndUpdate({ _id }, { $set: set }, { returnDocument: 'after' });
    if (!updated) throw new ApiError(404, 'User not found');
    if (set.blocked) await this.cols.sessions.deleteMany({ userId: _id });
    await this.audit(_id, 'update', by, { detail: notes.join(' · ') });
    return toAdminUser(updated);
  }

  /** for players who forgot theirs; every device is logged out */
  async setPassword(userId: string, password: string, by: Actor): Promise<void> {
    const _id = objectId(userId);
    const res = await this.cols.users.updateOne({ _id }, { $set: { passwordHash: await hashPassword(password) } });
    if (res.matchedCount === 0) throw new ApiError(404, 'User not found');
    await this.cols.sessions.deleteMany({ userId: _id });
    await this.audit(_id, 'password', by, { detail: 'Password reset, logged out everywhere' });
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

  /** gives a friend coins; one atomic update checks the sender's balance and daily gift limit */
  async giftCoins(fromId: string, toId: string, amount: number): Promise<{ from: WithId<UserDoc>; to: WithId<UserDoc> }> {
    const fromOid = objectId(fromId);
    const toOid = objectId(toId);
    if (fromOid.equals(toOid)) throw new ApiError(400, "You can't send coins to yourself");
    const today = istDay();
    const from = await this.cols.users.findOneAndUpdate(
      { _id: fromOid, coins: { $gte: amount }, $or: [{ giftDay: { $ne: today } }, { giftGiven: { $lte: DAILY_GIFT_LIMIT - amount } }] },
      [
        {
          $set: {
            coins: { $subtract: ['$coins', amount] },
            giftGiven: { $cond: [{ $eq: ['$giftDay', today] }, { $add: [{ $ifNull: ['$giftGiven', 0] }, amount] }, amount] },
            giftDay: today,
          },
        },
      ],
      { returnDocument: 'after' },
    );
    if (!from) {
      const me = await this.cols.users.findOne({ _id: fromOid }, { projection: { coins: 1, giftDay: 1, giftGiven: 1 } });
      if (!me) throw new ApiError(404, 'User not found');
      if (me.coins < amount) throw new ApiError(400, "You don't have that many coins");
      throw new ApiError(400, `You can give ${DAILY_GIFT_LIMIT} coins a day. ${giftLeftOf(me, today)} left today`);
    }
    const to = await this.cols.users.findOneAndUpdate({ _id: toOid, blocked: { $ne: true } }, { $inc: { coins: amount } }, { returnDocument: 'after' });
    if (!to) {
      // the friend can't get coins (account gone or blocked): give them back
      await this.cols.users.updateOne({ _id: fromOid }, { $inc: { coins: amount, giftGiven: -amount } });
      throw new ApiError(404, "Your friend can't get coins right now");
    }
    const at = new Date();
    await this.cols.audit.insertMany([
      { _id: new ObjectId(), action: 'gift', targetUserId: fromOid, byUserId: fromOid, via: 'player', amount: -amount, balanceAfter: from.coins, detail: `Gift to ${to.displayName}`, createdAt: at },
      { _id: new ObjectId(), action: 'gift', targetUserId: toOid, byUserId: fromOid, via: 'player', amount, balanceAfter: to.coins, detail: `Gift from ${from.displayName}`, createdAt: at },
    ]);
    return { from, to };
  }

  /** picks an avatar (or null for the first letter); faces and backgrounds above the account's level are refused */
  async setAvatar(userId: ObjectId, avatar: string | null): Promise<PublicUser> {
    if (avatar === null) {
      const cleared = await this.cols.users.findOneAndUpdate({ _id: userId }, { $unset: { avatar: '' } }, { returnDocument: 'after' });
      if (!cleared) throw new ApiError(404, 'User not found');
      return toPublicUser(cleared);
    }
    const parts = parseAvatar(avatar);
    if (!parts) throw new ApiError(400, 'Pick one of the avatars');
    const user = await this.cols.users.findOne({ _id: userId });
    if (!user) throw new ApiError(404, 'User not found');
    const need = Math.max(parts.face.level, parts.bg.level);
    if (levelOf(statsOf(user)) < need) throw new ApiError(400, `Reach level ${need} for that avatar`);
    const updated = await this.cols.users.findOneAndUpdate({ _id: userId }, { $set: { avatar } }, { returnDocument: 'after' });
    return toPublicUser(updated!);
  }

  /** the practice tutorial for a game is done (finished or skipped); shown once per account */
  async markTutorial(userId: ObjectId, game: GameKind): Promise<PublicUser> {
    const user = await this.cols.users.findOneAndUpdate({ _id: userId }, { $addToSet: { tutorials: game } }, { returnDocument: 'after' });
    if (!user) throw new ApiError(404, 'User not found');
    return toPublicUser(user);
  }

  /** an app-wide setting change goes in the admin's own history */
  async logSetting(by: Actor, detail: string): Promise<void> {
    if (by.userId) await this.audit(by.userId, 'settings', by, { detail });
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

  private async audit(targetUserId: ObjectId, action: AuditDoc['action'], by: Actor, extra: Partial<AuditDoc> = {}) {
    await this.cols.audit.insertOne({
      _id: new ObjectId(),
      action,
      targetUserId,
      byUserId: by.userId,
      via: by.via,
      ...extra,
      createdAt: new Date(),
    });
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
