import express, { type ErrorRequestHandler, type RequestHandler } from 'express';
import { isAllowedOrigin } from '../config.js';
import { GameError } from '../game.js';
import type { Presence } from '../presence.js';
import type { Store } from '../services/store.js';
import type { AppSettings } from '../types.js';
import { ApiError } from './errors.js';
import { rateLimit, userRateLimit } from './middleware.js';
import { adminRoutes } from './routes/admin.js';
import { authRoutes } from './routes/auth.js';
import { friendRoutes, type NotifyFriends, type RoomOfUser } from './routes/friends.js';
import { meRoutes } from './routes/me.js';
import { playerRoutes } from './routes/players.js';
import { pushRoutes } from './routes/push.js';

export interface ApiOptions {
  adminApiKey: string;
  /** login, register and make-admin attempts per IP per 15 minutes */
  authAttempts?: number;
  /** who is online, for the friends list */
  presence: Presence;
  /** live update to a user's open apps when their friends or requests change */
  notifyFriends?: NotifyFriends;
  /** which room a user is in, so friends already playing aren't offered an invite */
  roomOfUser?: RoomOfUser;
  /** an admin changed an app-wide setting */
  onSettingsChanged?: (settings: AppSettings) => void;
}

/** HTTP side of the server: health check and the /api routes */
export function createApi(store: Store | null, opts: ApiOptions): express.Express {
  const app = express();
  app.disable('x-powered-by');
  // Render puts one proxy in front; this makes req.ip the player's address for rate limits
  app.set('trust proxy', 1);
  app.use(cors);
  app.use(express.json({ limit: '10kb' }));

  app.get('/health', (_req, res) => {
    // never served from a cache: the guest switch can change at any time
    res.set('Cache-Control', 'no-store');
    // guests can always play on a guest-only server
    res.json({ ok: true, accounts: store ? 'on' : 'off', guests: store ? store.settings.guestsAllowed : true });
  });
  app.get('/', (_req, res) => {
    res.type('text').send('Bluff game server is running');
  });

  if (store) {
    const limited = rateLimit(opts.authAttempts ?? 20, 15 * 60_000);
    app.use('/api/auth', authRoutes(store, limited));
    app.use('/api/me', meRoutes(store));
    // search, profiles and friend requests: 20 a minute per user, shared
    const social = userRateLimit(20, 60_000);
    app.use('/api/friends', friendRoutes(store, opts.presence, opts.notifyFriends ?? (() => {}), opts.roomOfUser ?? (() => null), social));
    app.use('/api/players', playerRoutes(store, opts.presence, social));
    app.use('/api/push', pushRoutes(store, social));
    app.use('/api/admin', adminRoutes(store, opts.adminApiKey, limited, opts.onSettingsChanged ?? (() => {})));
  } else {
    app.use('/api', (_req, _res, next) => next(new ApiError(503, 'Accounts are not set up on this server')));
  }

  app.use((_req, _res, next) => next(new ApiError(404, 'Not found')));
  app.use(errorHandler);
  return app;
}

// same allowed sites as the game socket; the API uses bearer tokens, not cookies
const cors: RequestHandler = (req, res, next) => {
  const origin = req.headers.origin;
  if (origin && isAllowedOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Max-Age', '600');
  }
  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  next();
};

const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof ApiError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  if (err instanceof GameError) {
    res.status(400).json({ error: err.message });
    return;
  }
  // express.json() rejects broken or oversized bodies with these
  const status = (err as { status?: number }).status;
  if (status === 400 || status === 413) {
    res.status(status).json({ error: 'Invalid request body' });
    return;
  }
  console.error('[api]', err);
  res.status(500).json({ error: 'Something went wrong' });
};
