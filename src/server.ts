import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { isAllowedOrigin } from './config.js';
import { createApi } from './http/app.js';
import { RoomManager } from './rooms.js';
import type { Store } from './services/store.js';
import { registerHandlers } from './socket.js';

export interface ServerDeps {
  /** MongoDB-backed accounts and game history; omit for guest-only */
  store?: Store | null;
  adminApiKey?: string;
  authAttempts?: number;
}

export function createBluffServer(deps: ServerDeps = {}) {
  const store = deps.store ?? null;
  const app = createApi(store, { adminApiKey: deps.adminApiKey ?? '', authAttempts: deps.authAttempts });
  const httpServer = createServer(app);

  const io = new Server(httpServer, {
    cors: { origin: (origin, cb) => cb(null, isAllowedOrigin(origin)) },
    // CORS does not cover WebSocket upgrades, so check the origin here too
    allowRequest: (req, cb) => cb(null, isAllowedOrigin(req.headers.origin)),
    maxHttpBufferSize: 16 * 1024,
  });

  const rooms = new RoomManager();
  const stopSweep = registerHandlers(
    io,
    rooms,
    store
      ? {
          resolveUser: async (token) => {
            const user = await store.users.userForToken(token);
            return user ? { id: user._id.toHexString(), displayName: user.displayName } : null;
          },
          // saving runs in the background; a DB hiccup must never break the game
          onGameEnd: (record) => {
            store.games.save(record).catch((err: Error) => console.error('[games] could not save game:', err.message));
          },
        }
      : {},
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
