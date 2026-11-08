import type { DbNames } from '../db/documents.js';
import { connectMongo } from '../db/mongo.js';
import { FriendService } from './friends.js';
import { GameRecorder } from './games.js';
import { UserService, type UserServiceOptions } from './users.js';

/** everything backed by MongoDB; null when the server runs guest-only */
export interface Store {
  users: UserService;
  games: GameRecorder;
  friends: FriendService;
  close: () => Promise<void>;
}

export async function createStore(uri: string, names: DbNames, opts: UserServiceOptions): Promise<Store> {
  const { client, cols } = await connectMongo(uri, names);
  return {
    users: new UserService(cols, opts),
    games: new GameRecorder(cols),
    friends: new FriendService(cols),
    close: () => client.close(),
  };
}
