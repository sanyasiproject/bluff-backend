import { MongoClient } from 'mongodb';
import type { AuditDoc, Collections, DbNames, GameDoc, SessionDoc, UserDoc } from './documents.js';

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
  };
  await Promise.all([
    cols.users.createIndex({ username: 1 }, { unique: true }),
    cols.sessions.createIndex({ tokenHash: 1 }, { unique: true }),
    // MongoDB deletes expired sessions by itself
    cols.sessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    cols.games.createIndex({ 'players.userId': 1, endedAt: -1 }),
    cols.audit.createIndex({ targetUserId: 1, createdAt: -1 }),
  ]);
  return { client, cols };
}
