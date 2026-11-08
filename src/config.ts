import type { DbNames } from './db/documents.js';

export const PORT = Number(process.env.PORT) || 3001;

const intEnv = (name: string, fallback: number): number => {
  const n = Number(process.env[name]);
  return process.env[name] !== undefined && Number.isInteger(n) && n >= 0 ? n : fallback;
};

/** MongoDB connection string; when empty the server runs in guest-only mode */
export const MONGODB_URI = process.env.MONGODB_URI?.trim() ?? '';

export const DB_NAMES: DbNames = {
  db: process.env.MONGODB_DB?.trim() || 'bluff',
  users: process.env.USERS_COLLECTION?.trim() || 'users',
  sessions: process.env.SESSIONS_COLLECTION?.trim() || 'sessions',
  games: process.env.GAMES_COLLECTION?.trim() || 'games',
  audit: process.env.AUDIT_COLLECTION?.trim() || 'audit_log',
};

/** coins every new account starts with */
export const DEFAULT_COINS = intEnv('DEFAULT_COINS', 1000);

/** how long a login token stays valid */
export const SESSION_TTL_DAYS = intEnv('SESSION_TTL_DAYS', 30) || 30;

/** secret for making the first admin (header X-Admin-Key); empty disables that route */
export const ADMIN_API_KEY = process.env.ADMIN_API_KEY?.trim() ?? '';

/** comma-separated frontend URLs, e.g. https://my-bluff.vercel.app */
export const CLIENT_ORIGINS = (process.env.CLIENT_ORIGIN ?? '')
  .split(',')
  .map((o) => o.trim().replace(/\/$/, ''))
  .filter(Boolean);

const LOCAL_ORIGIN =
  /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)(:\d+)?$/;

/** Without CLIENT_ORIGIN only localhost and home-network origins may connect */
export function isAllowedOrigin(origin: string | undefined): boolean {
  // non-browser clients send no Origin header; browser rules don't apply to them
  if (!origin) return true;
  return CLIENT_ORIGINS.length > 0 ? CLIENT_ORIGINS.includes(origin) : LOCAL_ORIGIN.test(origin);
}
