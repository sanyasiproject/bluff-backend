import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { isAllowedOrigin } from './config.js';
import { GameError } from './game.js';
import { createApi } from './http/app.js';
import { ApiError } from './http/errors.js';
import { Presence } from './presence.js';
import { DEFAULT_ROOM_LIMITS, RoomManager, type RoomLimits } from './rooms.js';
import type { Store } from './services/store.js';
import type { AppSettings } from './types.js';
import { giftLeftOf } from './services/users.js';
import { MAX_CONNECTIONS_PER_IP, registerHandlers } from './socket.js';

export interface ServerDeps {
  /** MongoDB-backed accounts, coins, friends and game history; omit for guest-only */
  store?: Store | null;
  adminApiKey?: string;
  authAttempts?: number;
  /** abuse limits per network; defaults suit production */
  limits?: Partial<RoomLimits & { connectionsPerIp: number }>;
}

export function createBluffServer(deps: ServerDeps = {}) {
  const store = deps.store ?? null;
  const presence = new Presence();
  // set once Socket.IO exists; the API is created first because the http server needs it
  let notifyFriends = (_userId: string) => {};
  let settingsChanged = (_settings: AppSettings) => {};
  const app = createApi(store, {
    adminApiKey: deps.adminApiKey ?? '',
    authAttempts: deps.authAttempts,
    presence,
    notifyFriends: (userId) => notifyFriends(userId),
    roomOfUser: (userId) => rooms.roomOfUser(userId)?.code ?? null,
    onSettingsChanged: (settings) => settingsChanged(settings),
  });
  const httpServer = createServer(app);

  const io = new Server(httpServer, {
    cors: { origin: (origin, cb) => cb(null, isAllowedOrigin(origin)) },
    // CORS does not cover WebSocket upgrades, so check the origin here too
    allowRequest: (req, cb) => cb(null, isAllowedOrigin(req.headers.origin)),
    maxHttpBufferSize: 16 * 1024,
  });

  notifyFriends = (userId) => {
    for (const id of presence.socketsOf(userId)) io.to(id).emit('friends:changed');
  };
  // every open app hears about it, so home screens show or hide guest play right away
  settingsChanged = (settings) => {
    io.emit('settings:changed', { guestsAllowed: settings.guestsAllowed });
  };

  const rooms = new RoomManager({ ...DEFAULT_ROOM_LIMITS, ...deps.limits });
  const stopSweep = registerHandlers(
    io,
    rooms,
    store
      ? {
          resolveUser: async (token) => {
            const user = await store.users.userForToken(token);
            return user ? { id: user._id.toHexString(), username: user.username, displayName: user.displayName } : null;
          },
          getAccounts: (userIds) => store.users.getAccounts(userIds),
          // the socket layer runs this in the background; a DB hiccup must never break the game
          onGameEnd: (record) => store.games.save(record),
          areFriends: (a, b) => store.friends.areFriends(a, b),
          guestsAllowed: () => store.settings.guestsAllowed,
          giftCoins: async (fromId, toId, amount) => {
            try {
              const { from, to } = await store.users.giftCoins(fromId, toId, amount);
              return { fromCoins: from.coins, giftLeft: giftLeftOf(from), toCoins: to.coins };
            } catch (err) {
              throw err instanceof ApiError ? new GameError(err.message) : err;
            }
          },
        }
      : {},
    presence,
    deps.limits?.connectionsPerIp ?? MAX_CONNECTIONS_PER_IP,
  );

  return {
    httpServer,
    io,
    rooms,
    app,
    close: () => {
      stopSweep();
      io.close();
    },
  };
}
