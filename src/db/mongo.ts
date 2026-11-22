import { MongoClient } from 'mongodb';
import type { AuditDoc, Collections, DbNames, FriendDoc, GameDoc, MessageDoc, PushSubscriptionDoc, RivalTallyDoc, SeasonDoc, SessionDoc, SettingsDoc, UserDoc } from './documents.js';

export interface MongoConnection {
  client: MongoClient;
  cols: Collections;
}

export async function connectMongo(uri: string, names: DbNames): Promise<MongoConnection> {
  const client = new MongoClient(uri, { maxPoolSize: 10, serverSelectionTimeoutMS: 10_000, appName: 'bluff-backend' });
  await client.connect();
  const db = client.db(names.db);
  const cols: Collections = {
    users: db.collection<UserDoc>(names.users),
    sessions: db.collection<SessionDoc>(names.sessions),
    games: db.collection<GameDoc>(names.games),
    audit: db.collection<AuditDoc>(names.audit),
    friends: db.collection<FriendDoc>(names.friends),
    settings: db.collection<SettingsDoc>(names.settings),
    push: db.collection<PushSubscriptionDoc>(names.push ?? 'push_subscriptions'),
    seasons: db.collection<SeasonDoc>(names.seasons ?? 'ranked_seasons'),
    messages: db.collection<MessageDoc>(names.messages ?? 'messages'),
    rivals: db.collection<RivalTallyDoc>(names.rivals ?? 'rival_tallies'),
  };
  await Promise.all([
    cols.users.createIndex({ username: 1 }, { unique: true }),
    // coin rank on the profile counts richer players along this index instead of reading every account
    cols.users.createIndex({ coins: -1 }),
    // the admin list, newest first
    cols.users.createIndex({ createdAt: -1 }),
    // player search: the display name and each of its words, lower case, matched from the start
    cols.users.createIndex({ nameWords: 1 }),
    cols.sessions.createIndex({ tokenHash: 1 }, { unique: true }),
    // MongoDB deletes expired sessions by itself
    cols.sessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    cols.games.createIndex({ 'players.userId': 1, endedAt: -1 }),
    // old replays to clear, oldest first (only games still holding one)
    cols.games.createIndex({ endedAt: 1 }, { partialFilterExpression: { replay: { $exists: true } } }),
    cols.audit.createIndex({ targetUserId: 1, createdAt: -1 }),
    cols.friends.createIndex({ pair: 1 }, { unique: true }),
    cols.friends.createIndex({ requester: 1 }),
    cols.friends.createIndex({ recipient: 1 }),
    cols.push.createIndex({ endpoint: 1 }, { unique: true }),
    cols.push.createIndex({ userId: 1 }),
    // a pair's thread by time, and unread counts
    cols.messages.createIndex({ pair: 1, at: -1 }),
    cols.messages.createIndex({ to: 1, read: 1 }),
  ]);
  return { client, cols };
}
