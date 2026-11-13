import type { DbNames } from '../db/documents.js';
import { connectMongo } from '../db/mongo.js';
import { FriendService } from './friends.js';
import { GameRecorder } from './games.js';
import { PushService, type PushOptions } from './push.js';
import { SettingsService } from './settings.js';
import { UserService, type UserServiceOptions } from './users.js';

/** everything backed by MongoDB; null when the server runs guest-only */
export interface Store {
  users: UserService;
  games: GameRecorder;
  friends: FriendService;
  settings: SettingsService;
  push: PushService;
  close: () => Promise<void>;
}

/** push: keys for friend-invite notifications; leave out to run without them */
export async function createStore(uri: string, names: DbNames, opts: UserServiceOptions & { push?: PushOptions | null }): Promise<Store> {
  const { client, cols } = await connectMongo(uri, names);
  const settings = new SettingsService(cols);
  await settings.load();
  return {
    users: new UserService(cols, opts),
    games: new GameRecorder(cols),
    friends: new FriendService(cols),
    settings,
    push: new PushService(cols, opts.push ?? null),
    close: () => client.close(),
  };
}
