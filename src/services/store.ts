import type { DbNames } from '../db/documents.js';
import { connectMongo } from '../db/mongo.js';
import { FriendService } from './friends.js';
import { GameRecorder } from './games.js';
import { LeagueService } from './league.js';
import { MissionService } from './missions.js';
import { RankedService } from './ranked.js';
import { RivalService } from './rivals.js';
import { PushService, type PushOptions } from './push.js';
import { SettingsService } from './settings.js';
import { UserService, type UserServiceOptions } from './users.js';

/** everything backed by MongoDB; null when the server runs guest-only */
export interface Store {
  users: UserService;
  games: GameRecorder;
  missions: MissionService;
  league: LeagueService;
  rivals: RivalService;
  ranked: RankedService;
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
  // saving a game counts it for each player's missions, weekly league and rank
  const missions = new MissionService(cols);
  const league = new LeagueService(cols);
  const ranked = new RankedService(cols, settings);
  return {
    users: new UserService(cols, opts),
    games: new GameRecorder(cols, missions, league, ranked),
    missions,
    league,
    rivals: new RivalService(cols),
    ranked,
    friends: new FriendService(cols),
    settings,
    push: new PushService(cols, opts.push ?? null),
    close: () => client.close(),
  };
}
